import { useState } from "react";
import type { AdminOp, GameManifest, SessionState } from "../src/shared/types.ts";
import { GameBrowser } from "./GameBrowser.tsx";
import { store, useClient } from "./store.ts";
import { LastResult, Scoreboard, teamOf } from "./ui.tsx";

function admin(op: AdminOp) {
  store.send({ type: "lobby.admin", admin: op });
}

export function startBlocker(m: GameManifest, session: SessionState): string | null {
  const connected = session.players.filter((p) => p.connected);
  if (connected.length < m.minPlayers) {
    return `needs ${m.minPlayers}+ players`;
  }
  if (m.teams === "required") {
    const seated = connected.slice(0, m.maxPlayers);
    const teamsInPlay = new Set(seated.map((p) => p.teamId).filter(Boolean));
    if (teamsInPlay.size < 2 || seated.some((p) => !p.teamId)) {
      return "needs everyone on a team";
    }
  }
  return null;
}

export function Lobby() {
  const client = useClient();
  const session = client.session!;
  const self = client.self!;
  const isLead = self.isLead;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(self.name);

  const votesFor = (gameId: string) =>
    Object.values(session.votes).filter((v) => v === gameId).length;
  const myVote = session.votes[self.id] ?? null;
  const topVotes = Math.max(0, ...client.catalog.map((m) => votesFor(m.id)));

  return (
    <div className="screen lobby">
      <header className="lobby-header">
        {editingName ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              store.send({ type: "lobby.rename", name: nameDraft });
              setEditingName(false);
            }}
          >
            <input
              autoFocus
              maxLength={20}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => setEditingName(false)}
            />
          </form>
        ) : (
          <h2 onClick={() => { setNameDraft(self.name); setEditingName(true); }}>
            {self.name} <span className="muted">✎</span>
          </h2>
        )}
        <span className="spacer" />
        <span className="my-points">{session.points[self.id] ?? 0} pts</span>
        <button className="ghost small" onClick={() => store.leave()}>Leave</button>
      </header>

      {isLead && (
        <p className="lead-hint">★ You're the party lead — you can start games and manage the lobby.</p>
      )}

      <section>
        <h3>Pick the next game {Object.keys(session.votes).length > 0 && <span className="muted">(votes are in!)</span>}</h3>
        {client.catalog.length === 0 && (
          <div className="card center empty-catalog">
            <h3>No games yet</h3>
            <p className="muted">
              {isLead
                ? "You're the party lead — add the first one below."
                : "Waiting for the host to add some games."}
            </p>
          </div>
        )}
        <div className="game-cards">
          {client.catalog.map((m) => {
            const blocker = startBlocker(m, session);
            const votes = votesFor(m.id);
            return (
              <div key={m.id} className={`card game-card${myVote === m.id ? " voted" : ""}${votes > 0 && votes === topVotes ? " leading" : ""}`}>
                <div className="game-card-head">
                  <h4>{m.name}</h4>
                  {votes > 0 && <span className="vote-count">{votes} 🗳</span>}
                </div>
                <p className="muted">{m.description}</p>
                <p className="muted small">
                  {m.minPlayers === m.maxPlayers ? m.minPlayers : `${m.minPlayers}–${m.maxPlayers}`} players
                  {m.teams === "required" && " · teams"}
                  {m.displayMode === "shared-arena" && " · plays on the big screen"}
                </p>
                <div className="row">
                  <button
                    className={myVote === m.id ? "primary" : "ghost"}
                    onClick={() =>
                      store.send({ type: "lobby.vote", gameId: myVote === m.id ? null : m.id })
                    }
                  >
                    {myVote === m.id ? "Voted ✓" : "Vote"}
                  </button>
                  {isLead && (
                    <button
                      className="primary"
                      disabled={!!blocker}
                      title={blocker ?? undefined}
                      onClick={() => admin({ op: "startGame", gameId: m.id })}
                    >
                      {blocker ? blocker : "Start ▶"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {/* Without a shared visual the lead is the only one who can add games. */}
        {isLead && (
          <div className="row lobby-add-games">
            <GameBrowser />
          </div>
        )}
      </section>

      <TeamsSection isLead={isLead} />

      <section>
        <h3>Party</h3>
        <Scoreboard
          session={session}
          actions={
            isLead
              ? (p) =>
                  p.id !== self.id && (
                    <span className="row tight">
                      <button className="ghost tiny" onClick={() => admin({ op: "adjustPoints", playerId: p.id, delta: -5 })}>−5</button>
                      <button className="ghost tiny" onClick={() => admin({ op: "adjustPoints", playerId: p.id, delta: 5 })}>+5</button>
                      <button className="ghost tiny danger" onClick={() => admin({ op: "kick", playerId: p.id })}>✕</button>
                    </span>
                  )
              : undefined
          }
        />
      </section>

      <LastResult session={session} />
      {!client.sharedVisualPresent && client.sharedVisualAllowed && (
        <p className="muted small center">
          Tip: open this page on a TV or laptop and pick “shared screen” for a room-wide view.
        </p>
      )}
    </div>
  );
}

export function TeamsSection({ isLead }: { isLead: boolean }) {
  const client = useClient();
  const session = client.session!;
  const self = client.self!;
  if (session.teams.length === 0 && !isLead) return null;

  return (
    <section>
      <h3>Teams</h3>
      {session.teams.length > 0 && (
        <div className="team-chips">
          {session.teams.map((t) => (
            <button
              key={t.id}
              className={`chip${self.teamId === t.id ? " active" : ""}`}
              style={{ borderColor: t.color }}
              onClick={() =>
                store.send({ type: "lobby.joinTeam", teamId: self.teamId === t.id ? null : t.id })
              }
            >
              <span className="team-dot" style={{ background: t.color }} />
              {t.name}
              {isLead && (
                <span
                  className="chip-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    admin({ op: "removeTeam", teamId: t.id });
                  }}
                >
                  ✕
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {isLead && (
        <div className="row">
          <button className="ghost small" onClick={() => admin({ op: "createTeam" })}>+ Add team</button>
          <button
            className="ghost small"
            onClick={() => admin({ op: "autoBalance", teamCount: Math.max(2, session.teams.length) })}
          >
            ⚖ Auto-balance
          </button>
        </div>
      )}
      {session.teams.length > 0 && !teamOf(session, self.teamId) && (
        <p className="muted small">Tap a team to join it.</p>
      )}
    </section>
  );
}
