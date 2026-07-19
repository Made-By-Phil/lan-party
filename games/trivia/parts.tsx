// Trivia — bits shared between the player client and the shared visual.
import { useEffect, useState } from "react";
import type { PlayerInfo, TeamInfo } from "lan-party/sdk";

export const LETTERS = ["A", "B", "C", "D"] as const;

export interface RevealPick {
  choice: number;
  correct: boolean;
  points: number;
}

export interface TriviaState {
  phase: "question" | "reveal" | "results";
  qNum: number;
  qTotal: number;
  category: string;
  question: string;
  choices: string[];
  /** Epoch ms when the current question closes. */
  deadline: number;
  questionMs: number;
  answeredCount: number;
  answeredIds: string[];
  reveal: { correct: number; picks: Record<string, RevealPick> } | null;
  totals: Record<string, number>;
  teamTotals: Record<string, number> | null;
}

/** Re-render every ~100ms while mounted (drives the countdown bar). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function CountdownBar({ state }: { state: TriviaState }) {
  const now = useNow();
  const running = state.phase === "question";
  const remaining = running ? Math.max(0, state.deadline - now) : 0;
  const frac = running ? remaining / state.questionMs : 0;
  const cls =
    !running ? "tv-timer-fill tv-done"
    : frac < 0.25 ? "tv-timer-fill tv-low"
    : "tv-timer-fill";
  return (
    <div className="tv-timer">
      <div className={cls} style={{ width: `${Math.min(100, frac * 100)}%` }} />
    </div>
  );
}

export function AnsweredRoster({
  state,
  players,
}: {
  state: TriviaState;
  players: PlayerInfo[];
}) {
  const answered = new Set(state.answeredIds);
  return (
    <div className="tv-answered">
      <span className="tv-answered-count">
        {state.answeredCount}/{players.length} answered
      </span>
      {players.map((p) => (
        <span key={p.id} className={answered.has(p.id) ? "tv-player-chip tv-in" : "tv-player-chip"}>
          {answered.has(p.id) && <span className="tv-check">✓</span>}
          {p.name}
        </span>
      ))}
    </div>
  );
}

export function TeamTotals({
  teams,
  teamTotals,
}: {
  teams: TeamInfo[];
  teamTotals: Record<string, number> | null;
}) {
  if (!teamTotals || teams.length === 0) return null;
  const sorted = [...teams].sort(
    (a, b) => (teamTotals[b.id] ?? 0) - (teamTotals[a.id] ?? 0),
  );
  return (
    <div className="tv-team-totals">
      {sorted.map((t) => (
        <span key={t.id} className="tv-team-total" style={{ borderColor: t.color }}>
          <span className="team-dot" style={{ background: t.color }} />
          {t.name}
          <span className="tv-points">{teamTotals[t.id] ?? 0}</span>
        </span>
      ))}
    </div>
  );
}

export function Standings({
  state,
  players,
  meId,
  showDeltas,
}: {
  state: TriviaState;
  players: PlayerInfo[];
  meId?: string | null;
  showDeltas?: boolean;
}) {
  const sorted = [...players].sort(
    (a, b) => (state.totals[b.id] ?? 0) - (state.totals[a.id] ?? 0),
  );
  return (
    <ol className="tv-standings">
      {sorted.map((p, i) => {
        const delta = showDeltas ? state.reveal?.picks[p.id]?.points ?? 0 : 0;
        return (
          <li
            key={p.id}
            className={p.id === meId ? "tv-standing-row tv-me" : "tv-standing-row"}
          >
            <span className="tv-rank">{i + 1}.</span>
            <span className="tv-name">{p.name}</span>
            {delta > 0 && <span className="tv-delta">+{delta}</span>}
            <span className="tv-points">{state.totals[p.id] ?? 0}</span>
          </li>
        );
      })}
    </ol>
  );
}
