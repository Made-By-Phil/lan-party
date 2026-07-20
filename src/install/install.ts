// The single install pipeline (decision 30): fetch -> verify -> validate ->
// place. Every source form is reduced to "a directory of game files" before
// anything else happens, so validation and placement have exactly one path.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GameManifest } from "../shared/types.ts";
import { buildGames, loadGameDef, type GameDef } from "../server/games.ts";
import { smokeTestGame } from "../server/validate.ts";
import {
  fetchRegistry,
  findEntry,
  githubTarball,
  parseSource,
  type GameSource,
} from "./source.ts";

export interface InstallOptions {
  /** Where installed games are placed. Always ./games (decision: enforced). */
  gamesDir: string;
  /** Host state dir, holds the lockfile. */
  dataDir: string;
  shellDir: string;
  /** Required for uncurated network sources. */
  trust?: boolean;
  /** Skip the runtime smoke test (still validates and builds). */
  skipSmoke?: boolean;
}

export interface InstallResult {
  id: string;
  name: string;
  dir: string;
  source: string;
  resolved: string;
  sha256?: string;
}

export interface LockEntry {
  source: string;
  resolved: string;
  sha256?: string;
  dir: string;
  engine?: string;
  installedAt: string;
}

interface Lockfile {
  games: Record<string, LockEntry>;
}

const lockPath = (dataDir: string) => join(dataDir, "installed.json");

export function readLockfile(dataDir: string): Lockfile {
  try {
    const data = JSON.parse(readFileSync(lockPath(dataDir), "utf8")) as Lockfile;
    if (data && typeof data === "object" && data.games) return data;
  } catch {
    // absent or corrupt — treat as empty, it is a cache of facts we can rebuild
  }
  return { games: {} };
}

function writeLockfile(dataDir: string, lock: Lockfile): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lockPath(dataDir), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Folder name for an installed game: derived from the id, so it is unique. */
export const folderFor = (id: string): string => id.replace("/", "__");

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", (e) => rej(new Error(`${cmd} failed to start: ${e.message}`)));
    p.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`)),
    );
  });
}

async function extract(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    // No zip support in Node; bsdtar (macOS/Windows) handles zip, GNU tar does not.
    try {
      await run("tar", ["-xf", archive, "-C", into]);
      return;
    } catch {
      await run("unzip", ["-q", archive, "-d", into]);
      return;
    }
  }
  await run("tar", ["-xzf", archive, "-C", into]);
}

/**
 * Archives from GitHub wrap everything in `repo-ref/`, so the manifest lands one
 * level too deep. Descend through single-directory wrappers until a game.json
 * appears — without this, every GitHub install fails confusingly.
 */
function flatten(dir: string, depth = 4): string {
  let cur = dir;
  for (let i = 0; i < depth; i++) {
    if (existsSync(join(cur, "game.json"))) return cur;
    const entries = readdirSync(cur, { withFileTypes: true }).filter(
      (e) => !e.name.startsWith("."),
    );
    const dirs = entries.filter((e) => e.isDirectory());
    if (entries.length === 1 && dirs.length === 1) {
      cur = join(cur, dirs[0]!.name);
      continue;
    }
    break;
  }
  return cur;
}

async function download(url: string, into: string): Promise<{ file: string; sha256: string }> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw new Error(`download failed (${url}): ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = join(into, /\.zip$/i.test(url) ? "game.zip" : "game.tar.gz");
  writeFileSync(file, buf);
  return { file, sha256: createHash("sha256").update(buf).digest("hex") };
}

/** Reduce any source to a local directory containing game.json. */
async function materialize(
  src: GameSource,
  work: string,
): Promise<{ dir: string; resolved: string; sha256?: string }> {
  if (src.kind === "local") {
    const from = resolve(src.location!);
    if (!existsSync(from)) throw new Error(`no such path: ${from}`);
    if (statSync(from).isDirectory()) {
      const dest = join(work, "src");
      cpSync(from, dest, { recursive: true });
      return { dir: flatten(dest), resolved: from };
    }
    const out = join(work, "unpacked");
    await extract(from, out);
    return { dir: flatten(out), resolved: from };
  }

  let url: string;
  let expected: string | undefined;
  let subdir = src.subdir;

  if (src.kind === "registry") {
    const entry = findEntry(await fetchRegistry(), src.id!);
    url = entry.tarball;
    expected = entry.sha256;
    // The curated repo ships every game in one tarball; the index says which
    // folder to take.
    subdir = entry.subdir;
  } else if (src.kind === "github") {
    url = githubTarball(src);
  } else {
    url = src.location!;
  }

  const { file, sha256 } = await download(url, work);
  if (expected && expected !== sha256) {
    throw new Error(
      `checksum mismatch for ${url}\n  expected ${expected}\n  got      ${sha256}\nRefusing to install.`,
    );
  }
  const out = join(work, "unpacked");
  await extract(file, out);
  // flatten() stops at the repo root for a monorepo (many entries, no
  // game.json), which is exactly where a subdir path is anchored.
  let dir = flatten(out);
  if (subdir) {
    const candidate = join(dir, subdir);
    if (!existsSync(join(candidate, "game.json"))) {
      throw new Error(`no game.json under "${subdir}" in ${url}`);
    }
    dir = candidate;
  }
  return { dir, resolved: url, sha256 };
}

export interface ValidationReport {
  def: GameDef;
  warnings: string[];
}

/**
 * Validate a game folder the way the host will: manifest, engine range, a real
 * build, and (unless skipped) a smoke test in a child process. This is the same
 * check the CLI's `validate` runs, so "it installed" and "it passes validate"
 * can never disagree.
 */
export async function validateGameDir(
  dir: string,
  shellDir: string,
  opts: { skipSmoke?: boolean } = {},
): Promise<ValidationReport> {
  const def = loadGameDef(dir);
  const warnings: string[] = [];
  if (!def.manifest.engine) {
    warnings.push('no "engine" range in game.json — it may break on a future host');
  }

  const work = mkdtempSync(join(tmpdir(), "lp-validate-"));
  try {
    const report = await buildGames([def], shellDir, join(work, "build"));
    if (report.failed.length > 0) throw new Error(report.failed[0]!.reason);
    if (!opts.skipSmoke) {
      const built = report.builtServers.get(def.manifest.id);
      if (!built) throw new Error("game server did not build");
      const smoke = await smokeTestGame(built, def.manifest);
      if (!smoke.ok) throw new Error(`smoke test failed — ${smoke.reason}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { def, warnings };
}

export async function installGame(
  spec: string,
  opts: InstallOptions,
): Promise<InstallResult & { warnings: string[]; replaced: boolean }> {
  const src = parseSource(spec);
  if (src.requiresTrust && !opts.trust) {
    throw new Error(
      `"${spec}" is not from the curated registry.\n` +
        `Installing it runs its code on this machine with full access to your files and network.\n` +
        `Re-run with --trust if you know where it came from.`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), "lp-install-"));
  try {
    const { dir, resolved, sha256 } = await materialize(src, work);
    const { def, warnings } = await validateGameDir(dir, opts.shellDir, {
      skipSmoke: opts.skipSmoke,
    });

    const manifest: GameManifest = def.manifest;
    const folder = folderFor(manifest.id);
    const dest = join(opts.gamesDir, folder);
    const replaced = existsSync(dest);

    // Stage beside the target and swap, so a failure part-way cannot leave a
    // half-written game where the host will try to load one.
    mkdirSync(opts.gamesDir, { recursive: true });
    const staged = `${dest}.incoming`;
    rmSync(staged, { recursive: true, force: true });
    cpSync(dir, staged, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staged, dest);

    const lock = readLockfile(opts.dataDir);
    lock.games[manifest.id] = {
      source: spec,
      resolved,
      sha256,
      dir: folder,
      engine: manifest.engine,
      installedAt: new Date().toISOString(),
    };
    writeLockfile(opts.dataDir, lock);

    return {
      id: manifest.id,
      name: manifest.name,
      dir: dest,
      source: spec,
      resolved,
      sha256,
      warnings,
      replaced,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function removeGame(id: string, opts: { gamesDir: string; dataDir: string }): boolean {
  const lock = readLockfile(opts.dataDir);
  const entry = lock.games[id];
  const folder = entry?.dir ?? folderFor(id);
  const dir = join(opts.gamesDir, folder);
  const existed = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  if (entry) {
    delete lock.games[id];
    writeLockfile(opts.dataDir, lock);
  }
  return existed;
}
