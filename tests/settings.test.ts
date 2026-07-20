import { describe, expect, it } from "vitest";
import {
  changedSettings,
  coerceSetting,
  formatSetting,
  resolveSettings,
  validateSettingSpecs,
} from "../src/shared/settings.ts";
import type { NumberSetting, SelectSetting, SettingSpec } from "../src/shared/types.ts";

const num = (over: Partial<NumberSetting> = {}): NumberSetting => ({
  key: "rounds",
  label: "Rounds",
  type: "number",
  default: 5,
  min: 1,
  max: 10,
  ...over,
});

const sel: SelectSetting = {
  key: "difficulty",
  label: "Difficulty",
  type: "select",
  default: "normal",
  options: [
    { value: "easy", label: "Easy" },
    { value: "normal", label: "Normal" },
  ],
};

describe("validateSettingSpecs", () => {
  it("accepts an absent block", () => {
    expect(validateSettingSpecs(undefined)).toBeUndefined();
    expect(validateSettingSpecs([])).toBeUndefined();
  });

  it("accepts the three control types", () => {
    const specs = validateSettingSpecs([
      { key: "rounds", label: "Rounds", type: "number", default: 5, min: 1, max: 10 },
      { key: "bonus", label: "Bonus", type: "boolean", default: true },
      { key: "diff", label: "Diff", type: "select", default: "a", options: [{ value: "a" }] },
    ]);
    expect(specs).toHaveLength(3);
    // A missing option label falls back to its value rather than rendering blank.
    expect((specs![2] as SelectSetting).options[0]!.label).toBe("a");
  });

  it("rejects schemas an author would get subtly wrong", () => {
    const bad: [unknown, RegExp][] = [
      [{ key: "x" }, /must be an array/],
      [[{ key: "1bad", label: "L", type: "boolean", default: true }], /must start with a letter/],
      [
        [
          { key: "a", label: "A", type: "boolean", default: true },
          { key: "a", label: "B", type: "boolean", default: false },
        ],
        /declared twice/,
      ],
      [[{ key: "a", type: "boolean", default: true }], /label is required/],
      [[{ key: "a", label: "A", type: "colour", default: 1 }], /must be number, boolean or select/],
      [[{ key: "a", label: "A", type: "number", default: 99, min: 1, max: 10 }], /outside min\/max/],
      [[{ key: "a", label: "A", type: "number", default: 5, min: 10, max: 1 }], /greater than max/],
      [[{ key: "a", label: "A", type: "number", default: "5" }], /finite number/],
      [[{ key: "a", label: "A", type: "number", default: 5, step: 0 }], /step must be positive/],
      [[{ key: "a", label: "A", type: "boolean", default: "yes" }], /true or false/],
      [[{ key: "a", label: "A", type: "select", default: "x", options: [] }], /non-empty array/],
      [
        [{ key: "a", label: "A", type: "select", default: "z", options: [{ value: "a" }] }],
        /not one of the options/,
      ],
    ];
    for (const [input, re] of bad) {
      expect(() => validateSettingSpecs(input), JSON.stringify(input)).toThrow(re);
    }
  });

  it("caps how many knobs a game can demand", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      key: `k${i}`,
      label: `K${i}`,
      type: "boolean",
      default: false,
    }));
    expect(() => validateSettingSpecs(many)).toThrow(/at most 12/);
  });
});

describe("coerceSetting", () => {
  it("clamps numbers into range", () => {
    expect(coerceSetting(num(), 99)).toBe(10);
    expect(coerceSetting(num(), -5)).toBe(1);
    expect(coerceSetting(num(), 7)).toBe(7);
  });

  it("snaps to the author's step, anchored at min", () => {
    // 1..10 step 2 means odd numbers, not even ones.
    const spec = num({ min: 1, max: 10, step: 2 });
    expect(coerceSetting(spec, 4)).toBe(5);
    expect(coerceSetting(spec, 6)).toBe(7);
  });

  it("does not emit float noise", () => {
    const spec = num({ default: 0.5, min: 0, max: 1, step: 0.1 });
    expect(coerceSetting(spec, 0.30000000000000004)).toBe(0.3);
  });

  it("takes numeric strings, since that is what inputs produce", () => {
    expect(coerceSetting(num(), "7")).toBe(7);
    expect(coerceSetting(num(), "abc")).toBe(null);
    expect(coerceSetting(num(), NaN)).toBe(null);
  });

  it("accepts booleans and their string forms", () => {
    const spec: SettingSpec = { key: "b", label: "B", type: "boolean", default: false };
    expect(coerceSetting(spec, true)).toBe(true);
    expect(coerceSetting(spec, "false")).toBe(false);
    expect(coerceSetting(spec, 1)).toBe(null);
  });

  it("refuses a select value that is not on the menu", () => {
    expect(coerceSetting(sel, "easy")).toBe("easy");
    expect(coerceSetting(sel, "impossible")).toBe(null);
  });
});

describe("resolveSettings", () => {
  const specs = [num(), sel];

  it("fills in defaults for anything unset", () => {
    expect(resolveSettings(specs, undefined)).toEqual({ rounds: 5, difficulty: "normal" });
  });

  it("applies stored overrides", () => {
    expect(resolveSettings(specs, { rounds: 8 })).toEqual({ rounds: 8, difficulty: "normal" });
  });

  it("falls back to the default when a stored value is no longer valid", () => {
    // The author narrowed the range, or the file was hand-edited.
    expect(resolveSettings(specs, { difficulty: "impossible" }).difficulty).toBe("normal");
  });

  it("drops keys the game no longer declares", () => {
    const out = resolveSettings(specs, { rounds: 8, removedSetting: 3 });
    expect(out).not.toHaveProperty("removedSetting");
  });

  it("always returns every declared key, so games need not default again", () => {
    expect(Object.keys(resolveSettings(specs, {})).sort()).toEqual(["difficulty", "rounds"]);
  });
});

describe("summaries", () => {
  it("lists only what differs from default", () => {
    expect(changedSettings([num(), sel], { rounds: 5 })).toEqual([]);
    const changed = changedSettings([num(), sel], { rounds: 8, difficulty: "easy" });
    expect(changed.map((c) => c.spec.key)).toEqual(["rounds", "difficulty"]);
  });

  it("formats values for humans, not for JSON", () => {
    expect(formatSetting({ key: "b", label: "B", type: "boolean", default: false }, true)).toBe("on");
    expect(formatSetting(sel, "easy")).toBe("Easy");
    expect(formatSetting(num(), 8)).toBe("8");
  });
});
