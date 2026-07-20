import { useState } from "react";
import { store, useClient } from "./store.ts";

/**
 * Browse and install curated games from inside the party (decision 35). The
 * host is in a living room, not at a terminal, so this — not the CLI — is the
 * primary way games arrive. Shown to the shared visual and to the party lead.
 *
 * Only curated games are offered: passing --trust for an arbitrary URL is a
 * decision for whoever owns the machine, not for a room full of guests.
 */
export function GameBrowser({ big }: { big?: boolean }) {
  const client = useClient();
  const { open, loading, games, error, status } = client.registry;
  const [query, setQuery] = useState("");

  if (!open) {
    return (
      <button className="ghost small" onClick={() => store.openRegistry(true)}>
        ＋ Add games
      </button>
    );
  }

  return (
    <div className={`card game-browser${big ? " big" : ""}`}>
      <div className="row browser-head">
        <strong>Add games</strong>
        <span className="spacer" />
        <button className="ghost tiny" onClick={() => store.openRegistry(false)}>
          Close
        </button>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          store.searchRegistry(query);
        }}
      >
        <input
          placeholder="Search games…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="ghost small">Search</button>
      </form>

      {loading && <p className="muted small">Looking…</p>}
      {error && (
        <p className="muted small">
          {error}
          {/* A LAN party is exactly where the uplink is unreliable. */}
          <br />
          Games already installed still work offline.
        </p>
      )}

      {!loading && !error && games.length === 0 && (
        <p className="muted small">Nothing found.</p>
      )}

      <ul className="browser-list">
        {games.map((g) => {
          const st = status[g.id]?.state;
          const busy = st === "installing";
          const done = g.installed || st === "installed";
          return (
            <li key={g.id} className="browser-row">
              <div className="browser-info">
                <strong>{g.name}</strong>
                <span className="muted small"> {g.id}</span>
                {g.description && <p className="muted small">{g.description}</p>}
                {!g.compatible && (
                  <p className="muted small">Needs a newer version of lan-party.</p>
                )}
              </div>
              <button
                className="primary small"
                disabled={done || busy || !g.compatible}
                onClick={() => store.installFromRegistry(g.id)}
              >
                {done ? "Installed" : busy ? "Installing…" : "Install"}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="muted small">
        Everyone's screen reloads once a game finishes installing — never mid-round.
      </p>
    </div>
  );
}
