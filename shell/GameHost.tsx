import type { GameClientApi } from "../src/sdk.ts";
import type { GameRegistry, GameRegistryEntry } from "./boot.tsx";
import { Scoreboard } from "./ui.tsx";
import { store, useClient, type ClientState } from "./store.ts";

export function buildGameApi(client: ClientState, entry: GameRegistryEntry): GameClientApi {
  const session = client.session!;
  const game = client.game!;
  const isPlayer = client.role === "player";
  const teamsInPlay =
    entry.manifest.teams === "none"
      ? []
      : session.teams.filter((t) => game.seated.some((p) => p.teamId === t.id));
  return {
    gameId: game.gameId,
    manifest: entry.manifest,
    state: game.state,
    you: game.you,
    self: isPlayer && client.self
      ? { id: client.self.id, name: client.self.name, teamId: client.self.teamId }
      : null,
    players: game.seated,
    teams: teamsInPlay,
    points: session.points,
    send: isPlayer
      ? (action) => store.send({ type: "game.action", action })
      : () => {},
    sharedVisualPresent: client.sharedVisualPresent,
    isLead: client.self?.isLead ?? false,
    role: client.role ?? "player",
  };
}

export function EndRoundButton() {
  return (
    <button
      className="ghost tiny danger"
      onClick={() => store.send({ type: "lobby.admin", admin: { op: "endGame" } })}
    >
      End round
    </button>
  );
}

export function GameHost({ registry }: { registry: GameRegistry }) {
  const client = useClient();
  const entry = registry.get(client.game!.gameId);
  if (!entry) {
    return <div className="screen center-screen"><p>Unknown game… waiting for the round to end.</p></div>;
  }
  // Shared-arena games hide their board on the device and draw it on the big
  // screen. Say so, or a player whose shared screen is off-view just sees
  // controls with nothing to aim at.
  const onBigScreen =
    entry.manifest.displayMode === "shared-arena" && client.sharedVisualPresent;

  return (
    <div className="screen game-screen">
      <header className="game-header">
        <span className="game-title">{entry.manifest.name}</span>
        <span className="spacer" />
        {client.self?.isLead && <EndRoundButton />}
      </header>
      {onBigScreen && (
        <div className="big-screen-hint">
          📺 The action is on the shared screen — this is your controller.
        </div>
      )}
      <div className="game-viewport">
        <entry.Client game={buildGameApi(client, entry)} />
      </div>
    </div>
  );
}

/** Shown to connected players who aren't seated in the current round. */
export function WaitingRoom() {
  const client = useClient();
  const session = client.session!;
  const gameName =
    client.catalog.find((m) => m.id === session.activeGameId)?.name ?? "A game";
  return (
    <div className="screen lobby">
      <div className="card center">
        <h3>{gameName} is in progress</h3>
        <p className="muted">
          You'll be in the next round — hang tight, rounds are short.
        </p>
      </div>
      <Scoreboard session={session} />
    </div>
  );
}
