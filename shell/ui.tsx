import type { Player, SessionState, TeamInfo } from "../src/shared/types.ts";

export function teamOf(session: SessionState, teamId: string | null): TeamInfo | null {
  return session.teams.find((t) => t.id === teamId) ?? null;
}

export interface TeamScore {
  team: TeamInfo;
  score: number;
  members: Player[];
}

/** Team scores are always derived from the per-player ledger. */
export function teamScores(session: SessionState): TeamScore[] {
  return session.teams
    .map((team) => {
      const members = session.players.filter((p) => p.teamId === team.id);
      return {
        team,
        members,
        score: members.reduce((sum, p) => sum + (session.points[p.id] ?? 0), 0),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function rankedPlayers(session: SessionState): Player[] {
  return [...session.players].sort(
    (a, b) => (session.points[b.id] ?? 0) - (session.points[a.id] ?? 0),
  );
}

export function PlayerName({
  player,
  session,
}: {
  player: Player;
  session: SessionState;
}) {
  const team = teamOf(session, player.teamId);
  return (
    <span className={`player-name${player.connected ? "" : " offline"}`}>
      {team && <span className="team-dot" style={{ background: team.color }} />}
      {player.name}
      {player.isLead && <span className="lead-badge" title="Party lead">★</span>}
    </span>
  );
}

export function Scoreboard({
  session,
  big,
  actions,
}: {
  session: SessionState;
  big?: boolean;
  actions?: (p: Player) => React.ReactNode;
}) {
  const teams = teamScores(session);
  return (
    <div className={`scoreboard${big ? " big" : ""}`}>
      {teams.length > 0 && (
        <div className="team-scores">
          {teams.map(({ team, score }) => (
            <div key={team.id} className="team-score" style={{ borderColor: team.color }}>
              <span className="team-dot" style={{ background: team.color }} />
              <span className="team-name">{team.name}</span>
              <span className="score">{score}</span>
            </div>
          ))}
        </div>
      )}
      <ol className="player-rows">
        {rankedPlayers(session).map((p) => (
          <li key={p.id} className="player-row">
            <PlayerName player={p} session={session} />
            <span className="spacer" />
            {actions?.(p)}
            <span className="score">{session.points[p.id] ?? 0}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function LastResult({ session }: { session: SessionState }) {
  const last = session.history[session.history.length - 1];
  if (!last) return null;
  const names = (id: string) => session.players.find((p) => p.id === id)?.name ?? "?";
  const top = Object.entries(last.pointsByPlayer)
    .filter(([, pts]) => pts !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <div className="card last-result">
      <h3>Last round · {last.gameName}</h3>
      {last.summary && <p>{last.summary}</p>}
      {top.length > 0 && (
        <p className="muted">
          {top.map(([id, pts]) => `${names(id)} +${pts}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
