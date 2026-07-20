import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/index.ts";
import { packageRoot } from "../src/server/paths.ts";
import type { ClientMsg, ServerMsg } from "../src/shared/types.ts";

let server: RunningServer;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-settings-"));
  server = await startServer({
    port: 0,
    gamesDir: join(packageRoot(), "tests/fixtures/games"),
    allowShared: true,
    fresh: true,
    cwd: dir,
    quiet: true,
    watch: false,
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  ws!: WebSocket;
  msgs: ServerMsg[] = [];
  async connect(): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
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
  session(): any {
    return [...this.msgs].reverse().find((m) => m.type === "session");
  }
  gameState(): any {
    return [...this.msgs].reverse().find((m) => m.type === "game.state");
  }
  settingsFor(id: string): Record<string, unknown> {
    return this.session()?.session.settings?.[id] ?? {};
  }
  close(): void {
    this.ws.close();
  }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function lead(): Promise<Client> {
  const c = await new Client().connect();
  c.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
  await settle();
  return c;
}

describe("settings reach the game", () => {
  it("publishes the declared schema to every client in the catalog", async () => {
    const a = await lead();
    const beta = a.session().catalog.find((m: any) => m.id === "test/beta");
    expect(beta.settings.map((s: any) => s.key)).toEqual(["rounds", "speedBonus", "difficulty"]);
    a.close();
  });

  it("hands a game its defaults when nothing was chosen", async () => {
    const a = await lead();
    a.send({ type: "lobby.admin", admin: { op: "startGame", gameId: "test/beta" } });
    await settle(600);
    expect(a.gameState().state.settings).toEqual({
      rounds: 5,
      speedBonus: true,
      difficulty: "normal",
    });
    a.send({ type: "lobby.admin", admin: { op: "endGame" } });
    await settle(400);
    a.close();
  });

  it("hands a game the values the party chose", async () => {
    const a = await lead();
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 9 },
    });
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "difficulty", value: "hard" },
    });
    await settle();

    a.send({ type: "lobby.admin", admin: { op: "startGame", gameId: "test/beta" } });
    await settle(600);
    expect(a.gameState().state.settings).toMatchObject({ rounds: 9, difficulty: "hard" });

    a.send({ type: "lobby.admin", admin: { op: "endGame" } });
    await settle(400);
    a.close();
  });

  it("clamps a hostile value instead of trusting it", async () => {
    const a = await lead();
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 9999 },
    });
    await settle();
    expect(a.settingsFor("test/beta").rounds).toBe(10); // max
    a.close();
  });

  it("ignores an unknown key or an off-menu value", async () => {
    const a = await lead();
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "notAThing", value: 1 },
    });
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "difficulty", value: "impossible" },
    });
    await settle();
    const stored = a.settingsFor("test/beta");
    expect(stored).not.toHaveProperty("notAThing");
    expect(stored.difficulty).not.toBe("impossible");
    a.close();
  });

  it("ignores settings changes from a player who is not the lead", async () => {
    const leadClient = await lead();
    const other = await new Client().connect();
    other.send({ type: "join", token: "tok-b", name: "Ben", role: "player" });
    await settle();

    const before = leadClient.settingsFor("test/beta").rounds;
    other.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 2 },
    });
    await settle();
    expect(leadClient.settingsFor("test/beta").rounds).toBe(before);
    leadClient.close();
    other.close();
  });

  it("locks settings while a round is running", async () => {
    const a = await lead();
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 4 },
    });
    await settle();
    a.send({ type: "lobby.admin", admin: { op: "startGame", gameId: "test/beta" } });
    await settle(600);

    // Changing the rules under a game in flight is never what anyone meant.
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 1 },
    });
    await settle();
    expect(a.settingsFor("test/beta").rounds).toBe(4);
    expect(a.gameState().state.settings.rounds).toBe(4);

    a.send({ type: "lobby.admin", admin: { op: "endGame" } });
    await settle(400);
    a.close();
  });

  it("resets to defaults on request", async () => {
    const a = await lead();
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 8 },
    });
    await settle();
    expect(a.settingsFor("test/beta").rounds).toBe(8);

    a.send({ type: "lobby.admin", admin: { op: "resetSettings", gameId: "test/beta" } });
    await settle();
    expect(a.settingsFor("test/beta")).toEqual({});
    a.close();
  });

  it("survives a host restart, like the rest of the party", async () => {
    const a = await lead();
    a.send({
      type: "lobby.admin",
      admin: { op: "setSetting", gameId: "test/beta", key: "rounds", value: 3 },
    });
    await settle(700); // let the debounced save land
    a.close();
    await server.close();

    server = await startServer({
      port: 0,
      gamesDir: join(packageRoot(), "tests/fixtures/games"),
      allowShared: true,
      fresh: false, // resume
      cwd: dir,
      quiet: true,
      watch: false,
    });
    const b = await new Client().connect();
    await settle();
    expect(b.session().session.settings["test/beta"].rounds).toBe(3);
    b.close();
  });
});
