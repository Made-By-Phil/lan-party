import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { smokeTestGame } from "../src/server/validate.ts";
import type { GameManifest } from "../src/shared/types.ts";

const dir = mkdtempSync(join(tmpdir(), "lp-smoke-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const manifest = (over: Partial<GameManifest> = {}): GameManifest => ({
  id: "t",
  name: "T",
  description: "",
  minPlayers: 1,
  maxPlayers: 4,
  teams: "none",
  tickRate: 20,
  displayMode: "device",
  ...over,
});

/** Write a built-server-shaped ESM module; smoke-child imports it by URL. */
function game(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

const CLEAN = `
export default function create(ctx) {
  let n = 0;
  return {
    onAction(id, action) { if (action && action.type === "go") n++; },
    tick(dt) { n += dt; },
    getPublicState() { return { n }; },
  };
}`;

describe("smokeTestGame", () => {
  it("passes a well-behaved game", async () => {
    const r = await smokeTestGame(game("clean", CLEAN), manifest());
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    // The child also reports what a snapshot costs on the wire.
    expect(r.snapshotBytes).toBeGreaterThan(0);
  });

  it("rejects a game that leaks a timer — it would never let the host go", async () => {
    const leaky = game(
      "leaky",
      `export default function create(ctx) {
         setInterval(() => {}, 50); // never cleared
         return { onAction() {}, getPublicState() { return {}; } };
       }`,
    );
    const r = await smokeTestGame(leaky, manifest({ tickRate: 0 }), 1500);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not exit/);
  });

  it("rejects a game that blocks forever in a tick", async () => {
    const spin = game(
      "spin",
      `export default function create(ctx) {
         return { onAction() {}, tick() { while (true) {} }, getPublicState() { return {}; } };
       }`,
    );
    const r = await smokeTestGame(spin, manifest(), 1500);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not finish/);
  });

  it("rejects a game that throws on junk input", async () => {
    const brittle = game(
      "brittle",
      `export default function create(ctx) {
         return {
           onAction(id, action) { return action.type.toUpperCase(); }, // explodes on null
           getPublicState() { return {}; },
         };
       }`,
    );
    const r = await smokeTestGame(brittle, manifest());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/onAction threw/);
  });

  it("rejects state that cannot cross the wire", async () => {
    const circular = game(
      "circular",
      `export default function create(ctx) {
         const s = {}; s.self = s;
         return { onAction() {}, getPublicState() { return s; } };
       }`,
    );
    const r = await smokeTestGame(circular, manifest());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not JSON-serializable/);
  });

  it("rejects a game that throws while ticking", async () => {
    const boom = game(
      "boom",
      `export default function create(ctx) {
         return { onAction() {}, tick() { throw new Error("bang"); }, getPublicState() { return {}; } };
       }`,
    );
    const r = await smokeTestGame(boom, manifest());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tick threw/);
  });

  it("rejects a module with no createGame export", async () => {
    const r = await smokeTestGame(game("empty", `export const nope = 1;`), manifest());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/default-export/);
  });

  it("does not take the host down when the game calls process.exit", async () => {
    const suicidal = game(
      "suicidal",
      `export default function create(ctx) { process.exit(3); }`,
    );
    const r = await smokeTestGame(suicidal, manifest());
    expect(r.ok).toBe(false);
    // The point: we are still here to assert this at all.
    expect(r.reason).toBeTruthy();
  });
});
