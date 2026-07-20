import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/index.ts";
import { packageRoot } from "../src/server/paths.ts";
import type { ClientMsg, ServerMsg } from "../src/shared/types.ts";

const root = packageRoot();
let server: RunningServer | null = null;
let dir = "";

afterEach(async () => {
  await server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

class Client {
  ws!: WebSocket;
  msgs: ServerMsg[] = [];
  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(String(d))));
    await new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
    return this;
  }
  send(m: ClientMsg): void {
    this.ws.send(JSON.stringify(m));
  }
  got(type: string): boolean {
    return this.msgs.some((m) => m.type === type);
  }
  lastCatalog(): string[] {
    const s = [...this.msgs].reverse().find((m) => m.type === "session");
    return (s as any)?.catalog.map((c: { id: string }) => c.id) ?? [];
  }
  close(): void {
    this.ws.close();
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** A party whose games dir we can mutate underneath it. */
async function party(): Promise<RunningServer> {
  dir = mkdtempSync(join(tmpdir(), "lp-hot-"));
  mkdirSync(join(dir, "games"), { recursive: true });
  // Seed one game: there are no bundled games any more.
  cpSync(join(root, "tests/fixtures/games/beta"), join(dir, "games", "test__beta"), {
    recursive: true,
  });
  server = await startServer({
    port: 0,
    gamesDir: join(dir, "games"),
    allowShared: true,
    fresh: true,
    cwd: dir,
    quiet: true,
    watch: false, // drive rebuilds explicitly; fs events are timing-dependent
  });
  return server;
}

function dropGame(id: string, from = "alpha"): void {
  const dest = join(dir, "games", id.replace("/", "__"));
  cpSync(join(root, "tests/fixtures/games", from), dest, { recursive: true });
  const p = join(dest, "game.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  m.id = id;
  m.name = id;
  writeFileSync(p, JSON.stringify(m, null, 2));
}

describe("rebuild and reload", () => {
  it("picks up a game dropped into the folder and tells clients to reload", async () => {
    const s = await party();
    const a = await new Client().connect(s.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();
    expect(a.lastCatalog()).not.toContain("dropped/arena");

    dropGame("dropped/arena");
    await s.rebuild();
    await settle();

    expect(a.lastCatalog()).toContain("dropped/arena");
    expect(a.got("reload")).toBe(true);
    a.close();
  }, 30_000);

  it("holds the reload until the round is over", async () => {
    const s = await party();
    const a = await new Client().connect(s.port);
    const b = await new Client().connect(s.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    b.send({ type: "join", token: "tok-b", name: "Ben", role: "player" });
    await settle();

    a.send({ type: "lobby.admin", admin: { op: "startGame", gameId: "test/beta" } });
    await settle(500);
    expect(a.lastCatalog().length).toBeGreaterThan(0);

    dropGame("dropped/arena");
    await s.rebuild();
    await settle();

    // Mid-round: the new game is in the catalog, but nobody is yanked out.
    expect(a.got("reload"), "must not reload mid-round").toBe(false);

    a.send({ type: "lobby.admin", admin: { op: "endGame" } });
    await settle(600);
    expect(a.got("reload"), "reload should arrive once back in the lobby").toBe(true);

    a.close();
    b.close();
  }, 30_000);

  it("keeps serving the old build when the new one is broken", async () => {
    const s = await party();
    const a = await new Client().connect(s.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();
    const before = a.lastCatalog();

    // A game that cannot compile must not cost us the games that can.
    const bad = join(dir, "games", "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(
      join(bad, "game.json"),
      JSON.stringify({ id: "x/broken", name: "Broken", displayMode: "device" }),
    );
    writeFileSync(join(bad, "client.tsx"), "export default function C() { return <div>oops");
    writeFileSync(join(bad, "server.ts"), "export default function c() { return {}; }");
    await s.rebuild();
    await settle();

    expect(a.lastCatalog().sort()).toEqual(before.sort());
    expect(a.lastCatalog()).not.toContain("x/broken");
    a.close();
  }, 30_000);
});
