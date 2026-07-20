import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeGameId } from "../src/server/games.ts";
import { packageRoot } from "../src/server/paths.ts";

describe("normalizeGameId", () => {
  it("scopes a bare id to local/ so drop-in folders still work", () => {
    expect(normalizeGameId("mygame", "folder")).toBe("local/mygame");
    expect(normalizeGameId(undefined, "folder")).toBe("local/folder");
    expect(normalizeGameId("", "folder")).toBe("local/folder");
  });

  it("keeps an explicit scope", () => {
    expect(normalizeGameId("someone/trivia", "f")).toBe("someone/trivia");
  });

  it("lowercases", () => {
    expect(normalizeGameId("Made-By-Phil/Trivia", "f")).toBe("made-by-phil/trivia");
  });

  it("means two authors can ship the same game name", () => {
    expect(normalizeGameId("ana/trivia", "f")).not.toBe(normalizeGameId("ben/trivia", "f"));
  });

  it("rejects ids that would escape the games directory or break file names", () => {
    for (const bad of ["../evil", "a/b/c", "a//b", "sco pe/name", "scope/", "/name", "-lead"]) {
      expect(() => normalizeGameId(bad, "f"), bad).toThrow(/invalid id/);
    }
  });
});

describe("bundled games", () => {
  it("are namespaced under lan-party/", () => {
    const root = packageRoot();
    for (const folder of ["trivia", "blackjack", "bomberman"]) {
      const m = JSON.parse(readFileSync(join(root, "games", folder, "game.json"), "utf8"));
      expect(m.id).toBe(`lan-party/${folder}`);
    }
  });
});
