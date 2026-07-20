# LAN Party 🎉

An opinionated backbone for hosting quick local-multiplayer browser games on your LAN.
One computer hosts the party; everyone else joins from their phone or laptop browser —
no installs, no accounts. Games are drop-in folders of TypeScript.

```
npx lan-party
```

The host prints a LAN URL and QR code. Anyone on the same network opens it, types a
screen name, and they're in the lobby. A TV or spare laptop can join as the **shared
screen** — the room-wide display that shows leaderboards, runs admin controls, and
acts as the arena for games that want it.

## What the framework gives you

- **Lobby** with live voting on the next game, team assignment (self-pick, admin
  assign, auto-balance), and a cross-game points ledger that persists across host
  restarts (`.lan-party/session.json`; `--fresh` starts over).
- **Identity without accounts**: a token in each browser's localStorage. Refresh,
  switch rooms, drop off wifi — you resume your seat, name, team, and points.
- **Roles**: players, plus at most one shared visual. Admin lives on the shared
  visual; if there isn't one, the earliest-joined player is the "party lead" with the
  same controls (kick, adjust points, manage teams, start/end games).
- **Host-authoritative games**: all game state lives in the host process. Clients
  send actions and render state snapshots. Turn-based and real-time (tick loop up to
  60 Hz) both supported.
- **Zero-toolchain game authoring**: the host bundles game folders (esbuild) at
  startup. A game is a manifest + a server module + React views. No build step.

Deliberate non-goals: no security, no internet play, no persistence beyond the party.
It runs among trusted people in one room. See [docs/DESIGN.md](docs/DESIGN.md).

## Bundled games

| Game | Players | Style | Where it renders |
|---|---|---|---|
| **Blackjack** | 1–7 | turn-based, 5 hands vs dealer AI | your phone (TV shows the table) |
| **Trivia** | 1–16 | 10 timed questions, speed scoring | phone + TV question board |
| **Boom Grid** | 2–8 | real-time bomberman-style arena, 20 Hz | TV is the arena, phones are gamepads (falls back to on-phone rendering) |

More are planned — see [ROADMAP.md](ROADMAP.md) (single-player sessions, bots, the
next example game) and [BACKLOG.md](BACKLOG.md) for smaller deferred items.

## CLI

```
npx lan-party [options]
  --port <n>          Port (default 4700)
  --games-dir <path>  Extra games directory (default ./games if present).
                      Merged with the bundled games; on an id clash, yours wins.
  --no-shared-visual  Never offer the shared-screen role on the connect screen
  --fresh             Ignore the saved session and start a new party
```

### Installing games

```
npx lan-party add trivia                    from the curated registry
npx lan-party add github:owner/repo --trust  a GitHub repo
npx lan-party add ./path/to/game             a local folder or archive
npx lan-party list                           what's installed
npx lan-party remove someone/trivia          uninstall
npx lan-party validate ./my-game             does it build, run, and let go?
```

Games install into `./games` and are validated before they land: the manifest and
engine range are checked, the game is built, and its server is run in a child
process to confirm it survives junk input and releases the event loop afterwards.
A game that fails any of that is never placed.

**`--trust` is not a formality.** A game's `server.ts` runs in the host process with
full access to your files and network, so anything outside the curated registry
requires you to say so explicitly. Local paths don't — you could copy the folder into
`games/` yourself, which runs it just the same.

## Writing a game

**Read [docs/writing-a-game.md](docs/writing-a-game.md) first** — it is
self-contained and written so that a developer or an LLM with no other context about
this repo can produce a working game. (If you are an LLM that has been asked to build
a game on this framework: that guide, plus the three bundled games as reference
implementations, is everything you need.)

The short version — a game is a folder:

```
games/my-game/
  game.json    { id, name, description, minPlayers, maxPlayers,
                 teams: "none"|"optional"|"required", tickRate, displayMode }
  server.ts    default-exports createGame(ctx) — authoritative rules on the host
  client.tsx   default-exports a React component — the player's device
  shared.tsx   optional — the shared screen (required for displayMode "shared-arena")
```

The server module receives actions (`onAction`), optionally a `tick(dt)` at
`tickRate` Hz, and exposes state via `getPublicState` / `getPlayerState` /
`getSharedState`. It reports scores with `ctx.end({ pointsByPlayer })`, which feeds
the party ledger. Clients get `{ state, you, send, players, teams,
sharedVisualPresent, ... }` and just render. Types come from `lan-party/sdk`.

Drop the folder into `games/`, restart the host, and it's in the catalog. The
authoring contract is in [docs/writing-a-game.md](docs/writing-a-game.md); the
architecture is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```
npm install
npm run dev         # run the host from source (Node ≥ 20... 22.6+/25 for raw .ts)
npm test            # vitest: session + protocol integration tests
npm run typecheck
npm run build       # bundle the CLI to dist/ for publishing
```

Design decisions are logged in [docs/decisions.md](docs/decisions.md).
