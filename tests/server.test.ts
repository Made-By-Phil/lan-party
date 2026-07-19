import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/index.ts";
import type { ClientMsg, ServerMsg } from "../src/shared/types.ts";

/** Tiny ws test client that records every server message. */
class TestClient {
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

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait until a message matching pred arrives (scans history too). */
  async expectMsg(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for message; got: ${this.msgs.map((m) => m.type).join(",")}`);
  }

  lastSession(): Extract<ServerMsg, { type: "session" }> | undefined {
    return [...this.msgs].reverse().find((m) => m.type === "session") as any;
  }

  close(): void {
    this.ws.close();
  }
}

let server: RunningServer;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-server-test-"));
  server = await startServer({
    port: 0,
    gamesDir: null,
    allowShared: true,
    fresh: true,
    cwd: dir,
    quiet: true,
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("protocol", () => {
  it("sends a session snapshot before join, tracks joins and lead", async () => {
    const a = await new TestClient().connect(server.port);
    await a.expectMsg((m) => m.type === "session");

    a.send({ type: "join", token: "tok-a", name: "Ana", role: "player" });
    const joined = (await a.expectMsg((m) => m.type === "joined")) as any;
    expect(joined.self.name).toBe("Ana");
    expect(joined.self.isLead).toBe(true);

    const b = await new TestClient().connect(server.port);
    b.send({ type: "join", token: "tok-b", name: "Ben", role: "player" });
    await b.expectMsg((m) => m.type === "joined");
    const snap = (await a.expectMsg(
      (m) => m.type === "session" && m.session.players.length === 2,
    )) as any;
    expect(snap.session.players.map((p: any) => p.name).sort()).toEqual(["Ana", "Ben"]);
    a.close();
    b.close();
  });

  it("allows exactly one shared visual", async () => {
    const tv = await new TestClient().connect(server.port);
    tv.send({ type: "join", token: "ignored", name: undefined, role: "shared" });
    const ok = (await tv.expectMsg((m) => m.type === "joined")) as any;
    expect(ok.role).toBe("shared");
    expect(ok.self).toBeNull();

    const tv2 = await new TestClient().connect(server.port);
    tv2.send({ type: "join", token: "ignored2", role: "shared" });
    const err = (await tv2.expectMsg((m) => m.type === "error")) as any;
    expect(err.code).toBe("shared-unavailable");

    tv.close();
    // Slot frees up after the first tv disconnects.
    const tv3 = await new TestClient().connect(server.port);
    await tv3.expectMsg((m) => m.type === "session" && !m.sharedVisualPresent);
    tv3.send({ type: "join", token: "ignored3", role: "shared" });
    await tv3.expectMsg((m) => m.type === "joined");
    tv3.close();
    tv2.close();
  });

  it("ignores admin ops from non-lead players and honors them from the lead", async () => {
    const a = await new TestClient().connect(server.port);
    a.send({ type: "join", token: "tok-a", role: "player" });
    await a.expectMsg((m) => m.type === "joined");
    const b = await new TestClient().connect(server.port);
    b.send({ type: "join", token: "tok-b", role: "player" });
    await b.expectMsg((m) => m.type === "joined");

    // Ben (not lead) tries to create a team — nothing happens.
    b.send({ type: "lobby.admin", admin: { op: "createTeam", name: "Cheaters" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.lastSession()!.session.teams).toHaveLength(0);

    // Ana (lead) creates one.
    a.send({ type: "lobby.admin", admin: { op: "createTeam", name: "Reds" } });
    const snap = (await a.expectMsg(
      (m) => m.type === "session" && m.session.teams.length === 1,
    )) as any;
    expect(snap.session.teams[0].name).toBe("Reds");

    // Ben can join the team himself.
    const teamId = snap.session.teams[0].id;
    b.send({ type: "lobby.joinTeam", teamId });
    await b.expectMsg(
      (m) =>
        m.type === "session" &&
        m.session.players.some((p) => p.id === "tok-b" && p.teamId === teamId),
    );
    a.close();
    b.close();
  });

  it("kicked players get a coded error and are removed", async () => {
    const a = await new TestClient().connect(server.port);
    a.send({ type: "join", token: "tok-a", role: "player" });
    await a.expectMsg((m) => m.type === "joined");
    const c = await new TestClient().connect(server.port);
    c.send({ type: "join", token: "tok-c", name: "Cy", role: "player" });
    await c.expectMsg((m) => m.type === "joined");

    a.send({ type: "lobby.admin", admin: { op: "kick", playerId: "tok-c" } });
    const err = (await c.expectMsg((m) => m.type === "error")) as any;
    expect(err.code).toBe("kicked");
    await a.expectMsg(
      (m) => m.type === "session" && !m.session.players.some((p) => p.id === "tok-c"),
    );
    a.close();
    c.close();
  });

  it("rejects votes for unknown games", async () => {
    const a = await new TestClient().connect(server.port);
    a.send({ type: "join", token: "tok-a", role: "player" });
    await a.expectMsg((m) => m.type === "joined");
    a.send({ type: "lobby.vote", gameId: "not-a-game" });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.lastSession()!.session.votes["tok-a"]).toBeUndefined();
    a.close();
  });
});
