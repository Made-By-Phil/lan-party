// Boom Grid — shared visual (the TV). Primary display for the arena.

import type { GameClientProps } from "lan-party/sdk";
import { ArenaCanvas, PLAYER_COLORS, type ArenaState } from "./arena.tsx";
import "./styles.css";

interface Standing {
  id: string;
  place: number;
  points: number;
  kills: number;
}

export function useRosterMaps(players: { id: string; name: string }[]): {
  names: Record<string, string>;
  colors: Record<string, string>;
} {
  const names: Record<string, string> = {};
  const colors: Record<string, string> = {};
  players.forEach((p, i) => {
    names[p.id] = p.name;
    colors[p.id] = PLAYER_COLORS[i % PLAYER_COLORS.length]!;
  });
  return { names, colors };
}

export function TimerBadge({ state }: { state: { timeLeftMs?: number } }) {
  const total = Math.max(0, Math.ceil((state.timeLeftMs ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return <span className={`bm-timer${total <= 15 ? " low" : ""}`}>{m}:{s}</span>;
}

export function StandingsCard({
  standings,
  summary,
  names,
  colors,
}: {
  standings: Standing[];
  summary: string | null;
  names: Record<string, string>;
  colors: Record<string, string>;
}) {
  const sorted = [...standings].sort((a, b) => a.place - b.place);
  return (
    <div className="card bm-standings">
      <h3>Final standings</h3>
      {summary && <p className="muted">{summary}</p>}
      <ul className="bm-standing-list">
        {sorted.map((s) => (
          <li key={s.id} className="bm-standing-row">
            <span className="bm-place">#{s.place}</span>
            <span className="bm-dot" style={{ background: colors[s.id] }} />
            <span className="bm-standing-name">{names[s.id] ?? "?"}</span>
            <span className="spacer" />
            <span className="bm-kills">{s.kills} 💀</span>
            <span className="score">+{s.points}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BoomGridShared({ game }: GameClientProps) {
  const state = (game.state ?? {}) as ArenaState & {
    phase?: string;
    timeLeftMs?: number;
    standings?: Standing[] | null;
    summary?: string | null;
  };
  const { names, colors } = useRosterMaps(game.players);
  const players = state.players ?? [];

  return (
    <div className="bm-shared">
      <div className="bm-hud">
        <TimerBadge state={state} />
        {players.map((p) => (
          <span key={p.id} className={`bm-chip${p.alive ? "" : " dead"}`}>
            <span className="bm-dot" style={{ background: colors[p.id] }} />
            {names[p.id] ?? "?"}
            <span className="bm-kills">{p.kills} 💀</span>
          </span>
        ))}
      </div>
      <div className="bm-arena-wrap">
        <ArenaCanvas state={state} names={names} colors={colors} />
        {state.phase === "results" && state.standings && (
          <div className="bm-overlay">
            <StandingsCard
              standings={state.standings}
              summary={state.summary ?? null}
              names={names}
              colors={colors}
            />
          </div>
        )}
      </div>
    </div>
  );
}
