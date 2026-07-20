import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { engineMismatch, satisfiesEngine } from "../engine.ts";
import type { CreateGame } from "../sdk.ts";
import type { GameManifest } from "../shared/types.ts";
import { packageRoot } from "./paths.ts";

export interface GameDef {
  manifest: GameManifest;
  dir: string;
  serverEntry: string;
  clientEntry: string;
  sharedEntry: string | null;
}

const SDK_PATH = join(packageRoot(), "src/sdk.ts");
const CONTROLS_PATH = join(packageRoot(), "src/controls.tsx");

/**
 * Scan a games directory: every subfolder with a game.json is a candidate.
 * Invalid games are skipped with a warning, never fatal — one broken download
 * shouldn't take the party down.
 */
/**
 * Validate a single game folder. Throws with a human-readable reason — used by
 * discovery (which downgrades it to a warning) and by the installer (which
 * refuses the install and shows it to the user).
 */
export function loadGameDef(dir: string, folderName?: string): GameDef {
  const manifestPath = join(dir, "game.json");
  if (!existsSync(manifestPath)) throw new Error("no game.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`game.json is not valid JSON: ${(err as Error).message}`);
  }
  const manifest = validateManifest(raw, folderName ?? basename(dir));
  const serverEntry = findEntry(dir, ["server.ts", "server.tsx"]);
  const clientEntry = findEntry(dir, ["client.tsx", "client.ts"]);
  if (!serverEntry || !clientEntry) throw new Error("missing server.ts or client.tsx");
  const sharedEntry = findEntry(dir, ["shared.tsx", "shared.ts"]);
  if (manifest.displayMode === "shared-arena" && !sharedEntry) {
    throw new Error('displayMode "shared-arena" requires a shared.tsx');
  }
  return { manifest, dir, serverEntry, clientEntry, sharedEntry };
}

export function discoverGames(gamesDir: string): GameDef[] {
  if (!existsSync(gamesDir)) return [];
  const defs: GameDef[] = [];
  for (const entry of readdirSync(gamesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(gamesDir, entry.name);
    if (!existsSync(join(dir, "game.json"))) continue;
    try {
      defs.push(loadGameDef(dir, entry.name));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`[lan-party] skipping game "${entry.name}": ${why}`);
    }
  }
  return defs;
}

function findEntry(dir: string, names: string[]): string | null {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Game ids are namespaced `scope/name` (decision 36) so two unrelated authors
 * can both ship a "trivia" without colliding.
 *
 * A bare id is scoped to `local/`, which keeps dropping an unpublished folder
 * into games/ frictionless while still guaranteeing every id is namespaced —
 * so a local sketch can never shadow an installed game by accident.
 */
export function normalizeGameId(raw: unknown, folder: string): string {
  const input = (typeof raw === "string" && raw.trim() ? raw.trim() : folder).toLowerCase();
  const parts = input.split("/");
  if (parts.length === 1) parts.unshift("local");
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p))) {
    throw new Error(
      `invalid id "${input}" — use "scope/name" with lowercase letters, digits and dashes`,
    );
  }
  return parts.join("/");
}

function validateManifest(raw: any, folder: string): GameManifest {
  const engine = typeof raw.engine === "string" && raw.engine.trim() ? raw.engine.trim() : undefined;
  if (engine && !satisfiesEngine(engine)) throw new Error(engineMismatch(engine));
  const id = normalizeGameId(raw.id, folder);
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  const teams = ["none", "optional", "required"].includes(raw.teams)
    ? raw.teams
    : "none";
  const displayMode = ["device", "shared-arena", "adaptive"].includes(raw.displayMode)
    ? raw.displayMode
    : "device";
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new Error("game.json needs a name");
  }
  return {
    id,
    name: raw.name.trim(),
    description: typeof raw.description === "string" ? raw.description : "",
    minPlayers: Math.max(1, num(raw.minPlayers, 1)),
    maxPlayers: Math.max(1, num(raw.maxPlayers, 16)),
    teams,
    tickRate: Math.min(60, num(raw.tickRate, 0)),
    displayMode,
    engine,
  };
}

/**
 * Merge bundled and user games into one catalog; on id collision the user's
 * game wins (lets people fork/override a bundled game by dropping in a folder).
 */
export function mergeCatalogs(bundled: GameDef[], user: GameDef[]): GameDef[] {
  const byId = new Map<string, GameDef>();
  for (const d of [...bundled, ...user]) byId.set(d.manifest.id, d);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Building. One esbuild pass per game server module (imported by the host),
// one pass for the client app: shell + every game's client/shared components
// in a single bundle sharing a single React instance.
// ---------------------------------------------------------------------------

const COMMON: esbuild.BuildOptions = {
  bundle: true,
  format: "esm",
  jsx: "automatic",
  sourcemap: "linked",
  logLevel: "silent",
  alias: { "lan-party/sdk": SDK_PATH, "lan-party/sdk/controls": CONTROLS_PATH },
  // Game folders live anywhere (--games-dir) and have no node_modules of their
  // own; resolve react etc. from the framework's install.
  nodePaths: [join(packageRoot(), "node_modules")],
};

export interface BuildFailure {
  id: string;
  name: string;
  reason: string;
}

export interface BuildReport {
  /** Games that compiled cleanly and are safe to serve. */
  ok: GameDef[];
  /** Games dropped from this party, and why. */
  failed: BuildFailure[];
  /** id -> built server module path, for the surviving games only. */
  builtServers: Map<string, string>;
}

/** File name is derived from the id, which may be namespaced (`author/game`). */
const serverOutfile = (buildDir: string, id: string): string =>
  join(buildDir, `${id.replace(/[^a-z0-9._-]/gi, "_")}.server.mjs`);

async function buildOneServer(def: GameDef, buildDir: string): Promise<string> {
  const outfile = serverOutfile(buildDir, def.manifest.id);
  await esbuild.build({
    ...COMMON,
    entryPoints: [def.serverEntry],
    platform: "node",
    packages: "external",
    outfile,
  });
  return outfile;
}

/** Compile one game's client (and shared) alone, to see whether it is the bad apple. */
async function probeClient(
  def: GameDef,
  shellDir: string,
  buildDir: string,
): Promise<void> {
  const imports = [`import ${JSON.stringify(def.clientEntry)};`];
  if (def.sharedEntry) imports.push(`import ${JSON.stringify(def.sharedEntry)};`);
  await esbuild.build({
    ...COMMON,
    stdin: {
      contents: imports.join("\n"),
      resolveDir: shellDir,
      sourcefile: "probe.tsx",
      loader: "tsx",
    },
    platform: "browser",
    // Nothing is written, but esbuild still needs an output path configured to
    // resolve CSS and asset imports, and the inherited linked source map needs
    // somewhere to point.
    outdir: join(buildDir, ".probe"),
    sourcemap: false,
    write: false,
  });
}

const reasonOf = (err: unknown): string =>
  String((err as { message?: string })?.message ?? err)
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 3)
    .join(" ");

/**
 * Build every game, isolating failures. A game whose server or client fails to
 * compile is dropped from the catalog with a warning rather than taking the
 * whole party down (decision 28) — the host must survive one bad download.
 */
export async function buildGames(
  defs: GameDef[],
  shellDir: string,
  buildDir: string,
): Promise<BuildReport> {
  mkdirSync(buildDir, { recursive: true });
  const failed: BuildFailure[] = [];
  const builtServers = new Map<string, string>();
  const drop = (def: GameDef, reason: string) =>
    failed.push({ id: def.manifest.id, name: def.manifest.name, reason });

  let survivors: GameDef[] = [];
  for (const def of defs) {
    try {
      builtServers.set(def.manifest.id, await buildOneServer(def, buildDir));
      survivors.push(def);
    } catch (err) {
      drop(def, reasonOf(err));
    }
  }

  // Fast path: one combined bundle, as before. Only when that fails do we pay
  // for per-game probing to find which game is at fault.
  try {
    await bundleClient(survivors, shellDir, buildDir);
  } catch (combinedErr) {
    const good: GameDef[] = [];
    for (const def of survivors) {
      try {
        await probeClient(def, shellDir, buildDir);
        good.push(def);
      } catch (err) {
        drop(def, reasonOf(err));
        builtServers.delete(def.manifest.id);
      }
    }
    // Every game compiles alone, so the fault is in the shell or the entry
    // glue — that is our bug, not a bad download, and must be loud.
    if (good.length === survivors.length) throw combinedErr;
    survivors = good;
    await bundleClient(survivors, shellDir, buildDir);
  }

  return { ok: survivors, failed, builtServers };
}

export async function loadGameServer(builtFile: string): Promise<CreateGame> {
  // Cache-bust so a host restart after editing a game picks up new code.
  const mod = await import(`${pathToFileURL(builtFile).href}?t=${Date.now()}`);
  if (typeof mod.default !== "function") {
    throw new Error(`${builtFile} must default-export a createGame(ctx) function`);
  }
  return mod.default as CreateGame;
}

async function bundleClient(
  defs: GameDef[],
  shellDir: string,
  buildDir: string,
): Promise<void> {
  mkdirSync(buildDir, { recursive: true });
  const imports: string[] = [
    `import { boot } from ${JSON.stringify(join(shellDir, "boot.tsx"))};`,
  ];
  const entries: string[] = [];
  defs.forEach((def, i) => {
    imports.push(`import c${i} from ${JSON.stringify(def.clientEntry)};`);
    imports.push(`import m${i} from ${JSON.stringify(join(def.dir, "game.json"))};`);
    if (def.sharedEntry) {
      imports.push(`import s${i} from ${JSON.stringify(def.sharedEntry)};`);
    }
    entries.push(
      `{ manifest: m${i}, Client: c${i}, Shared: ${def.sharedEntry ? `s${i}` : "null"} }`,
    );
  });
  const entry = `${imports.join("\n")}\nboot([${entries.join(", ")}]);\n`;
  await esbuild.build({
    ...COMMON,
    stdin: {
      contents: entry,
      resolveDir: shellDir,
      sourcefile: "app-entry.tsx",
      loader: "tsx",
    },
    platform: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: join(buildDir, "app.js"),
  });
}
