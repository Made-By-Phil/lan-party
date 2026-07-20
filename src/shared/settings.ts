// Validation and coercion for declarative game settings.
//
// Dependency-free and pure: the host uses it to police what clients send, and
// the shell uses the same rules to render controls, so the form can never offer
// a value the host would reject.

import type {
  GameSettings,
  NumberSetting,
  SelectSetting,
  SettingSpec,
  SettingValue,
} from "./types.ts";

const KEY = /^[a-z][a-zA-Z0-9_]*$/;

/** A party has limited patience and the shared screen has limited room. */
export const MAX_SETTINGS = 12;

/**
 * Validate a manifest's `settings` block. Throws with an author-facing reason;
 * discovery downgrades that to "skipping game", and `lan-party validate`
 * surfaces it before the game is ever installed.
 */
export function validateSettingSpecs(raw: unknown): SettingSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("settings must be an array");
  if (raw.length > MAX_SETTINGS) {
    throw new Error(`settings: at most ${MAX_SETTINGS} are allowed, got ${raw.length}`);
  }

  const seen = new Set<string>();
  const specs: SettingSpec[] = [];

  for (const [i, entry] of raw.entries()) {
    const at = `settings[${i}]`;
    if (!entry || typeof entry !== "object") throw new Error(`${at} must be an object`);
    const s = entry as Record<string, unknown>;

    const key = String(s.key ?? "");
    if (!KEY.test(key)) {
      throw new Error(`${at}.key "${key}" must start with a letter and be alphanumeric`);
    }
    if (seen.has(key)) throw new Error(`${at}.key "${key}" is declared twice`);
    seen.add(key);

    const label = typeof s.label === "string" && s.label.trim() ? s.label.trim() : "";
    if (!label) throw new Error(`${at}.label is required`);
    const help = typeof s.help === "string" && s.help.trim() ? s.help.trim() : undefined;

    switch (s.type) {
      case "number": {
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const min = num(s.min);
        const max = num(s.max);
        const step = num(s.step);
        const def = num(s.default);
        if (def === undefined) throw new Error(`${at}.default must be a finite number`);
        if (min !== undefined && max !== undefined && min > max) {
          throw new Error(`${at}: min ${min} is greater than max ${max}`);
        }
        if ((min !== undefined && def < min) || (max !== undefined && def > max)) {
          throw new Error(`${at}.default ${def} is outside min/max`);
        }
        if (step !== undefined && step <= 0) throw new Error(`${at}.step must be positive`);
        specs.push({ key, label, help, type: "number", default: def, min, max, step });
        break;
      }
      case "boolean": {
        if (typeof s.default !== "boolean") throw new Error(`${at}.default must be true or false`);
        specs.push({ key, label, help, type: "boolean", default: s.default });
        break;
      }
      case "select": {
        if (!Array.isArray(s.options) || s.options.length === 0) {
          throw new Error(`${at}.options must be a non-empty array`);
        }
        const options = s.options.map((o, j) => {
          const opt = o as Record<string, unknown>;
          const value = typeof opt?.value === "string" ? opt.value : "";
          if (!value) throw new Error(`${at}.options[${j}].value must be a non-empty string`);
          const optLabel = typeof opt.label === "string" && opt.label.trim() ? opt.label.trim() : value;
          return { value, label: optLabel };
        });
        const def = typeof s.default === "string" ? s.default : "";
        if (!options.some((o) => o.value === def)) {
          throw new Error(`${at}.default "${def}" is not one of the options`);
        }
        specs.push({ key, label, help, type: "select", default: def, options });
        break;
      }
      default:
        throw new Error(`${at}.type "${String(s.type)}" must be number, boolean or select`);
    }
  }
  return specs.length > 0 ? specs : undefined;
}

function coerceNumber(spec: NumberSetting, value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  let out = n;
  if (spec.step !== undefined && spec.step > 0) {
    // Snap to the grid the author defined, anchored at min so "1..10 step 2"
    // yields odd numbers rather than even ones.
    const base = spec.min ?? 0;
    out = base + Math.round((out - base) / spec.step) * spec.step;
    // Re-round to kill float drift from repeated division (0.30000000000000004).
    out = Math.round(out * 1e6) / 1e6;
  }
  if (spec.min !== undefined) out = Math.max(spec.min, out);
  if (spec.max !== undefined) out = Math.min(spec.max, out);
  return out;
}

/**
 * Coerce one incoming value against its spec. Returns null when the value is
 * unusable, so the caller can ignore the change rather than store nonsense —
 * clients are untrusted input here as everywhere else.
 */
export function coerceSetting(spec: SettingSpec, value: unknown): SettingValue | null {
  switch (spec.type) {
    case "number":
      return coerceNumber(spec, value);
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return null;
    case "select":
      return (spec as SelectSetting).options.some((o) => o.value === value)
        ? (value as string)
        : null;
  }
}

/**
 * Every declared key with a usable value: stored overrides where valid,
 * defaults everywhere else. Unknown stored keys are dropped, so a game that
 * removes or renames a setting can't be handed a stale one.
 */
export function resolveSettings(
  specs: SettingSpec[] | undefined,
  stored: Record<string, unknown> | undefined,
): GameSettings {
  const out: GameSettings = {};
  for (const spec of specs ?? []) {
    const raw = stored?.[spec.key];
    const coerced = raw === undefined ? null : coerceSetting(spec, raw);
    out[spec.key] = coerced === null ? spec.default : coerced;
  }
  return out;
}

/** Settings differing from their defaults, for a compact "what's set" summary. */
export function changedSettings(
  specs: SettingSpec[] | undefined,
  values: GameSettings | undefined,
): { spec: SettingSpec; value: SettingValue }[] {
  const resolved = resolveSettings(specs, values);
  return (specs ?? [])
    .filter((s) => resolved[s.key] !== s.default)
    .map((spec) => ({ spec, value: resolved[spec.key]! }));
}

/** Human-readable value, e.g. for the lobby summary line. */
export function formatSetting(spec: SettingSpec, value: SettingValue): string {
  if (spec.type === "boolean") return value ? "on" : "off";
  if (spec.type === "select") {
    return spec.options.find((o) => o.value === value)?.label ?? String(value);
  }
  return String(value);
}
