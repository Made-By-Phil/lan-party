import { describe, expect, it } from "vitest";
import { stickDirection, type Dir4 } from "../src/controls.tsx";

const R = 100; // pad radius in px

describe("stickDirection", () => {
  it("returns null inside the dead zone", () => {
    expect(stickDirection(0, 0, R, null)).toBe(null);
    expect(stickDirection(10, 10, R, null)).toBe(null); // |v| ~14 < 30
  });

  it("leaves the dead zone at the configured fraction of the radius", () => {
    expect(stickDirection(0, 25, R, null)).toBe(null);
    expect(stickDirection(0, 35, R, null)).toBe("down");
    // A wider dead zone swallows the same offset.
    expect(stickDirection(0, 35, R, null, 0.5)).toBe(null);
  });

  it("maps the four cardinals, with screen-space y pointing down", () => {
    expect(stickDirection(0, -60, R, null)).toBe("up");
    expect(stickDirection(0, 60, R, null)).toBe("down");
    expect(stickDirection(-60, 0, R, null)).toBe("left");
    expect(stickDirection(60, 0, R, null)).toBe("right");
  });

  it("holds the current axis near the diagonal instead of chattering", () => {
    // Just past 45° toward vertical, but already moving right: hysteresis holds.
    expect(stickDirection(50, 55, R, "right")).toBe("right");
    // From a standstill the same offset reads as down.
    expect(stickDirection(50, 55, R, null)).toBe("down");
    // Clearly vertical: the stick does switch.
    expect(stickDirection(50, 90, R, "right")).toBe("down");
  });

  it("is symmetric — hysteresis holds a vertical direction too", () => {
    expect(stickDirection(55, 50, R, "down")).toBe("down");
    expect(stickDirection(90, 50, R, "down")).toBe("right");
  });

  it("never traps the player in a direction they can't leave", () => {
    // Every held direction must be escapable by pushing the opposite way.
    const opposite: Record<Dir4, [number, number]> = {
      up: [0, 80],
      down: [0, -80],
      left: [80, 0],
      right: [-80, 0],
    };
    const expected: Record<Dir4, Dir4> = {
      up: "down",
      down: "up",
      left: "right",
      right: "left",
    };
    for (const dir of ["up", "down", "left", "right"] as Dir4[]) {
      const [dx, dy] = opposite[dir];
      expect(stickDirection(dx, dy, R, dir)).toBe(expected[dir]);
    }
  });

  it("guards against a zero-sized pad", () => {
    expect(stickDirection(5, 5, 0, null)).toBe(null);
  });
});
