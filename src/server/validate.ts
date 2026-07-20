import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GameManifest } from "../shared/types.ts";
import { resolveSettings } from "../shared/settings.ts";
import { packageRoot } from "./paths.ts";

export interface SmokeResult {
  ok: boolean;
  /** Present when ok is false. One-line-ish, safe to print to a terminal. */
  reason?: string;
  /** Largest JSON public state seen, in bytes. */
  snapshotBytes?: number;
}

/**
 * Every client receives the whole public state on every tick, so at 20 Hz a
 * 9 KB snapshot is 180 KB/s per device — and a party has a phone per person
 * plus a TV. Above this, the game should move TV-only data into
 * getSharedState() or stop sending the whole world every frame.
 */
export const SNAPSHOT_BUDGET_BYTES = 2048;

/** Bytes per second this snapshot costs one client at the game's tick rate. */
export const perClientBytesPerSecond = (bytes: number, tickRate: number): number =>
  bytes * Math.max(1, tickRate);

const OK = "__LP_SMOKE_OK__";

/**
 * Run a built game server in a child process and check it behaves.
 *
 * A child process rather than an in-process call, for two reasons: a game that
 * calls process.exit() or spins forever would otherwise take the host with it,
 * and only a separate process can tell us whether the game *exits cleanly*.
 * The child never calls process.exit() on success, so a leaked timer or open
 * handle shows up here as a timeout — which is the failure we most want to
 * catch before a game reaches a live party.
 */
export async function smokeTestGame(
  builtServerPath: string,
  manifest: GameManifest,
  timeoutMs = 5000,
  settings?: Record<string, unknown>,
): Promise<SmokeResult> {
  const child = spawn(
    process.execPath,
    [
      join(packageRoot(), "src/server/smoke-child.ts"),
      pathToFileURL(builtServerPath).href,
      JSON.stringify({
        minPlayers: manifest.minPlayers,
        tickRate: manifest.tickRate,
        settings: settings ?? resolveSettings(manifest.settings, undefined),
      }),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));

  return await new Promise<SmokeResult>((resolve) => {
    let settled = false;
    const done = (result: SmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({
        ok: false,
        reason: out.includes(OK)
          ? `did not exit within ${timeoutMs}ms — a timer or handle is still open after the round`
          : `did not finish within ${timeoutMs}ms — infinite loop or blocked tick`,
      });
    }, timeoutMs);

    child.on("error", (e) => done({ ok: false, reason: `could not run smoke test: ${e.message}` }));
    child.on("exit", (code) => {
      if (code === 0 && out.includes(OK)) {
        let snapshotBytes: number | undefined;
        try {
          snapshotBytes = JSON.parse(out.slice(out.indexOf(OK) + OK.length)).snapshotBytes;
        } catch {
          // Older child or truncated output — size is a warning, not a gate.
        }
        return done({ ok: true, snapshotBytes });
      }
      const reason = err.trim() || `smoke test exited with code ${code}`;
      done({ ok: false, reason: reason.split("\n").slice(0, 4).join(" ") });
    });
  });
}
