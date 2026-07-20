import { useState } from "react";
import {
  changedSettings,
  formatSetting,
  resolveSettings,
} from "../src/shared/settings.ts";
import type { AdminOp, GameManifest, SettingSpec } from "../src/shared/types.ts";
import { store, useClient } from "./store.ts";

function admin(op: AdminOp) {
  store.send({ type: "lobby.admin", admin: op });
}

/**
 * One line of "what's different from default", shown to everyone — you should
 * know what you're voting for, not just whoever can edit it.
 */
export function SettingsSummary({ manifest }: { manifest: GameManifest }) {
  const client = useClient();
  const changed = changedSettings(manifest.settings, client.session?.settings?.[manifest.id]);
  if (changed.length === 0) return null;
  return (
    <p className="muted small settings-summary">
      {changed.map(({ spec, value }) => `${spec.label}: ${formatSetting(spec, value)}`).join(" · ")}
    </p>
  );
}

function Field({
  gameId,
  spec,
  value,
  disabled,
}: {
  gameId: string;
  spec: SettingSpec;
  value: string | number | boolean;
  disabled: boolean;
}) {
  const set = (v: string | number | boolean) =>
    admin({ op: "setSetting", gameId, key: spec.key, value: v });

  return (
    <label className="setting-field">
      <span className="setting-label">{spec.label}</span>

      {spec.type === "boolean" && (
        <input
          type="checkbox"
          checked={value as boolean}
          disabled={disabled}
          onChange={(e) => set(e.target.checked)}
        />
      )}

      {spec.type === "number" && (
        <span className="setting-number">
          <input
            type="range"
            min={spec.min ?? 0}
            max={spec.max ?? 100}
            step={spec.step ?? 1}
            value={value as number}
            disabled={disabled}
            onChange={(e) => set(Number(e.target.value))}
          />
          <output>{value as number}</output>
        </span>
      )}

      {spec.type === "select" && (
        <select value={value as string} disabled={disabled} onChange={(e) => set(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {spec.help && <span className="muted small setting-help">{spec.help}</span>}
    </label>
  );
}

/**
 * Per-game settings panel for whoever holds admin. The controls are generated
 * from the manifest, so a game declares knobs as data and ships no UI for them,
 * and the form can only offer values the host would accept.
 */
export function GameSettingsPanel({ manifest }: { manifest: GameManifest }) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const specs = manifest.settings ?? [];
  if (specs.length === 0) return null;

  const values = resolveSettings(specs, client.session?.settings?.[manifest.id]);
  // Locked mid-round: the host refuses the change anyway, so don't offer it.
  const locked = client.session?.phase !== "lobby";
  const changed = changedSettings(specs, client.session?.settings?.[manifest.id]);

  return (
    <div className="game-settings">
      <button className="ghost tiny" onClick={() => setOpen(!open)}>
        ⚙ Settings{changed.length > 0 ? ` (${changed.length})` : ""}
      </button>
      {open && (
        <div className="settings-panel">
          {specs.map((spec) => (
            <Field
              key={spec.key}
              gameId={manifest.id}
              spec={spec}
              value={values[spec.key]!}
              disabled={locked}
            />
          ))}
          <div className="row">
            {locked && <span className="muted small">Locked while a round is running.</span>}
            {!locked && changed.length > 0 && (
              <button
                className="ghost tiny"
                onClick={() => admin({ op: "resetSettings", gameId: manifest.id })}
              >
                Reset to defaults
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
