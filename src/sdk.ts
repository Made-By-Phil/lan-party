// Public SDK surface for game authors. Import as `lan-party/sdk`.
// Everything here is types — games carry no runtime dependency on the framework.

import type {
  GameManifest,
  PlayerInfo,
  Role,
  TeamInfo,
} from "./shared/types.ts";

export type {
  DisplayMode,
  GameManifest,
  PlayerInfo,
  Role,
  TeamInfo,
  TeamsRequirement,
} from "./shared/types.ts";

// ---------------------------------------------------------------------------
// Server side (server.ts): the host imports the game's default export and
// calls it once per round. The returned GameServer is authoritative.
// ---------------------------------------------------------------------------

export interface GameResults {
  /** Points to add to the party ledger. Guideline: ~0–100 per round. */
  pointsByPlayer: Record<string, number>;
  summary?: string;
}

export interface GameContext {
  /** Roster seated for this round, frozen at start. */
  players: PlayerInfo[];
  /** Teams in play (empty when the round is teamless). */
  teams: TeamInfo[];
  /**
   * Ask the host to rebroadcast state now. Needed only for timer-driven
   * changes — after onAction and tick the host rebroadcasts automatically.
   */
  update(): void;
  /** Finish the round. The instance is discarded afterwards. */
  end(results: GameResults): void;
}

export interface GameServer {
  /** Payloads arrive exactly as the client sent them — validate everything. */
  onAction(playerId: string, action: any): void;
  /** Called at manifest.tickRate when > 0. */
  tick?(dtMs: number): void;
  onPlayerDisconnect?(playerId: string): void;
  onPlayerReconnect?(playerId: string): void;
  /** Broadcast to everyone. Must be JSON-serializable. */
  getPublicState(): any;
  /** Private overlay for one player (their hand, their role, ...). */
  getPlayerState?(playerId: string): any;
  /** Extra state merged over public state on the shared visual. */
  getSharedState?(): any;
}

export type CreateGame = (ctx: GameContext) => GameServer;

// ---------------------------------------------------------------------------
// Client side (client.tsx / shared.tsx): default-export a React component
// receiving GameClientProps. The shell owns the chrome; the game owns its
// viewport.
// ---------------------------------------------------------------------------

export interface GameClientApi {
  gameId: string;
  manifest: GameManifest;
  /** getPublicState() (+ getSharedState() merged in on the shared visual). */
  state: any;
  /** getPlayerState(self.id) — undefined on the shared visual. */
  you: any;
  /** You. Null on the shared visual. */
  self: PlayerInfo | null;
  /** Roster seated in this round. */
  players: PlayerInfo[];
  teams: TeamInfo[];
  /** Cumulative party points ledger (all games so far). */
  points: Record<string, number>;
  /** Send an action to the game server. No-op on the shared visual. */
  send(action: any): void;
  sharedVisualPresent: boolean;
  /** True for the party lead (earliest-joined connected player). */
  isLead: boolean;
  role: Role;
}

export interface GameClientProps {
  game: GameClientApi;
}
