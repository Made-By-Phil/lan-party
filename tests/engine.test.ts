import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, satisfiesEngine } from "../src/engine.ts";
import { packageRoot } from "../src/server/paths.ts";

describe("ENGINE_VERSION", () => {
  it("stays in lockstep with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("is declared by every bundled game", () => {
    const root = packageRoot();
    for (const id of ["trivia", "blackjack", "bomberman"]) {
      const m = JSON.parse(readFileSync(join(root, "games", id, "game.json"), "utf8"));
      expect(m.engine, `${id} must declare an engine range`).toBeTruthy();
      expect(satisfiesEngine(m.engine), `${id} must accept the current engine`).toBe(true);
    }
  });
});

describe("satisfiesEngine", () => {
  it("treats an unstated range as compatible", () => {
    expect(satisfiesEngine(undefined)).toBe(true);
    expect(satisfiesEngine("")).toBe(true);
    expect(satisfiesEngine("*")).toBe(true);
  });

  it("applies npm 0.x caret rules — a minor bump breaks 0.x games", () => {
    // The case that matters today: while the engine is 0.x, every minor bump is
    // allowed to break games, so ^0.1.0 must NOT accept 0.2.0.
    expect(satisfiesEngine("^0.1.0", "0.1.0")).toBe(true);
    expect(satisfiesEngine("^0.1.0", "0.1.9")).toBe(true);
    expect(satisfiesEngine("^0.1.0", "0.2.0")).toBe(false);
    expect(satisfiesEngine("^0.1.2", "0.1.1")).toBe(false);
    expect(satisfiesEngine("^0.0.3", "0.0.4")).toBe(false);
  });

  it("applies normal caret rules once past 1.0", () => {
    expect(satisfiesEngine("^1.2.0", "1.2.0")).toBe(true);
    expect(satisfiesEngine("^1.2.0", "1.9.9")).toBe(true);
    expect(satisfiesEngine("^1.2.0", "2.0.0")).toBe(false);
    expect(satisfiesEngine("^1.2.0", "1.1.9")).toBe(false);
  });

  it("handles tilde, comparators, wildcards and exact pins", () => {
    expect(satisfiesEngine("~1.2.0", "1.2.9")).toBe(true);
    expect(satisfiesEngine("~1.2.0", "1.3.0")).toBe(false);
    expect(satisfiesEngine(">=0.1.0", "3.0.0")).toBe(true);
    expect(satisfiesEngine("<0.2.0", "0.1.5")).toBe(true);
    expect(satisfiesEngine("1.x", "1.7.3")).toBe(true);
    expect(satisfiesEngine("1.x", "2.0.0")).toBe(false);
    expect(satisfiesEngine("1.2.x", "1.2.8")).toBe(true);
    expect(satisfiesEngine("1.2.x", "1.3.0")).toBe(false);
    expect(satisfiesEngine("0.1.0", "0.1.0")).toBe(true);
    expect(satisfiesEngine("0.1.0", "0.1.1")).toBe(false);
  });

  it("rejects ranges it cannot parse rather than guessing", () => {
    expect(satisfiesEngine("not-a-version")).toBe(false);
    expect(satisfiesEngine(">=1.0.0 <2.0.0")).toBe(false); // compound: unsupported
  });

  it("treats a two-part version as x.y.0", () => {
    expect(satisfiesEngine("^0.1", "0.1.4")).toBe(true);
  });
});
