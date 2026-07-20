import { describe, expect, it } from "vitest";
import { normalizeGameId } from "../src/server/games.ts";

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
