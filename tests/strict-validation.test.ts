import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { settingExtremes, validateGameDir } from "../src/install/install.ts";
import { packageRoot } from "../src/server/paths.ts";
import { typecheckGame } from "../src/server/typecheck.ts";
import type { SettingSpec } from "../src/shared/types.ts";

const shellDir = join(packageRoot(), "shell");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLIENT = `import type { GameClientProps } from "lan-party/sdk";
export default function C({ game }: GameClientProps) { return <div>ok</div>; }`;

const OK_SERVER = `import type { GameContext, GameServer } from "lan-party/sdk";
export default function create(ctx: GameContext): GameServer {
  return { onAction() {}, getPublicState() { return { ok: true }; } };
}`;

function game(files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-strict-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "game.json"),
    JSON.stringify({
      id: "test/strict",
      name: "Strict",
      description: "",
      minPlayers: 1,
      maxPlayers: 4,
      teams: "none",
      tickRate: 0,
      displayMode: "device",
      engine: "^0.1.0",
      ...manifest,
    }),
  );
  writeFileSync(join(dir, "client.tsx"), files["client.tsx"] ?? CLIENT);
  writeFileSync(join(dir, "server.ts"), files["server.ts"] ?? OK_SERVER);
  for (const [name, body] of Object.entries(files)) {
    if (name !== "client.tsx" && name !== "server.ts") writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe("typecheckGame", () => {
  it("passes a clean game", async () => {
    const r = await typecheckGame(game({}));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("catches what esbuild strips without checking", async () => {
    // This builds and runs fine; only the compiler knows it is wrong.
    const dir = game({
      "server.ts": `import type { GameContext, GameServer } from "lan-party/sdk";
        type Dir = "up" | "down";
        export default function create(ctx: GameContext): GameServer {
          const d: Dir = "sideways";
          return { onAction() {}, getPublicState() { return { d }; } };
        }`,
    });
    const r = await typecheckGame(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/sideways/);
  });

  it("reports paths relative to the game, not the temp config", async () => {
    const dir = game({
      "server.ts": `import type { GameContext, GameServer } from "lan-party/sdk";
        export default function create(ctx: GameContext): GameServer {
          const n: number = "not a number";
          return { onAction() {}, getPublicState() { return { n }; } };
        }`,
    });
    const r = await typecheckGame(dir);
    expect(r.errors[0]).toMatch(/^server\.ts\(/);
  });

  it("catches the type-only import rule the SDK's own config enforces", async () => {
    const dir = game({
      "helpers.ts": `export interface Thing { a: number }
        export const makeThing = (): Thing => ({ a: 1 });`,
      "client.tsx": `import type { GameClientProps } from "lan-party/sdk";
        import { Thing, makeThing } from "./helpers.ts";
        export default function C({ game }: GameClientProps) {
          const t: Thing = makeThing();
          return <div>{t.a}</div>;
        }`,
    });
    const r = await typecheckGame(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/type-only import/);
  });
});

describe("settingExtremes", () => {
  const specs: SettingSpec[] = [
    { key: "rounds", label: "Rounds", type: "number", default: 5, min: 1, max: 10 },
    { key: "bonus", label: "Bonus", type: "boolean", default: true },
  ];

  it("runs defaults plus each numeric edge", () => {
    const runs = settingExtremes(specs);
    expect(runs.map((r) => r.label)).toEqual([
      "defaults",
      "rounds=1 (min)",
      "rounds=10 (max)",
    ]);
    expect(runs[1]!.settings.rounds).toBe(1);
    expect(runs[2]!.settings.rounds).toBe(10);
  });

  it("does not duplicate an edge that is already the default", () => {
    const runs = settingExtremes([
      { key: "n", label: "N", type: "number", default: 1, min: 1, max: 3 },
    ]);
    expect(runs.map((r) => r.label)).toEqual(["defaults", "n=3 (max)"]);
  });

  it("has nothing to vary when a game declares no numeric settings", () => {
    expect(settingExtremes(undefined).map((r) => r.label)).toEqual(["defaults"]);
  });
});

describe("validateGameDir (thorough)", () => {
  it("refuses a game that does not typecheck", async () => {
    const dir = game({
      "server.ts": `import type { GameContext, GameServer } from "lan-party/sdk";
        export default function create(ctx: GameContext): GameServer {
          const x: number = "nope";
          return { onAction() {}, getPublicState() { return { x }; } };
        }`,
    });
    await expect(validateGameDir(dir, shellDir, { thorough: true })).rejects.toThrow(
      /typecheck failed/,
    );
    // The quick path still lets it through — that is the install path's job.
    await expect(validateGameDir(dir, shellDir, { skipSmoke: true })).resolves.toBeTruthy();
  }, 60_000);

  it("catches a game that only breaks at the top of a setting", async () => {
    // Passes at the default of 5, throws at the max of 10: exactly the class of
    // bug a defaults-only smoke test waved through three times.
    const dir = game(
      {
        "server.ts": `import type { GameContext, GameServer } from "lan-party/sdk";
          export default function create(ctx: GameContext): GameServer {
            const rounds = ctx.settings.rounds as number;
            if (rounds > 8) throw new Error("cannot deal that many rounds");
            return { onAction() {}, getPublicState() { return { rounds }; } };
          }`,
      },
      {
        settings: [
          { key: "rounds", label: "Rounds", type: "number", default: 5, min: 3, max: 10 },
        ],
      },
    );
    await expect(validateGameDir(dir, shellDir, { thorough: true })).rejects.toThrow(
      /rounds=10 \(max\)/,
    );
  }, 60_000);

  it("warns about a public state too big to send every tick", async () => {
    const dir = game(
      {
        "server.ts": `import type { GameContext, GameServer } from "lan-party/sdk";
          export default function create(ctx: GameContext): GameServer {
            const grid = new Array(3000).fill(0);
            return { onAction() {}, tick() {}, getPublicState() { return { grid }; } };
          }`,
      },
      { tickRate: 10 },
    );
    const { warnings } = await validateGameDir(dir, shellDir, { thorough: true });
    expect(warnings.join(" ")).toMatch(/KB\/s to every device at 10 Hz/);
  }, 60_000);

  it("stays quiet about a small snapshot", async () => {
    const { warnings } = await validateGameDir(game({}, { tickRate: 10 }), shellDir, {
      thorough: true,
    });
    expect(warnings.join(" ")).not.toMatch(/public state/);
  }, 60_000);
});
