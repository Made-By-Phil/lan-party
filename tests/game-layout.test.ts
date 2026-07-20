import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGames, loadGameDef } from "../src/server/games.ts";
import { packageRoot } from "../src/server/paths.ts";

const shellDir = join(packageRoot(), "shell");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = {
  id: "test/layout",
  name: "Layout",
  description: "",
  minPlayers: 1,
  maxPlayers: 4,
  teams: "none",
  tickRate: 0,
  displayMode: "device",
  engine: "^0.1.0",
};

/** Write a game folder from a map of relative path -> contents. */
function game(files: Record<string, string>, manifest: object = MANIFEST): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-layout-"));
  dirs.push(dir);
  writeFileSync(join(dir, "game.json"), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const CLIENT = `import type { GameClientProps } from "lan-party/sdk";
export default function C({ game }: GameClientProps) { return <div>ok</div>; }`;

const SERVER = `import type { GameContext, GameServer } from "lan-party/sdk";
export default function create(ctx: GameContext): GameServer {
  return { onAction() {}, getPublicState() { return {}; } };
}`;

describe("game layout", () => {
  it("accepts the flat form", () => {
    const dir = game({ "client.tsx": CLIENT, "server.ts": SERVER });
    expect(loadGameDef(dir).clientEntry).toMatch(/client\.tsx$/);
  });

  it("accepts a game decomposed into folders", () => {
    const dir = game({
      "client/index.tsx": `import { Board } from "./Board.tsx";\n${CLIENT}`,
      "client/Board.tsx": `export function Board() { return null; }`,
      "server/index.ts": `import { decide } from "./bots.ts";\n${SERVER}`,
      "server/bots.ts": `export function decide() { return "hit"; }`,
    });
    const def = loadGameDef(dir);
    expect(def.clientEntry).toMatch(/client[/\\]index\.tsx$/);
    expect(def.serverEntry).toMatch(/server[/\\]index\.ts$/);
  });

  it("refuses when both forms exist rather than silently picking one", () => {
    // One of the two files would be dead code, and the author can't tell which.
    const dir = game({
      "client.tsx": CLIENT,
      "client/index.tsx": CLIENT,
      "server.ts": SERVER,
    });
    expect(() => loadGameDef(dir)).toThrow(/both exist/);
  });

  it("points at the folder form when entries are missing", () => {
    const dir = game({ "client.tsx": CLIENT });
    expect(() => loadGameDef(dir)).toThrow(/server\/ or client\/ folder/);
  });

  it("requires shared for a shared-arena game, folder form counts", () => {
    const arena = { ...MANIFEST, displayMode: "shared-arena" };
    expect(() => loadGameDef(game({ "client.tsx": CLIENT, "server.ts": SERVER }, arena))).toThrow(
      /shared-arena/,
    );
    const withShared = game(
      { "client.tsx": CLIENT, "server.ts": SERVER, "shared/index.tsx": CLIENT },
      arena,
    );
    expect(loadGameDef(withShared).sharedEntry).toMatch(/shared[/\\]index\.tsx$/);
  });

  it("ignores a game's own test files when building", async () => {
    // Tests live beside the code they cover; nothing imports them, so they must
    // not reach the bundle or trip the build.
    const dir = mkdtempSync(join(tmpdir(), "lp-layout-games-"));
    dirs.push(dir);
    const g = join(dir, "tested");
    mkdirSync(join(g, "server"), { recursive: true });
    writeFileSync(join(g, "game.json"), JSON.stringify(MANIFEST));
    writeFileSync(join(g, "client.tsx"), CLIENT);
    writeFileSync(join(g, "server", "index.ts"), `import { decide } from "./bots.ts";\n${SERVER}`);
    writeFileSync(join(g, "server", "bots.ts"), `export function decide() { return "hit"; }`);
    writeFileSync(
      join(g, "server", "bots.test.ts"),
      `import { describe, it, expect } from "vitest";
       import { decide } from "./bots.ts";
       describe("bots", () => { it("hits", () => { expect(decide()).toBe("hit"); }); });`,
    );

    const report = await buildGames([loadGameDef(g)], shellDir, join(dir, ".build"));
    expect(report.failed).toEqual([]);
    expect(report.ok).toHaveLength(1);
  });
});
