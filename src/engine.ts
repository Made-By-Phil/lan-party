// Engine version and compatibility checking (decision 32).
//
// Deliberately NOT exported from `lan-party/sdk`, which is types-only: games
// declare compatibility as data in game.json, never by importing code.

/**
 * The SDK contract version. Minor bumps on release, major bumps on any
 * breaking SDK change. Kept in lockstep with package.json (asserted by test).
 */
export const ENGINE_VERSION = "0.1.0";

type Triple = [number, number, number];

function parse(v: string): Triple | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

const cmp = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Upper bound for a caret range. npm's 0.x rule matters to us specifically:
 * while the engine is 0.x, every minor bump is allowed to break games, so
 * ^0.1.0 must mean ">=0.1.0 <0.2.0" and not ">=0.1.0 <1.0.0".
 */
function caretUpper([maj, min, pat]: Triple): Triple {
  if (maj > 0) return [maj + 1, 0, 0];
  if (min > 0) return [0, min + 1, 0];
  return [0, 0, pat + 1];
}

/**
 * Does `version` satisfy `range`? Supports the subset a game manifest needs:
 * `*`, `1.x`, `1.2.x`, `^1.2.3`, `~1.2.3`, comparators, and exact versions.
 * An absent range means "unstated", which is treated as compatible — games
 * predate the field and the validator warns about it separately.
 */
export function satisfiesEngine(range: string | undefined | null, version = ENGINE_VERSION): boolean {
  const ver = parse(version);
  if (!ver) return false;
  const r = String(range ?? "").trim();
  if (!r || r === "*" || r === "x") return true;

  const wildcard = /^(\d+)\.(?:x|\*)$|^(\d+)\.(\d+)\.(?:x|\*)$/.exec(r);
  if (wildcard) {
    if (wildcard[1] !== undefined) return ver[0] === Number(wildcard[1]);
    return ver[0] === Number(wildcard[2]) && ver[1] === Number(wildcard[3]);
  }

  const op = /^(>=|<=|>|<|\^|~)?\s*(.+)$/.exec(r);
  if (!op) return false;
  const target = parse(op[2]!);
  if (!target) return false;

  switch (op[1]) {
    case ">=":
      return cmp(ver, target) >= 0;
    case "<=":
      return cmp(ver, target) <= 0;
    case ">":
      return cmp(ver, target) > 0;
    case "<":
      return cmp(ver, target) < 0;
    case "^":
      return cmp(ver, target) >= 0 && cmp(ver, caretUpper(target)) < 0;
    case "~":
      return cmp(ver, target) >= 0 && cmp(ver, [target[0], target[1] + 1, 0]) < 0;
    default:
      return cmp(ver, target) === 0;
  }
}

/** Human-readable reason a game was rejected, for the host console and CLI. */
export function engineMismatch(range: string): string {
  return `needs engine ${range}, but this host is ${ENGINE_VERSION} — update lan-party, or install a matching version of the game`;
}
