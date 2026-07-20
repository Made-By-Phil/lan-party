// Shared vocabulary for the host server, the shell, and games.
// This file must stay dependency-free and JSON-serializable throughout.

export type Role = "player" | "shared";

export interface PlayerInfo {
  id: string;
  name: string;
  teamId: string | null;
}

export interface Player extends PlayerInfo {
  connected: boolean;
  isLead: boolean;
  joinedAt: number;
  /** Last seen remote address. Debug label only — identity is the token. */
  debugAddr?: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  color: string;
}

export interface GameResultEntry {
  gameId: string;
  gameName: string;
  endedAt: number;
  pointsByPlayer: Record<string, number>;
  summary?: string;
}

export type SessionPhase = "lobby" | "in-game";

export interface SessionState {
  phase: SessionPhase;
  players: Player[];
  teams: TeamInfo[];
  /** Cumulative party points ledger, per player. Team scores are always derived. */
  points: Record<string, number>;
  /** playerId -> gameId currently voted for. */
  votes: Record<string, string>;
  history: GameResultEntry[];
  activeGameId: string | null;
}

/** A curated-registry game as offered to the lobby browser. */
export interface RegistryListing {
  id: string;
  name: string;
  description: string;
  /** Already present in this party's catalog. */
  installed: boolean;
  /** Its engine range accepts this host. */
  compatible: boolean;
}

export type TeamsRequirement = "none" | "optional" | "required";
export type DisplayMode = "device" | "shared-arena" | "adaptive";

export interface GameManifest {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  teams: TeamsRequirement;
  /** Hz. 0 = event-driven (no tick loop). */
  tickRate: number;
  displayMode: DisplayMode;
  /**
   * Engine compatibility range, e.g. "^0.1.0". Absent means unstated, which is
   * accepted but flagged by `validate` — games written before the field existed.
   */
  engine?: string;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type AdminOp =
  | { op: "kick"; playerId: string }
  | { op: "adjustPoints"; playerId: string; delta: number }
  | { op: "createTeam"; name?: string }
  | { op: "removeTeam"; teamId: string }
  | { op: "renameTeam"; teamId: string; name: string }
  | { op: "assignTeam"; playerId: string; teamId: string | null }
  | { op: "autoBalance"; teamCount: number }
  | { op: "startGame"; gameId: string }
  | { op: "endGame" };

export type ClientMsg =
  | { type: "join"; token: string; name?: string; role: Role }
  | { type: "lobby.rename"; name: string }
  | { type: "lobby.vote"; gameId: string | null }
  | { type: "lobby.joinTeam"; teamId: string | null }
  | { type: "lobby.admin"; admin: AdminOp }
  /** Browse the curated registry from the party (lead or shared visual only). */
  | { type: "registry.search"; query?: string }
  | { type: "registry.install"; id: string }
  | { type: "game.action"; action: unknown }
  /**
   * Client-side failure forwarded to the host console. Guests are on phones with
   * no reachable devtools, so the host terminal is the only place to see these.
   */
  | { type: "client.error"; context: string; message: string; stack?: string };

export type ServerMsg =
  | { type: "joined"; self: Player | null; role: Role }
  | {
      type: "session";
      session: SessionState;
      catalog: GameManifest[];
      sharedVisualPresent: boolean;
      sharedVisualAllowed: boolean;
    }
  | {
      type: "game.state";
      gameId: string;
      /** Public state; on the shared visual, shared state is merged over it. */
      state: unknown;
      /** Private per-player overlay (players only). */
      you?: unknown;
      /** Roster seated in this round (may be fewer than the party). */
      seated: PlayerInfo[];
    }
  | { type: "game.over"; results: GameResultEntry }
  /** The game bundle changed; reload to pick it up. Never sent mid-round. */
  | { type: "reload"; reason?: string }
  | { type: "registry.results"; games: RegistryListing[]; error?: string }
  | {
      type: "registry.status";
      id: string;
      state: "installing" | "installed" | "error";
      message?: string;
    }
  | { type: "error"; message: string; code?: "kicked" | "shared-unavailable" };
