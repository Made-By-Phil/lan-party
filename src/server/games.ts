import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
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

/**
 * Scan a games directory: every subfolder with a game.json is a candidate.
 * Invalid games are skipped with a warning, never fatal — one broken download
 * shouldn't take the party down.
 */
export function discoverGames(gamesDir: string): GameDef[] {
  if (!existsSync(gamesDir)) return [];
  const defs: GameDef[] = [];
  for (const entry of readdirSync(gamesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(gamesDir, entry.name);
    const manifestPath = join(dir, "game.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      const manifest = validateManifest(raw, entry.name);
      const serverEntry = findEntry(dir, ["server.ts", "server.tsx"]);
      const clientEntry = findEntry(dir, ["client.tsx", "client.ts"]);
      if (!serverEntry || !clientEntry) {
        throw new Error("missing server.ts or client.tsx");
      }
      const sharedEntry = findEntry(dir, ["shared.tsx", "shared.ts"]);
      if (manifest.displayMode === "shared-arena" && !sharedEntry) {
        throw new Error('displayMode "shared-arena" requires a shared.tsx');
      }
      defs.push({ manifest, dir, serverEntry, clientEntry, sharedEntry });
    } catch (err) {
      console.warn(`[lan-party] skipping game "${entry.name}": ${err}`);
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

function validateManifest(raw: any, folder: string): GameManifest {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : folder;
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
  alias: { "lan-party/sdk": SDK_PATH },
};

export async function buildGameServers(
  defs: GameDef[],
  buildDir: string,
): Promise<Map<string, string>> {
  mkdirSync(buildDir, { recursive: true });
  const out = new Map<string, string>();
  for (const def of defs) {
    const outfile = join(buildDir, `${def.manifest.id}.server.mjs`);
    await esbuild.build({
      ...COMMON,
      entryPoints: [def.serverEntry],
      platform: "node",
      packages: "external",
      outfile,
    });
    out.set(def.manifest.id, outfile);
  }
  return out;
}

export async function loadGameServer(builtFile: string): Promise<CreateGame> {
  // Cache-bust so a host restart after editing a game picks up new code.
  const mod = await import(`${pathToFileURL(builtFile).href}?t=${Date.now()}`);
  if (typeof mod.default !== "function") {
    throw new Error(`${builtFile} must default-export a createGame(ctx) function`);
  }
  return mod.default as CreateGame;
}

export async function buildClientApp(
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
    outfile: join(buildDir, "app.js"),
  });
}
