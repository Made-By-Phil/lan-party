import type { AdminOp } from "../src/shared/types.ts";
import type { GameRegistry } from "./boot.tsx";
import { GameBrowser } from "./GameBrowser.tsx";
import { GameSettingsPanel, SettingsSummary } from "./GameSettings.tsx";
import { buildGameApi, EndRoundButton } from "./GameHost.tsx";
import { startBlocker } from "./Lobby.tsx";
import { store, useClient } from "./store.ts";
import { LastResult, Scoreboard } from "./ui.tsx";

function admin(op: AdminOp) {
  store.send({ type: "lobby.admin", admin: op });
}

/** The room screen between games: big leaderboard, votes, and admin controls. */
export function SharedLobby() {
  const client = useClient();
  const session = client.session!;
  const votesFor = (gameId: string) =>
    Object.values(session.votes).filter((v) => v === gameId).length;

  return (
    <div className="screen shared-lobby">
      <header className="shared-header">
        <h1 className="logo">
          LAN<span> Party</span>
        </h1>
        <div className="join-url">
          Join at <strong>{location.origin.replace(/^https?:\/\//, "")}</strong>
        </div>
      </header>

      <div className="shared-columns">
        <section className="shared-main">
          <h3>Leaderboard</h3>
          <Scoreboard
            big
            session={session}
            actions={(p) => (
              <span className="row tight admin-actions">
                <button className="ghost tiny" onClick={() => admin({ op: "adjustPoints", playerId: p.id, delta: -5 })}>−5</button>
                <button className="ghost tiny" onClick={() => admin({ op: "adjustPoints", playerId: p.id, delta: 5 })}>+5</button>
                <button className="ghost tiny danger" onClick={() => admin({ op: "kick", playerId: p.id })}>✕</button>
              </span>
            )}
          />
          <LastResult session={session} />
        </section>

        <section className="shared-side">
          <h3>Next game</h3>
          {client.catalog.length === 0 && (
            <div className="card center empty-catalog">
              <h3>No games installed</h3>
              <p className="muted">Add some with “＋ Add games” below.</p>
            </div>
          )}
          <div className="game-cards">
            {client.catalog.map((m) => {
              const blocker = startBlocker(m, session);
              const votes = votesFor(m.id);
              return (
                <div key={m.id} className="card game-card">
                  <div className="game-card-head">
                    <h4>{m.name}</h4>
                    {votes > 0 && <span className="vote-count">{votes} 🗳</span>}
                  </div>
                  <p className="muted small">{m.description}</p>
                  <SettingsSummary manifest={m} />
                  <GameSettingsPanel manifest={m} />
                  <button
                    className="primary"
                    disabled={!!blocker}
                    onClick={() => admin({ op: "startGame", gameId: m.id })}
                  >
                    {blocker ?? "Start ▶"}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="row">
            <button className="ghost small" onClick={() => admin({ op: "createTeam" })}>+ Add team</button>
            <button className="ghost small" onClick={() => admin({ op: "autoBalance", teamCount: 2 })}>⚖ Auto-balance teams</button>
            <GameBrowser big />
          </div>
        </section>
      </div>
    </div>
  );
}

export function SharedGame({ registry }: { registry: GameRegistry }) {
  const client = useClient();
  const session = client.session!;
  const entry = registry.get(client.game!.gameId);

  return (
    <div className="screen game-screen shared-game">
      <header className="game-header">
        <span className="game-title">{entry?.manifest.name ?? "Game"}</span>
        <span className="spacer" />
        <span className="muted small">join: {location.origin.replace(/^https?:\/\//, "")}</span>
        <EndRoundButton />
      </header>
      <div className="game-viewport">
        {entry?.Shared ? (
          <entry.Shared game={buildGameApi(client, entry)} />
        ) : (
          <div className="center-screen">
            <h2>Round in progress…</h2>
            <Scoreboard big session={session} />
          </div>
        )}
      </div>
    </div>
  );
}
