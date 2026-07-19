import type { CreateGame, GameResults, GameServer } from "../sdk.ts";
import type { PlayerInfo, TeamInfo } from "../shared/types.ts";
import type { GameDef } from "./games.ts";

export interface RunnerCallbacks {
  /** Rebroadcast game state to all connected clients. */
  broadcast(): void;
  /** The round finished (game called ctx.end, or admin force-ended it). */
  onEnd(results: GameResults): void;
}

/**
 * Owns one in-flight game round: the game server instance, its tick loop,
 * and the guard rails around game code (games are trusted but still crash).
 */
export class GameRunner {
  instance: GameServer | null = null;
  ended = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastTick = 0;

  def: GameDef;
  seated: PlayerInfo[];
  teams: TeamInfo[];
  private cb: RunnerCallbacks;

  constructor(def: GameDef, seated: PlayerInfo[], teams: TeamInfo[], cb: RunnerCallbacks) {
    this.def = def;
    this.seated = seated;
    this.teams = teams;
    this.cb = cb;
  }

  start(create: CreateGame): void {
    this.instance = create({
      players: this.seated,
      teams: this.teams,
      update: () => {
        if (!this.ended) this.cb.broadcast();
      },
      end: (results) => this.end(results),
    });
    const hz = this.def.manifest.tickRate;
    if (hz > 0 && !this.ended) {
      this.lastTick = performance.now();
      this.tickTimer = setInterval(() => this.tick(), 1000 / hz);
    }
  }

  private tick(): void {
    if (this.ended || !this.instance?.tick) return;
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    this.guard(() => this.instance!.tick!(dt));
    if (!this.ended) this.cb.broadcast();
  }

  isSeated(playerId: string): boolean {
    return this.seated.some((p) => p.id === playerId);
  }

  onAction(playerId: string, action: unknown): void {
    if (this.ended || !this.instance || !this.isSeated(playerId)) return;
    this.guard(() => this.instance!.onAction(playerId, action));
    if (!this.ended) this.cb.broadcast();
  }

  onPlayerDisconnect(playerId: string): void {
    if (this.ended || !this.isSeated(playerId)) return;
    this.guard(() => this.instance?.onPlayerDisconnect?.(playerId));
    if (!this.ended) this.cb.broadcast();
  }

  onPlayerReconnect(playerId: string): void {
    if (this.ended || !this.isSeated(playerId)) return;
    this.guard(() => this.instance?.onPlayerReconnect?.(playerId));
  }

  publicState(): unknown {
    return this.guard(() => this.instance?.getPublicState()) ?? {};
  }

  playerState(playerId: string): unknown {
    return this.guard(() => this.instance?.getPlayerState?.(playerId));
  }

  sharedState(): unknown {
    const pub = this.publicState();
    const extra = this.guard(() => this.instance?.getSharedState?.());
    if (extra && typeof extra === "object" && pub && typeof pub === "object") {
      return { ...(pub as object), ...(extra as object) };
    }
    return pub;
  }

  end(results: GameResults): void {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    this.cb.onEnd(results);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** Run game code without letting a game bug take the party down. */
  private guard<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      console.error(`[lan-party] game "${this.def.manifest.id}" threw:`, err);
      return undefined;
    }
  }
}
