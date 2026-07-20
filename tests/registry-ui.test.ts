import { createServer, type Server } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/index.ts";
import { packageRoot } from "../src/server/paths.ts";
import type { ClientMsg, ServerMsg } from "../src/shared/types.ts";

const root = packageRoot();
let server: RunningServer | null = null;
let registry: Server | null = null;
let dir = "";
let registryPort = 0;

/** Serves a games.json plus a real tarball, standing in for the curated repo. */
async function startRegistry(): Promise<void> {
  const staging = join(dir, "staging");
  mkdirSync(join(staging, "ana-quiz"), { recursive: true });
  cpSync(join(root, "tests/fixtures/games", "alpha"), join(staging, "ana-quiz"), { recursive: true });
  const p = join(staging, "ana-quiz", "game.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  m.id = "ana/quiz";
  m.name = "Ana Quiz";
  writeFileSync(p, JSON.stringify(m, null, 2));

  const { spawnSync } = await import("node:child_process");
  const tarball = join(dir, "quiz.tar.gz");
  spawnSync("tar", ["-czf", tarball, "-C", staging, "ana-quiz"]);
  const body = readFileSync(tarball);

  // A monorepo tarball, exactly the curated repo's shape: a wrapper directory
  // containing many games, with the index naming the subdir to take.
  const mono = join(dir, "mono");
  mkdirSync(join(mono, "games-repo-main", "games", "chess"), { recursive: true });
  cpSync(
    join(root, "tests/fixtures/games", "beta"),
    join(mono, "games-repo-main", "games", "chess"),
    { recursive: true },
  );
  const cp = join(mono, "games-repo-main", "games", "chess", "game.json");
  const cm = JSON.parse(readFileSync(cp, "utf8"));
  cm.id = "ana/chess";
  cm.name = "Ana Chess";
  writeFileSync(cp, JSON.stringify(cm, null, 2));
  writeFileSync(join(mono, "games-repo-main", "README.md"), "# games");
  const monoTar = join(dir, "mono.tar.gz");
  spawnSync("tar", ["-czf", monoTar, "-C", mono, "games-repo-main"]);
  const monoBody = readFileSync(monoTar);

  registry = createServer((req, res) => {
    if (req.url === "/games.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          games: [
            {
              id: "ana/quiz",
              name: "Ana Quiz",
              description: "a quiz",
              engine: "^0.1.0",
              tarball: `http://127.0.0.1:${registryPort}/quiz.tar.gz`,
            },
            {
              id: "ana/chess",
              name: "Ana Chess",
              description: "from a monorepo",
              engine: "^0.1.0",
              tarball: `http://127.0.0.1:${registryPort}/mono.tar.gz`,
              subdir: "games/chess",
            },
            {
              id: "ana/from-the-future",
              name: "Future Game",
              description: "needs a newer host",
              engine: "^9.0.0",
              tarball: "http://127.0.0.1/nope.tar.gz",
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/quiz.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(body);
      return;
    }
    if (req.url === "/mono.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(monoBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => registry!.listen(0, "127.0.0.1", r));
  registryPort = (registry!.address() as { port: number }).port;
  process.env.LAN_PARTY_REGISTRY = `http://127.0.0.1:${registryPort}`;
}

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
  async wait(type: string, ms = 15000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.msgs.find((m) => m.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${type}; got ${this.msgs.map((m) => m.type).join(",")}`);
  }
  close(): void {
    this.ws.close();
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-reg-"));
  mkdirSync(join(dir, "games"), { recursive: true });
  await startRegistry();
  server = await startServer({
    port: 0,
    gamesDir: join(dir, "games"),
    allowShared: true,
    fresh: true,
    cwd: dir,
    quiet: true,
    watch: false,
  });
});

afterEach(async () => {
  await server?.close();
  await new Promise<void>((r) => (registry ? registry.close(() => r()) : r()));
  server = null;
  registry = null;
  delete process.env.LAN_PARTY_REGISTRY;
  rmSync(dir, { recursive: true, force: true });
});

describe("in-party game browser", () => {
  it("lets the party lead search the registry", async () => {
    const a = await new Client().connect(server!.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();
    a.send({ type: "registry.search", query: "" });
    const res = await a.wait("registry.results");

    expect(res.error).toBeUndefined();
    expect(res.games.map((g: { id: string }) => g.id)).toContain("ana/quiz");
    a.close();
  });

  it("marks games needing a newer host as incompatible rather than hiding them", async () => {
    const a = await new Client().connect(server!.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();
    a.send({ type: "registry.search" });
    const res = await a.wait("registry.results");

    const future = res.games.find((g: { id: string }) => g.id === "ana/from-the-future");
    expect(future.compatible).toBe(false);
    expect(res.games.find((g: { id: string }) => g.id === "ana/quiz").compatible).toBe(true);
    a.close();
  });

  it("ignores search and install from a non-lead player", async () => {
    const lead = await new Client().connect(server!.port);
    lead.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();
    const other = await new Client().connect(server!.port);
    other.send({ type: "join", token: "tok-b", name: "Ben", role: "player" });
    await settle();

    other.send({ type: "registry.search", query: "" });
    other.send({ type: "registry.install", id: "ana/quiz" });
    await settle(600);

    expect(other.msgs.some((m) => m.type === "registry.results")).toBe(false);
    expect(other.msgs.some((m) => m.type === "registry.status")).toBe(false);
    lead.close();
    other.close();
  });

  it("installs a game and reloads the party", async () => {
    const a = await new Client().connect(server!.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();

    a.send({ type: "registry.install", id: "ana/quiz" });
    const done = await a.wait("registry.status");
    expect(done.state).toBe("installing");

    const installed = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const hit = a.msgs.find((m) => m.type === "registry.status" && (m as any).state !== "installing");
        if (hit) return hit as any;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("install never finished");
    })();
    expect(installed.state, installed.message).toBe("installed");

    // It is on disk, in the live catalog, and everyone was told to reload.
    const session = [...a.msgs].reverse().find((m) => m.type === "session") as any;
    expect(session.catalog.map((c: { id: string }) => c.id)).toContain("ana/quiz");
    expect(a.msgs.some((m) => m.type === "reload")).toBe(true);
    a.close();
  }, 40_000);

  it("installs a game from a subdir of a monorepo tarball", async () => {
    // The curated repo's actual shape: one tarball, many games, index says which.
    const a = await new Client().connect(server!.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();

    a.send({ type: "registry.install", id: "ana/chess" });
    const installed = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const hit = a.msgs.find(
          (m) => m.type === "registry.status" && (m as any).state !== "installing",
        );
        if (hit) return hit as any;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("install never finished");
    })();

    expect(installed.state, installed.message).toBe("installed");
    const session = [...a.msgs].reverse().find((m) => m.type === "session") as any;
    expect(session.catalog.map((c: { id: string }) => c.id)).toContain("ana/chess");
    // The sibling README at the repo root must not have been mistaken for the game.
    expect(session.catalog.map((c: { id: string }) => c.id)).not.toContain("ana/quiz");
    a.close();
  }, 40_000);

  it("reports a registry it cannot reach instead of hanging", async () => {
    process.env.LAN_PARTY_REGISTRY = "http://127.0.0.1:9"; // nothing listening
    await server!.close();
    server = await startServer({
      port: 0,
      gamesDir: join(dir, "games"),
      allowShared: true,
      fresh: true,
      cwd: dir,
      quiet: true,
      watch: false,
    });
    const a = await new Client().connect(server.port);
    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    await settle();
    a.send({ type: "registry.search" });
    const res = await a.wait("registry.results");
    expect(res.error).toBeTruthy();
    expect(res.games).toEqual([]);
    a.close();
  }, 20_000);
});
