import { useEffect, useRef } from "react";
import type { GameRegistry } from "./boot.tsx";
import { Connect } from "./Connect.tsx";
import { GameHost, WaitingRoom } from "./GameHost.tsx";
import { Lobby } from "./Lobby.tsx";
import { SharedGame, SharedLobby } from "./Shared.tsx";
import { getSavedIdentity, store, useClient } from "./store.ts";

export function App({ registry }: { registry: GameRegistry }) {
  const client = useClient();
  const triedAutoJoin = useRef(false);

  // Auto-rejoin with the saved identity so a page refresh (or the TV losing
  // power) drops you straight back into the party.
  useEffect(() => {
    if (!client.connected || client.joined || triedAutoJoin.current) return;
    const saved = getSavedIdentity();
    if (saved.role === "shared") {
      triedAutoJoin.current = true;
      store.join({ role: "shared" });
    } else if (saved.role === "player" && saved.name) {
      triedAutoJoin.current = true;
      store.join({ name: saved.name, role: "player" });
    }
  }, [client.connected, client.joined]);

  let screen;
  if (!client.joined || !client.session) {
    screen = <Connect />;
  } else if (client.role === "shared") {
    screen =
      client.session.phase === "in-game" && client.game ? (
        <SharedGame registry={registry} />
      ) : (
        <SharedLobby />
      );
  } else if (client.session.phase === "in-game") {
    const seated = client.game?.seated.some((p) => p.id === client.self?.id);
    screen = client.game && seated ? <GameHost registry={registry} /> : <WaitingRoom />;
  } else {
    screen = <Lobby />;
  }

  return (
    <>
      {client.everConnected && !client.connected && (
        <div className="banner reconnect">Reconnecting…</div>
      )}
      {client.toast && <div className="banner toast">{client.toast}</div>}
      {screen}
    </>
  );
}
