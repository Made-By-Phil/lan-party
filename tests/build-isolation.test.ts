import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGames, discoverGames } from "../src/server/games.ts";
import { packageRoot } from "../src/server/paths.ts";

const root = packageRoot();
const shellDir = join(root, "shell");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLIENT = `import type { GameClientProps } from "lan-party/sdk";
export default function C({ game }: GameClientProps) { return <div>ok</div>; }`;

const SERVER = `import type { GameContext, GameServer } from "lan-party/sdk";
export default function create(ctx: GameContext): GameServer {
  return { onAction() {}, getPublicState() { return { ok: true }; } };
}`;

function makeGames(games: Record<string, { client?: string; server?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-build-"));
  dirs.push(dir);
  for (const [id, files] of Object.entries(games)) {
    const d = join(dir, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "game.json"),
      JSON.stringify({
        id,
        name: id,
        description: "",
        minPlayers: 1,
        maxPlayers: 4,
        teams: "none",
        tickRate: 0,
        displayMode: "device",
      }),
    );
    writeFileSync(join(d, "client.tsx"), files.client ?? CLIENT);
    writeFileSync(join(d, "server.ts"), files.server ?? SERVER);
  }
  return dir;
}

describe("buildGames isolation", () => {
  it("drops a game whose client will not compile and keeps the rest", async () => {
    const gamesDir = makeGames({
      alpha: {},
      broken: { client: `export default function C() { return <div>unclosed` },
      beta: {},
    });
    const buildDir = join(gamesDir, ".build");
    const report = await buildGames(discoverGames(gamesDir), shellDir, buildDir);

    expect(report.ok.map((d) => d.manifest.id).sort()).toEqual(["local/alpha", "local/beta"]);
    expect(report.failed.map((f) => f.id)).toEqual(["local/broken"]);
    expect(report.failed[0]!.reason).toMatch(/unclosed|Unexpected end/i);
    // A dropped game must not leave a loadable server behind.
    expect(report.builtServers.has("local/broken")).toBe(false);
    expect(report.builtServers.has("local/alpha")).toBe(true);
  });

  it("drops a game whose server will not compile", async () => {
    const gamesDir = makeGames({
      alpha: {},
      badserver: { server: `export default function create(ctx {{{ SYNTAX` },
    });
    const report = await buildGames(
      discoverGames(gamesDir),
      shellDir,
      join(gamesDir, ".build"),
    );
    expect(report.ok.map((d) => d.manifest.id)).toEqual(["local/alpha"]);
    expect(report.failed.map((f) => f.id)).toEqual(["local/badserver"]);
  });

  it("keeps games that import CSS — probing must not reject them", async () => {
    // Regression: the per-game probe originally failed on any CSS import,
    // which would have excluded every real game the moment anything broke.
    const gamesDir = makeGames({
      styled: { client: `import "./styles.css";\n${CLIENT}` },
      broken: { client: `export default function C() { return <div>unclosed` },
    });
    writeFileSync(join(gamesDir, "styled", "styles.css"), ".x { color: red; }");
    const report = await buildGames(
      discoverGames(gamesDir),
      shellDir,
      join(gamesDir, ".build"),
    );
    expect(report.ok.map((d) => d.manifest.id)).toEqual(["local/styled"]);
    expect(report.failed.map((f) => f.id)).toEqual(["local/broken"]);
  });

  it("still builds a working bundle when every game is fine", async () => {
    const gamesDir = makeGames({ alpha: {}, beta: {} });
    const report = await buildGames(
      discoverGames(gamesDir),
      shellDir,
      join(gamesDir, ".build"),
    );
    expect(report.failed).toEqual([]);
    expect(report.ok).toHaveLength(2);
  });
});
