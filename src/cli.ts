#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_VERSION } from "./engine.ts";
import {
  folderFor,
  installGame,
  readLockfile,
  removeGame,
  validateGameDir,
} from "./install/install.ts";
import { discoverGames } from "./server/games.ts";
import { startServer } from "./server/index.ts";
import { packageRoot } from "./server/paths.ts";

const HELP = `
lan-party — host quick local-multiplayer browser games on your LAN

Usage:
  lan-party [options]              Start the party
  lan-party add <source>           Install a game into ./games
  lan-party list                   List installed games
  lan-party remove <id>            Uninstall a game
  lan-party validate <path>        Check a game folder builds and runs

Server options:
  --port <n>          Port to listen on (default 4700)
  --games-dir <path>  Extra games directory (default ./games if present;
                      merged with the bundled games, yours win on id clash)
  --no-shared-visual  Never offer the shared-visual role on the connect screen
  --fresh             Ignore any saved session and start a new party
  -h, --help          Show this help

add <source> accepts:
  trivia                       a game from the curated registry
  someone/trivia               a registry game by full id
  github:owner/repo            a GitHub repo            (needs --trust)
  github:owner/repo/games/x#v2 a folder in a repo, at a ref  (needs --trust)
  https://host/game.tar.gz     a tarball                (needs --trust)
  ./path/to/game               a local folder or archive

add options:
  --trust             Allow installing from outside the curated registry.
                      A game's server code runs on this machine with full
                      access to your files and network — only pass this for
                      sources you actually trust.
  --skip-smoke        Build and validate, but skip the runtime smoke test
`;

const root = packageRoot();
const cwd = process.cwd();
const gamesDir = join(cwd, "games");
const dataDir = join(cwd, ".lan-party");
const shellDir = join(root, "shell");

const die = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

function parseServerArgs(argv: string[]) {
  const cfg = {
    port: 4700,
    gamesDir: null as string | null,
    allowShared: true,
    fresh: false,
    cwd,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0 || v > 65535) die(`Invalid port: ${argv[i]}`);
        cfg.port = v;
        break;
      }
      case "--games-dir":
        cfg.gamesDir = argv[++i] ?? null;
        break;
      case "--no-shared-visual":
        cfg.allowShared = false;
        break;
      case "--fresh":
        cfg.fresh = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.log(HELP);
        process.exit(1);
    }
  }
  return cfg;
}

async function cmdAdd(args: string[]): Promise<void> {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) die("add: what should I install? Try `lan-party add trivia`");

  console.log(`Installing ${spec}…`);
  try {
    const r = await installGame(spec!, {
      gamesDir,
      dataDir,
      shellDir,
      trust: flags.has("--trust"),
      skipSmoke: flags.has("--skip-smoke"),
    });
    for (const w of r.warnings) console.warn(`  ! ${w}`);
    console.log(`✓ ${r.replaced ? "Updated" : "Installed"} ${r.name} (${r.id})`);
    console.log(`  from ${r.resolved}`);
    if (r.sha256) console.log(`  sha256 ${r.sha256.slice(0, 16)}…`);
    console.log(`  into games/${folderFor(r.id)}`);
    console.log(`\nRestart the party (or reload) to pick it up.`);
  } catch (err) {
    die(`could not install ${spec}\n\n${err instanceof Error ? err.message : String(err)}`);
  }
}

function cmdList(): void {
  const lock = readLockfile(dataDir);
  const bundled = discoverGames(join(root, "games"));
  const installed = existsSync(gamesDir) ? discoverGames(gamesDir) : [];

  console.log(`\nEngine ${ENGINE_VERSION}\n`);
  console.log("Bundled:");
  for (const d of bundled) console.log(`  ${d.manifest.id.padEnd(28)} ${d.manifest.name}`);
  console.log("\nInstalled (./games):");
  if (installed.length === 0) {
    console.log("  none — try `lan-party add <name>`");
  }
  for (const d of installed) {
    const from = lock.games[d.manifest.id]?.source ?? "local";
    console.log(`  ${d.manifest.id.padEnd(28)} ${d.manifest.name.padEnd(18)} ${from}`);
  }
  console.log("");
}

function cmdRemove(args: string[]): void {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) die("remove: which game? Try `lan-party list`");
  if (!removeGame(id!, { gamesDir, dataDir })) {
    die(`"${id}" is not installed in ./games (bundled games cannot be removed)`);
  }
  console.log(`✓ Removed ${id}`);
}

async function cmdValidate(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith("--")) ?? ".";
  const dir = resolve(cwd, target);
  try {
    const { def, warnings } = await validateGameDir(dir, shellDir, {
      skipSmoke: args.includes("--skip-smoke"),
    });
    for (const w of warnings) console.warn(`! ${w}`);
    console.log(`✓ ${def.manifest.name} (${def.manifest.id}) builds and runs`);
  } catch (err) {
    die(`${dir}\n\n${err instanceof Error ? err.message : String(err)}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add":
  case "add-game":
    await cmdAdd(rest);
    break;
  case "list":
  case "list-games":
    cmdList();
    break;
  case "remove":
  case "remove-game":
    cmdRemove(rest);
    break;
  case "validate":
    await cmdValidate(rest);
    break;
  default: {
    const server = await startServer(parseServerArgs(process.argv.slice(2)));
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        void server.close().then(() => process.exit(0));
      });
    }
  }
}
