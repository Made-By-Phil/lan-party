import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import {
  buildClientApp,
  buildGameServers,
  discoverGames,
  mergeCatalogs,
} from "./games.ts";
import { createHttpServer } from "./http.ts";
import { Hub } from "./hub.ts";
import { packageRoot } from "./paths.ts";
import { printBanner } from "./qr.ts";
import { Session } from "./session.ts";

export interface ServerConfig {
  port: number;
  gamesDir: string | null;
  allowShared: boolean;
  fresh: boolean;
  cwd: string;
  /** Suppress banner/QR (tests). */
  quiet?: boolean;
}

export interface RunningServer {
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const root = packageRoot();
  const dataDir = join(cfg.cwd, ".lan-party");
  const buildDir = join(dataDir, "build");

  // Catalog = bundled games + user games dir (user wins on id collision).
  const bundledDir = join(root, "games");
  const userDir = cfg.gamesDir
    ? resolve(cfg.cwd, cfg.gamesDir)
    : existsSync(join(cfg.cwd, "games")) && join(cfg.cwd, "games") !== bundledDir
      ? join(cfg.cwd, "games")
      : null;
  const bundled = discoverGames(bundledDir);
  const user = userDir && userDir !== bundledDir ? discoverGames(userDir) : [];
  const defs = mergeCatalogs(bundled, user);
  if (defs.length === 0) {
    console.warn("[lan-party] no games found — the lobby will be empty.");
  }

  const t0 = performance.now();
  const builtServers = await buildGameServers(defs, buildDir);
  await buildClientApp(defs, join(root, "shell"), buildDir);
  const buildMs = Math.round(performance.now() - t0);

  const session = Session.load(join(dataDir, "session.json"), cfg.fresh);
  const hub = new Hub(session, defs, builtServers, { allowShared: cfg.allowShared });

  const httpServer = createHttpServer(buildDir);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws, req) => {
    hub.handleConnection(ws, req.socket.remoteAddress ?? undefined);
  });

  await new Promise<void>((res, rej) => {
    httpServer.once("error", rej);
    httpServer.listen(cfg.port, "0.0.0.0", res);
  });
  const port = (httpServer.address() as { port: number }).port;

  if (!cfg.quiet) {
    printBanner(port, defs.map((d) => d.manifest.name));
    console.log(`  Built ${defs.length} game(s) in ${buildMs}ms.`);
    if (session.players.size > 0) {
      console.log(`  Resumed session with ${session.players.size} player(s). Use --fresh to start over.`);
    }
    console.log("");
  }

  return {
    port,
    hub,
    async close() {
      hub.runner?.stop();
      session.save();
      wss.close();
      await new Promise<void>((res) => httpServer.close(() => res()));
    },
  };
}
