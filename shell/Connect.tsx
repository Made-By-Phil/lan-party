import { useState } from "react";
import { getSavedIdentity, store, useClient } from "./store.ts";

export function Connect() {
  const client = useClient();
  const [name, setName] = useState(getSavedIdentity().name ?? "");
  const connectedCount =
    client.session?.players.filter((p) => p.connected).length ?? 0;
  const sharedOpen = client.sharedVisualAllowed && !client.sharedVisualPresent;
  const canJoin = client.connected && name.trim().length > 0;

  return (
    <div className="screen connect">
      <h1 className="logo">
        LAN<span> Party</span>
      </h1>
      {connectedCount > 0 && (
        <p className="muted">
          {connectedCount} {connectedCount === 1 ? "person is" : "people are"} here already
        </p>
      )}
      <form
        className="card connect-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canJoin) store.join({ name: name.trim(), role: "player" });
        }}
      >
        <label htmlFor="screenname">Your screen name</label>
        <input
          id="screenname"
          autoFocus
          maxLength={20}
          placeholder="e.g. Nova"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary big" disabled={!canJoin}>
          Join the party
        </button>
      </form>
      {sharedOpen && (
        <div className="card shared-offer">
          <p>Is this the big screen in the room?</p>
          <button className="ghost" onClick={() => store.join({ role: "shared" })}>
            📺 Use this device as the shared screen
          </button>
        </div>
      )}
      {!client.connected && <p className="muted">Connecting to the host…</p>}
    </div>
  );
}
