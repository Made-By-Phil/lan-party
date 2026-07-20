// Parsing and resolving game sources (decision 30).
//
// Every source form funnels into the same install pipeline; they differ only
// in how they produce a directory of game files.

export type SourceKind = "registry" | "github" | "url" | "local";

export interface GameSource {
  kind: SourceKind;
  /** Exactly what the user typed, for messages. */
  spec: string;
  /** registry: the (possibly bare) game id being asked for. */
  id?: string;
  owner?: string;
  repo?: string;
  /** Sub-path within a repo, for monorepos of games. */
  subdir?: string;
  /** Branch, tag or commit SHA. */
  ref?: string;
  /** url/local: where it lives. */
  location?: string;
  /**
   * True when installing this runs code fetched from an uncurated place.
   * The trust boundary is the network: local paths are already in the user's
   * hands (they could copy the folder into games/ themselves, which runs it
   * with no prompt), and the curated registry is reviewed. Everything else
   * needs an explicit --trust.
   */
  requiresTrust: boolean;
}

const BARE_ID = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/i;
const GITHUB = /^github:([^/#]+)\/([^/#]+)(?:\/([^#]+))?(?:#(.+))?$/i;

const CURATED = "https://raw.githubusercontent.com/Made-By-Phil/lan-party-games/main";

/**
 * Read at call time, not at import: a module-level constant would freeze
 * whatever the environment happened to be when this file was first loaded.
 */
export const registryBase = (): string => process.env.LAN_PARTY_REGISTRY || CURATED;

export function parseSource(spec: string): GameSource {
  const s = spec.trim();
  if (!s) throw new Error("no game specified");

  const gh = GITHUB.exec(s);
  if (gh) {
    return {
      kind: "github",
      spec: s,
      owner: gh[1]!,
      repo: gh[2]!,
      subdir: gh[3],
      ref: gh[4] ?? "HEAD",
      requiresTrust: true,
    };
  }

  if (/^https?:\/\//i.test(s)) {
    return { kind: "url", spec: s, location: s, requiresTrust: true };
  }

  // Anything path-shaped, or an existing file, is local.
  if (/^[.~]|^\//.test(s) || /\.(tar\.gz|tgz|zip)$/i.test(s)) {
    return { kind: "local", spec: s, location: s, requiresTrust: false };
  }

  if (BARE_ID.test(s)) {
    return { kind: "registry", spec: s, id: s.toLowerCase(), requiresTrust: false };
  }

  throw new Error(
    `cannot understand source "${spec}" — expected a game name, github:owner/repo, an https tarball URL, or a local path`,
  );
}

/** Codeload serves a repo (or ref) as a gzipped tarball with no API token. */
export function githubTarball(src: GameSource): string {
  return `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${src.ref}`;
}

export interface RegistryEntry {
  id: string;
  name?: string;
  description?: string;
  /** Tarball to download. */
  tarball: string;
  /** Expected digest; when present the download must match. */
  sha256?: string;
  engine?: string;
}

export interface RegistryIndex {
  games: RegistryEntry[];
}

export async function fetchRegistry(base = registryBase()): Promise<RegistryIndex> {
  const url = `${base.replace(/\/$/, "")}/games.json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not reach the game registry (${url}): ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`game registry returned ${res.status} for ${url}`);
  const data = (await res.json()) as RegistryIndex;
  if (!data || !Array.isArray(data.games)) throw new Error(`game registry at ${url} is malformed`);
  return data;
}

/**
 * Look up a registry entry by full id (`scope/name`) or bare name, provided the
 * bare name is unambiguous — refusing rather than guessing when it is not.
 */
export function findEntry(index: RegistryIndex, wanted: string): RegistryEntry {
  const id = wanted.toLowerCase();
  const exact = index.games.find((g) => g.id.toLowerCase() === id);
  if (exact) return exact;

  const byName = index.games.filter((g) => g.id.toLowerCase().split("/")[1] === id);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `"${wanted}" is ambiguous — ${byName.map((g) => g.id).join(", ")}. Use the full id.`,
    );
  }
  throw new Error(`no game named "${wanted}" in the registry`);
}
