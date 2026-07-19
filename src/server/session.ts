import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GameResultEntry,
  Player,
  SessionState,
  TeamInfo,
} from "../shared/types.ts";

const TEAM_COLORS = [
  "#e94f4f",
  "#4f7de9",
  "#3fae5a",
  "#e9b84f",
  "#9b59d0",
  "#e9884f",
  "#41b8c4",
  "#d8558f",
];

const ADJECTIVES = ["Red", "Blue", "Green", "Gold", "Purple", "Orange", "Teal", "Pink"];

export interface PersistedSession {
  players: Player[];
  teams: TeamInfo[];
  points: Record<string, number>;
  history: GameResultEntry[];
}

/**
 * The party session: roster, teams, points ledger, votes, history.
 * Game-round state lives in the GameRunner, not here — only results land here.
 */
export class Session {
  players = new Map<string, Player>();
  teams: TeamInfo[] = [];
  points: Record<string, number> = {};
  votes: Record<string, string> = {};
  history: GameResultEntry[] = [];
  phase: "lobby" | "in-game" = "lobby";
  activeGameId: string | null = null;

  private saveTimer: NodeJS.Timeout | null = null;
  private nextTeamIdx = 0;

  private file: string;
  onChange: () => void;

  constructor(file: string, onChange: () => void = () => {}) {
    this.file = file;
    this.onChange = onChange;
  }

  static load(file: string, fresh: boolean): Session {
    const s = new Session(file);
    if (fresh) return s;
    try {
      const data: PersistedSession = JSON.parse(readFileSync(file, "utf8"));
      for (const p of data.players ?? []) {
        s.players.set(p.id, { ...p, connected: false, isLead: false });
      }
      s.teams = data.teams ?? [];
      s.points = data.points ?? {};
      s.history = data.history ?? [];
      s.nextTeamIdx = s.teams.length;
    } catch {
      // no session file or unreadable — start empty
    }
    return s;
  }

  // ---- roster ------------------------------------------------------------

  /** Find-or-create by token; returns the player. */
  connect(token: string, name: string | undefined, debugAddr?: string): Player {
    let p = this.players.get(token);
    if (!p) {
      p = {
        id: token,
        name: sanitizeName(name) || `Player ${this.players.size + 1}`,
        teamId: null,
        connected: true,
        isLead: false,
        joinedAt: Date.now(),
        debugAddr,
      };
      this.players.set(token, p);
      this.points[p.id] ??= 0;
    } else {
      p.connected = true;
      p.debugAddr = debugAddr;
      if (name && sanitizeName(name)) p.name = sanitizeName(name);
    }
    this.recomputeLead();
    this.changed();
    return p;
  }

  disconnect(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    this.recomputeLead();
    this.changed();
  }

  kick(playerId: string): void {
    this.players.delete(playerId);
    delete this.votes[playerId];
    delete this.points[playerId];
    this.recomputeLead();
    this.changed();
  }

  rename(playerId: string, name: string): void {
    const p = this.players.get(playerId);
    const clean = sanitizeName(name);
    if (!p || !clean) return;
    p.name = clean;
    this.changed();
  }

  isLead(playerId: string): boolean {
    return this.players.get(playerId)?.isLead ?? false;
  }

  private recomputeLead(): void {
    const connected = [...this.players.values()]
      .filter((p) => p.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    for (const p of this.players.values()) p.isLead = false;
    if (connected[0]) connected[0].isLead = true;
  }

  // ---- teams -------------------------------------------------------------

  createTeam(name?: string): TeamInfo {
    const i = this.nextTeamIdx++;
    const team: TeamInfo = {
      id: `team-${i}-${Math.random().toString(36).slice(2, 6)}`,
      name: name?.trim() || `Team ${ADJECTIVES[i % ADJECTIVES.length]}`,
      color: TEAM_COLORS[i % TEAM_COLORS.length]!,
    };
    this.teams.push(team);
    this.changed();
    return team;
  }

  removeTeam(teamId: string): void {
    this.teams = this.teams.filter((t) => t.id !== teamId);
    for (const p of this.players.values()) {
      if (p.teamId === teamId) p.teamId = null;
    }
    this.changed();
  }

  renameTeam(teamId: string, name: string): void {
    const t = this.teams.find((t) => t.id === teamId);
    const clean = name.trim().slice(0, 24);
    if (!t || !clean) return;
    t.name = clean;
    this.changed();
  }

  assignTeam(playerId: string, teamId: string | null): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (teamId !== null && !this.teams.some((t) => t.id === teamId)) return;
    p.teamId = teamId;
    this.changed();
  }

  /** Deal connected players round-robin across `teamCount` teams (creating/removing as needed). */
  autoBalance(teamCount: number): void {
    const n = Math.max(2, Math.min(8, Math.floor(teamCount)));
    while (this.teams.length < n) this.createTeam();
    while (this.teams.length > n) this.removeTeam(this.teams[this.teams.length - 1]!.id);
    const connected = [...this.players.values()]
      .filter((p) => p.connected)
      .sort(() => Math.random() - 0.5);
    connected.forEach((p, i) => {
      p.teamId = this.teams[i % n]!.id;
    });
    this.changed();
  }

  // ---- votes & points ----------------------------------------------------

  vote(playerId: string, gameId: string | null): void {
    if (gameId === null) delete this.votes[playerId];
    else this.votes[playerId] = gameId;
    this.changed();
  }

  adjustPoints(playerId: string, delta: number): void {
    if (!this.players.has(playerId) || !Number.isFinite(delta)) return;
    this.points[playerId] = (this.points[playerId] ?? 0) + Math.round(delta);
    this.changed();
  }

  recordResult(result: GameResultEntry): void {
    for (const [pid, pts] of Object.entries(result.pointsByPlayer)) {
      if (!this.players.has(pid) || !Number.isFinite(pts)) continue;
      this.points[pid] = (this.points[pid] ?? 0) + Math.round(pts);
    }
    this.history.push(result);
    this.votes = {};
    this.changed();
  }

  // ---- snapshot & persistence -------------------------------------------

  toState(): SessionState {
    return {
      phase: this.phase,
      players: [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt),
      teams: this.teams,
      points: this.points,
      votes: this.votes,
      history: this.history,
      activeGameId: this.activeGameId,
    };
  }

  changed(): void {
    this.onChange();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  save(): void {
    const data: PersistedSession = {
      players: [...this.players.values()],
      teams: this.teams,
      points: this.points,
      history: this.history,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[lan-party] failed to save session: ${err}`);
    }
  }
}

export function sanitizeName(name: string | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
}
