import { existsSync, rmSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { buildGames, discoverGames, mergeCatalogs } from "./games.ts";
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
  /** Watch games dirs and rebuild on change. Default true. */
  watch?: boolean;
}

export interface RunningServer {
  port: number;
  hub: Hub;
  /** Rediscover, rebuild, and swap. Exposed for tests and manual triggers. */
  rebuild(): Promise<void>;
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
  const discovered = mergeCatalogs(bundled, user);

  const t0 = performance.now();
  const build = await buildGames(discovered, join(root, "shell"), buildDir);
  const buildMs = Math.round(performance.now() - t0);
  const defs = build.ok;
  const builtServers = build.builtServers;

  // A broken game is excluded from the catalog, never fatal — the party starts
  // with whatever works (decision 28).
  for (const f of build.failed) {
    console.warn(`[lan-party] skipping game "${f.id}": ${f.reason}`);
  }
  if (defs.length === 0) {
    console.log(
      "  No games installed yet. Add one with `lan-party add <name>`,\n" +
        "  or from the shared screen once someone joins.",
    );
  }

  const session = Session.load(join(dataDir, "session.json"), cfg.fresh);
  const hub = new Hub(session, defs, builtServers, {
    allowShared: cfg.allowShared,
    install: {
      gamesDir: userDir ?? join(cfg.cwd, "games"),
      dataDir,
      shellDir: join(root, "shell"),
      refresh: () => rebuild(),
    },
  });

  // The served build directory is swapped, never mutated in place: a rebuild
  // lands in a new numbered dir and only becomes visible if it succeeded.
  let servedBuildDir = buildDir;
  let generation = 0;
  const httpServer = createHttpServer(() => servedBuildDir);
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

  // ---- watch for games appearing, changing or leaving ---------------------

  const watchDirs = [bundledDir, userDir].filter(
    (d): d is string => !!d && existsSync(d),
  );
  const watchers: FSWatcher[] = [];
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let rebuilding = false;

  async function rebuild(): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;
    try {
      const next = join(dataDir, `build-${++generation}`);
      const rediscovered = mergeCatalogs(
        discoverGames(bundledDir),
        userDir && userDir !== bundledDir ? discoverGames(userDir) : [],
      );
      const report = await buildGames(rediscovered, join(root, "shell"), next);
      for (const f of report.failed) {
        console.warn(`[lan-party] skipping game "${f.id}": ${f.reason}`);
      }
      if (report.ok.length === 0 && hub.defs.length > 0) {
        console.warn("[lan-party] rebuild produced no games — keeping the running build.");
        rmSync(next, { recursive: true, force: true });
        return;
      }
      const previous = servedBuildDir;
      servedBuildDir = next;
      hub.setGames(report.ok, report.builtServers);
      hub.requestReload("games changed");
      console.log(`[lan-party] rebuilt ${report.ok.length} game(s) — clients will reload.`);
      if (previous !== buildDir) rmSync(previous, { recursive: true, force: true });
    } catch (err) {
      // A broken build must never replace a working party.
      console.error(`[lan-party] rebuild failed, keeping the running build:`, err);
    } finally {
      rebuilding = false;
    }
  }

  if (cfg.watch !== false) {
    for (const dir of watchDirs) {
      try {
        const w = watch(dir, { recursive: true }, () => {
          if (rebuildTimer) clearTimeout(rebuildTimer);
          // Unzipping a folder emits a burst of events; wait for it to settle.
          rebuildTimer = setTimeout(() => void rebuild(), 400);
        });
        watchers.push(w);
      } catch {
        // Recursive watch is not supported everywhere; the party still runs,
        // games just need a restart to appear.
        if (!cfg.quiet) {
          console.warn(`[lan-party] cannot watch ${dir} — restart to pick up new games.`);
        }
      }
    }
  }

  return {
    port,
    hub,
    rebuild,
    async close() {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      for (const w of watchers) w.close();
      hub.runner?.stop();
      session.save();
      wss.close();
      await new Promise<void>((res) => httpServer.close(() => res()));
    },
  };
}
