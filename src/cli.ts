#!/usr/bin/env node
import { startServer } from "./server/index.ts";

const HELP = `
lan-party — host quick local-multiplayer browser games on your LAN

Usage: lan-party [options]

Options:
  --port <n>          Port to listen on (default 4700)
  --games-dir <path>  Extra games directory (default ./games if present;
                      merged with the bundled games, yours win on id clash)
  --no-shared-visual  Never offer the shared-visual role on the connect screen
  --fresh             Ignore any saved session and start a new party
  -h, --help          Show this help
`;

function parseArgs(argv: string[]) {
  const cfg = {
    port: 4700,
    gamesDir: null as string | null,
    allowShared: true,
    fresh: false,
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0 || v > 65535) {
          console.error(`Invalid port: ${argv[i]}`);
          process.exit(1);
        }
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

const server = await startServer(parseArgs(process.argv.slice(2)));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
