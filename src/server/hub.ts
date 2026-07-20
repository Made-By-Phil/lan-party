import type { WebSocket } from "ws";
import type { GameResults } from "../sdk.ts";
import type {
  AdminOp,
  ClientMsg,
  PlayerInfo,
  Role,
  ServerMsg,
} from "../shared/types.ts";
import type { GameDef } from "./games.ts";
import { loadGameServer } from "./games.ts";
import { GameRunner } from "./runner.ts";
import type { Session } from "./session.ts";

interface Conn {
  ws: WebSocket;
  role: Role | null;
  playerId: string | null;
  debugAddr?: string;
}

export interface HubOptions {
  allowShared: boolean;
}

/**
 * The hub owns all live connections and routes the WebSocket protocol between
 * clients, the session, and the active game runner.
 */
export class Hub {
  private conns = new Set<Conn>();
  runner: GameRunner | null = null;

  session: Session;
  defs: GameDef[];
  private builtServers: Map<string, string>;
  private opts: HubOptions;

  constructor(
    session: Session,
    defs: GameDef[],
    builtServers: Map<string, string>,
    opts: HubOptions,
  ) {
    this.session = session;
    this.defs = defs;
    this.builtServers = builtServers;
    this.opts = opts;
    session.onChange = () => this.broadcastSession();
  }

  get sharedVisualPresent(): boolean {
    return [...this.conns].some((c) => c.role === "shared");
  }

  catalog() {
    return this.defs.map((d) => d.manifest);
  }

  // ---- connection lifecycle ---------------------------------------------

  handleConnection(ws: WebSocket, debugAddr?: string): void {
    const conn: Conn = { ws, role: null, playerId: null, debugAddr };
    this.conns.add(conn);
    // Immediate snapshot so the connect screen knows about the party
    // (shared-visual availability, roster) before joining.
    this.send(conn, this.sessionMsg());
    ws.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        this.handleMsg(conn, msg);
      } catch (err) {
        console.error("[lan-party] error handling message:", err);
        this.send(conn, { type: "error", message: "internal error" });
      }
    });
    ws.on("close", () => this.handleClose(conn));
    ws.on("error", () => ws.close());
  }

  private handleClose(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.playerId) {
      const pid = conn.playerId;
      const stillConnected = [...this.conns].some((c) => c.playerId === pid);
      if (!stillConnected) {
        this.session.disconnect(pid);
        this.runner?.onPlayerDisconnect(pid);
      }
    }
    if (conn.role === "shared") this.broadcastSession();
  }

  // ---- message routing ---------------------------------------------------

  private handleMsg(conn: Conn, msg: ClientMsg): void {
    if (msg.type === "join") return this.handleJoin(conn, msg);
    // Logged before the join gate: the most useful client errors are the ones
    // that stop a device from joining in the first place.
    if (msg.type === "client.error") return this.logClientError(conn, msg);
    if (conn.role === "player" && conn.playerId) {
      const pid = conn.playerId;
      switch (msg.type) {
        case "lobby.rename":
          return this.session.rename(pid, String(msg.name ?? ""));
        case "lobby.vote": {
          const gameId = msg.gameId;
          if (gameId !== null && !this.defs.some((d) => d.manifest.id === gameId)) return;
          return this.session.vote(pid, gameId);
        }
        case "lobby.joinTeam":
          return this.session.assignTeam(pid, msg.teamId ?? null);
        case "lobby.admin":
          if (!this.session.isLead(pid)) return;
          return this.handleAdmin(conn, msg.admin);
        case "game.action":
          return this.runner?.onAction(pid, msg.action);
      }
    }
    if (conn.role === "shared" && msg.type === "lobby.admin") {
      return this.handleAdmin(conn, msg.admin);
    }
  }

  private handleJoin(conn: Conn, msg: Extract<ClientMsg, { type: "join" }>): void {
    if (msg.role === "shared") {
      if (!this.opts.allowShared) {
        return this.send(conn, {
          type: "error",
          message: "Shared visual is disabled on this party.",
          code: "shared-unavailable",
        });
      }
      if (this.sharedVisualPresent) {
        return this.send(conn, {
          type: "error",
          message: "A shared visual is already connected.",
          code: "shared-unavailable",
        });
      }
      conn.role = "shared";
      conn.playerId = null;
      this.send(conn, { type: "joined", self: null, role: "shared" });
      this.broadcastSession();
      this.sendGameState(conn);
      return;
    }
    const token = String(msg.token ?? "").slice(0, 64);
    if (!token) {
      return this.send(conn, { type: "error", message: "Missing token." });
    }
    conn.role = "player";
    conn.playerId = token;
    const player = this.session.connect(token, msg.name, conn.debugAddr);
    this.send(conn, { type: "joined", self: player, role: "player" });
    this.broadcastSession();
    if (this.runner) {
      this.runner.onPlayerReconnect(player.id);
      this.sendGameState(conn);
    }
  }

  /** Surface a guest device's error on the host terminal, tagged with who sent it. */
  private logClientError(
    conn: Conn,
    msg: Extract<ClientMsg, { type: "client.error" }>,
  ): void {
    const player = conn.playerId ? this.session.toState().players.find((p) => p.id === conn.playerId) : null;
    const who = player?.name ?? conn.role ?? "unjoined";
    const where = conn.debugAddr ? ` @ ${conn.debugAddr}` : "";
    // Untrusted input from the client: clamp before it reaches the terminal.
    const context = String(msg.context ?? "?").slice(0, 80);
    const message = String(msg.message ?? "").slice(0, 500);
    const stack = msg.stack ? String(msg.stack).slice(0, 2000) : null;
    console.error(`[lan-party] client error (${who}${where}) [${context}]: ${message}`);
    if (stack) console.error(stack);
  }

  private handleAdmin(conn: Conn, op: AdminOp): void {
    switch (op.op) {
      case "kick": {
        const pid = op.playerId;
        this.runner?.onPlayerDisconnect(pid);
        this.session.kick(pid);
        for (const c of this.conns) {
          if (c.playerId === pid) {
            this.send(c, {
              type: "error",
              message: "You were removed from the party.",
              code: "kicked",
            });
            c.playerId = null;
            c.ws.close();
          }
        }
        return;
      }
      case "adjustPoints":
        return this.session.adjustPoints(op.playerId, Number(op.delta));
      case "createTeam":
        this.session.createTeam(op.name);
        return;
      case "removeTeam":
        return this.session.removeTeam(op.teamId);
      case "renameTeam":
        return this.session.renameTeam(op.teamId, String(op.name ?? ""));
      case "assignTeam":
        return this.session.assignTeam(op.playerId, op.teamId);
      case "autoBalance":
        return this.session.autoBalance(Number(op.teamCount) || 2);
      case "startGame":
        void this.startGame(op.gameId, conn);
        return;
      case "endGame":
        this.runner?.end({ pointsByPlayer: {}, summary: "Ended by admin." });
        return;
    }
  }

  // ---- game lifecycle ----------------------------------------------------

  async startGame(gameId: string, byConn?: Conn): Promise<void> {
    const fail = (message: string) => {
      if (byConn) this.send(byConn, { type: "error", message });
    };
    if (this.session.phase !== "lobby") return fail("A game is already running.");
    const def = this.defs.find((d) => d.manifest.id === gameId);
    const built = this.builtServers.get(gameId);
    if (!def || !built) return fail(`Unknown game "${gameId}".`);

    const connected = this.session
      .toState()
      .players.filter((p) => p.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (connected.length < def.manifest.minPlayers) {
      return fail(`${def.manifest.name} needs at least ${def.manifest.minPlayers} players.`);
    }
    // Seat by join order up to maxPlayers; the rest sit this round out.
    const seated: PlayerInfo[] = connected
      .slice(0, def.manifest.maxPlayers)
      .map((p) => ({ id: p.id, name: p.name, teamId: p.teamId }));

    let teams = this.session.teams;
    if (def.manifest.teams === "none") {
      teams = [];
    } else {
      teams = teams.filter((t) => seated.some((p) => p.teamId === t.id));
    }
    if (def.manifest.teams === "required") {
      if (teams.length < 2 || seated.some((p) => !p.teamId)) {
        return fail(`${def.manifest.name} needs everyone on a team (at least 2 teams).`);
      }
    }

    let runner: GameRunner;
    try {
      const create = await loadGameServer(built);
      runner = new GameRunner(def, seated, teams, {
        broadcast: () => this.broadcastGameState(),
        onEnd: (results) => this.finishGame(results),
      });
      this.runner = runner;
      runner.start(create);
    } catch (err) {
      console.error(`[lan-party] failed to start "${gameId}":`, err);
      this.runner = null;
      return fail(`Failed to start ${def.manifest.name}.`);
    }
    this.session.phase = "in-game";
    this.session.activeGameId = gameId;
    this.session.changed();
    this.broadcastGameState();
  }

  private finishGame(results: GameResults): void {
    const runner = this.runner;
    if (!runner) return;
    this.runner = null;
    runner.stop();
    this.session.phase = "lobby";
    this.session.activeGameId = null;
    const entry = {
      gameId: runner.def.manifest.id,
      gameName: runner.def.manifest.name,
      endedAt: Date.now(),
      pointsByPlayer: results.pointsByPlayer ?? {},
      summary: results.summary,
    };
    this.session.recordResult(entry);
    this.broadcast({ type: "game.over", results: entry });
  }

  // ---- broadcasting ------------------------------------------------------

  private send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: ServerMsg): void {
    const raw = JSON.stringify(msg);
    for (const c of this.conns) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(raw);
    }
  }

  private sessionMsg(): ServerMsg {
    return {
      type: "session",
      session: this.session.toState(),
      catalog: this.catalog(),
      sharedVisualPresent: this.sharedVisualPresent,
      sharedVisualAllowed: this.opts.allowShared,
    };
  }

  broadcastSession(): void {
    this.broadcast(this.sessionMsg());
  }

  broadcastGameState(): void {
    if (!this.runner) return;
    for (const c of this.conns) this.sendGameState(c);
  }

  private sendGameState(conn: Conn): void {
    const runner = this.runner;
    if (!runner || !conn.role) return;
    const base = {
      type: "game.state" as const,
      gameId: runner.def.manifest.id,
      seated: runner.seated,
    };
    if (conn.role === "shared") {
      this.send(conn, { ...base, state: runner.sharedState() });
    } else if (conn.playerId && runner.isSeated(conn.playerId)) {
      this.send(conn, {
        ...base,
        state: runner.publicState(),
        you: runner.playerState(conn.playerId),
      });
    } else {
      // Not seated this round: public state only (the shell shows a wait screen).
      this.send(conn, { ...base, state: runner.publicState() });
    }
  }
}
