import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session, sanitizeName } from "../src/server/session.ts";

let dirs: string[] = [];
function makeSession(): Session {
  const dir = mkdtempSync(join(tmpdir(), "lp-test-"));
  dirs.push(dir);
  return new Session(join(dir, "session.json"));
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("roster & lead", () => {
  it("creates players and resumes by token", () => {
    const s = makeSession();
    const a = s.connect("tok-a", "Ana");
    expect(a.name).toBe("Ana");
    expect(a.isLead).toBe(true);
    const b = s.connect("tok-b", "Ben");
    expect(b.isLead).toBe(false);
    const again = s.connect("tok-a", undefined);
    expect(again).toBe(a);
    expect(s.toState().players).toHaveLength(2);
  });

  it("passes the lead to the earliest connected player on disconnect", () => {
    const s = makeSession();
    s.connect("a", "Ana");
    s.connect("b", "Ben");
    s.connect("c", "Cy");
    s.disconnect("a");
    expect(s.players.get("b")!.isLead).toBe(true);
    s.connect("a", undefined); // Ana comes back — earliest joiner leads again
    expect(s.players.get("a")!.isLead).toBe(true);
  });

  it("kick removes the player entirely", () => {
    const s = makeSession();
    s.connect("a", "Ana");
    s.connect("b", "Ben");
    s.vote("b", "trivia");
    s.kick("b");
    expect(s.players.has("b")).toBe(false);
    expect(s.votes["b"]).toBeUndefined();
    expect(s.points["b"]).toBeUndefined();
  });

  it("sanitizes names", () => {
    expect(sanitizeName("  Nova   Prime  ")).toBe("Nova Prime");
    expect(sanitizeName("x".repeat(50))).toHaveLength(20);
    expect(sanitizeName("   ")).toBe("");
    const s = makeSession();
    expect(s.connect("a", "   ").name).toBe("Player 1");
  });
});

describe("teams", () => {
  it("assigns, removes, and clears memberships with the team", () => {
    const s = makeSession();
    s.connect("a", "Ana");
    const t = s.createTeam("Reds");
    s.assignTeam("a", t.id);
    expect(s.players.get("a")!.teamId).toBe(t.id);
    s.assignTeam("a", "nonexistent");
    expect(s.players.get("a")!.teamId).toBe(t.id);
    s.removeTeam(t.id);
    expect(s.players.get("a")!.teamId).toBeNull();
  });

  it("auto-balance deals connected players round-robin", () => {
    const s = makeSession();
    for (let i = 0; i < 5; i++) s.connect(`p${i}`, `P${i}`);
    s.disconnect("p4");
    s.autoBalance(2);
    expect(s.teams).toHaveLength(2);
    const counts = s.teams.map(
      (t) => [...s.players.values()].filter((p) => p.connected && p.teamId === t.id).length,
    );
    expect(counts.sort()).toEqual([2, 2]);
  });
});

describe("points & results", () => {
  it("accumulates results into the ledger, ignoring unknown players", () => {
    const s = makeSession();
    s.connect("a", "Ana");
    s.connect("b", "Ben");
    s.vote("a", "blackjack");
    s.recordResult({
      gameId: "blackjack",
      gameName: "Blackjack",
      endedAt: 1,
      pointsByPlayer: { a: 30, b: 10, ghost: 99 },
    });
    expect(s.points["a"]).toBe(30);
    expect(s.points["ghost"]).toBeUndefined();
    expect(s.votes).toEqual({}); // votes reset after a round
    s.recordResult({
      gameId: "trivia",
      gameName: "Trivia",
      endedAt: 2,
      pointsByPlayer: { a: 12 },
    });
    expect(s.points["a"]).toBe(42);
    expect(s.history).toHaveLength(2);
  });

  it("adjustPoints only touches known players and finite deltas", () => {
    const s = makeSession();
    s.connect("a", "Ana");
    s.adjustPoints("a", 5.4);
    expect(s.points["a"]).toBe(5);
    s.adjustPoints("a", NaN);
    expect(s.points["a"]).toBe(5);
    s.adjustPoints("nobody", 5);
    expect(s.points["nobody"]).toBeUndefined();
  });
});

describe("persistence", () => {
  it("round-trips through the session file with players marked disconnected", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-test-"));
    dirs.push(dir);
    const file = join(dir, "session.json");
    const s = new Session(file);
    s.connect("a", "Ana");
    const t = s.createTeam("Reds");
    s.assignTeam("a", t.id);
    s.adjustPoints("a", 7);
    s.save();

    const restored = Session.load(file, false);
    const a = restored.players.get("a")!;
    expect(a.name).toBe("Ana");
    expect(a.connected).toBe(false);
    expect(a.teamId).toBe(t.id);
    expect(restored.points["a"]).toBe(7);

    const fresh = Session.load(file, true);
    expect(fresh.players.size).toBe(0);
  });
});
