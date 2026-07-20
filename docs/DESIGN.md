# LAN Party — Design

LAN Party is an opinionated backbone for building and playing quick local-multiplayer
games. One computer hosts a party; everyone else joins from their phone or laptop
browser over the local network. Games are drop-in folders. The framework provides the
lobby, identity, teams, cross-game points, voting, and a "shared visual" (the smart TV
in the room); games provide rules and UI.

This document is the source of truth for architecture and the SDK contract.
Decisions and their rationale live in [decisions.md](./decisions.md).

## Goals and non-goals

**Goals**
- Zero-friction join: open `http://<host-ip>:<port>` on any browser, type a name, play.
- Zero-friction game authoring: a game is a folder of TypeScript source. No build step,
  no per-game dependencies, no boilerplate beyond one manifest + three files.
- Support the full spectrum from turn-based (Blackjack) to real-time (Bomberman).
- Quick rounds. A game session should be minutes, not hours.

**Non-goals (deliberate limitations)**
- No security. No auth, no TLS, no sandboxing of game code. This runs on a trusted LAN
  among people in the same room.
- No internet play, no matchmaking, no persistence beyond the party session file.
- No replacing complex games. The SDK optimizes for small state machines and small
  real-time sims, not MMOs.

## System overview

```
┌────────────── Host computer ──────────────┐
│  lan-party CLI (Node)                     │
│  ├─ HTTP server: serves shell + bundles   │
│  ├─ WebSocket server: all realtime comms  │
│  ├─ Session: players, teams, points,      │
│  │   votes, phase (lobby | in-game)       │
│  ├─ Game loader: discovers games/,        │
│  │   bundles them (esbuild), runs the     │
│  │   active game's server module          │
│  └─ Session file: .lan-party/session.json │
└───────────────────────────────────────────┘
        ▲ ws                ▲ ws
   ┌────┴─────┐        ┌────┴───────────┐
   │ Players  │        │ Shared visual  │
   │ (phones, │        │ (the room TV)  │
   │ laptops) │        │ 0 or 1 per     │
   │ 1..N     │        │ party          │
   └──────────┘        └────────────────┘
```

- **The host is authoritative.** All game state lives in the host process. Clients send
  actions; the host broadcasts state snapshots. Clients render state, nothing more.
- **Roles.** A connection is either a `player` or the `shared` visual. On first
  connection, if no shared visual is designated (and `--no-shared-visual` wasn't
  passed), the connect screen offers both roles. At most one shared visual at a time.
- **Identity.** Each browser generates a random token stored in `localStorage` on first
  join. Token → player. Reconnects (page refresh, wifi blip, IP change) resume the same
  seat. The client's IP is recorded as a debug label only.
- **Admin.** The shared visual has admin controls (kick, adjust points, manage teams,
  start/end games). Because a party may have no shared visual, the earliest-joined
  connected player is the **party lead** and gets the same controls on their device.
- **Persistence.** The session (players, teams, points ledger, game history) is
  debounce-written to `.lan-party/session.json` in the working directory. Restarting
  the host resumes the party; clients auto-reconnect. In-flight game rounds are lost —
  rounds are short by design. `--fresh` starts a new session.

## The stack

- **Node ≥ 20, TypeScript everywhere** — server, SDK, shell, and games.
- **React** for all client UI (shell and games).
- **esbuild at host startup** is the only bundler. The host builds one player bundle and
  one shared-visual bundle, each containing the shell plus every discovered game's
  client code (single React instance, no dynamic-import machinery). It also bundles each
  game's server module to `.lan-party/build/` and `import()`s it. Adding a game folder =
  restart the host. Startup builds take well under a second.
- **`ws`** for WebSockets. JSON messages. Full-state snapshots, no diffing — LAN
  bandwidth makes this a non-problem at party scale, and it keeps games trivial to
  write.
- Dependencies are deliberately minimal: `ws`, `esbuild`, `react`, `react-dom`,
  `qrcode-terminal`.

## CLI

```
npx lan-party [options]
  --port <n>          Port (default 4700)
  --games-dir <path>  Games directory (default ./games)
  --no-shared-visual  Never offer the shared-visual role on the connect screen
  --fresh             Ignore any saved session file and start a new party
```

On start it prints the LAN URL (e.g. `http://192.168.1.23:4700`) and a QR code for it.

## Session model

```ts
Player   { id, name, connected, isLead, teamId | null, debugAddr }
Team     { id, name, color }
Session  { phase: 'lobby' | 'in-game', players, teams, points: Record<playerId, number>,
           votes: Record<playerId, gameId>, history: GameResult[], activeGameId | null }
```

- **Points** are a per-player ledger accumulated across games. Team scores are always
  derived (sum of members), never stored.
- **Voting**: in the lobby, each player may vote for one catalog game. Votes are
  tallied live; admin/lead starts a game (voting informs, doesn't auto-start).
- **Teams**: players self-select in the lobby; admin can also assign, shuffle, and
  auto-balance. Games declare `teams: "none" | "optional" | "required"` and the lobby
  enforces it at start time.
- **Late joiners** during a game land in a waiting screen and join the lobby when the
  round ends. Disconnected players keep their seat, points, and team.

## Game SDK

A game is a folder inside the games directory:

```
games/my-game/
  game.json     manifest
  server.ts     authoritative game logic (runs on the host, trusted, unsandboxed)
  client.tsx    player-device UI (React)
  shared.tsx    optional shared-visual UI (React)
  *             anything else the game wants to import (data files, helpers)
```

### game.json

```jsonc
{
  "id": "my-game",            // unique, matches folder name by convention
  "name": "My Game",
  "description": "One line shown in the catalog.",
  "minPlayers": 1,
  "maxPlayers": 8,
  "teams": "none",            // "none" | "optional" | "required"
  "tickRate": 0,              // Hz; 0 = event-driven (turn-based), >0 = host calls tick()
  "displayMode": "device"     // see below
}
```

**`displayMode` is a per-game choice** — the framework never mandates where a game
renders:
- `"device"` — gameplay renders on each player's device; a `shared.tsx`, if present,
  shows ambient info (scores, table state).
- `"shared-arena"` — the shared visual is the primary display (`shared.tsx` required);
  player devices render controllers. If the party has no shared visual, the player view
  should degrade to render the arena itself (the SDK exposes
  `sharedVisualPresent` so the client can adapt).
- `"adaptive"` — the game decides at runtime using `sharedVisualPresent`.

### server.ts contract

```ts
import type { GameServer, GameContext } from "lan-party/sdk";

export default function createGame(ctx: GameContext): GameServer {
  // build initial state from ctx.players / ctx.teams
  return {
    onAction(playerId, action) { ... },   // validate! clients are just suggestions
    tick(dtMs) { ... },                   // only called if manifest.tickRate > 0
    onPlayerDisconnect(playerId) { ... }, // optional
    onPlayerReconnect(playerId) { ... },  // optional
    getPublicState() { return ... },      // broadcast to everyone
    getPlayerState(playerId) { return ... }, // optional: private per-player overlay
    getSharedState() { return ... },      // optional: richer state for the shared visual
  };
}
```

`GameContext` provides:
- `players: PlayerInfo[]` — the seated roster (id, name, teamId) frozen at start.
- `teams: TeamInfo[]` — teams in play (empty when teamless).
- `update()` — ask the host to rebroadcast state now (for timer-driven changes;
  after `onAction` and `tick` the host rebroadcasts automatically).
- `end(results)` — finish the game: `{ pointsByPlayer: Record<playerId, number>,
  summary?: string }`. The lobby adds points into the party ledger and returns everyone
  to the lobby. Guideline: award on a ~0–100 scale per round so games feel comparable.

Rules the host enforces: state must be JSON-serializable; `onAction` payloads arrive
exactly as the client sent them (validate everything); after `end()` the instance is
discarded.

### client.tsx / shared.tsx contract

```tsx
import type { GameClientProps } from "lan-party/sdk";

export default function MyGameClient({ game }: GameClientProps) {
  const { state, you, self, players, teams, send, sharedVisualPresent, isLead } = game;
  // state  = getPublicState() (+ getSharedState() merged in on the shared visual)
  // you    = getPlayerState(self.id)  (undefined on the shared visual)
  // send(action) → server onAction   (no-op on the shared visual)
  return <button onClick={() => send({ type: "hit" })}>Hit</button>;
}
```

Both files default-export a React component. The shell owns the chrome (header,
connection status, leave button); the game owns everything inside its viewport.

## WebSocket protocol (shell ⇄ host)

One endpoint, JSON messages, `{ type, ... }`.

Client → host: `join {token, name, role}`, `lobby.rename`, `lobby.vote {gameId}`,
`lobby.joinTeam {teamId}`, `lobby.admin {op, ...}` (lead/shared only: kick,
adjustPoints, teams CRUD, autoBalance, startGame, endGame), `game.action {action}`.

Host → client: `joined {self, role}`, `session {session, catalog, sharedVisualPresent}`
(broadcast on any lobby/roster change), `game.state {gameId, state, you}`,
`game.over {results, session}`, `error {message}`.

The shell handles reconnection with exponential backoff and re-`join`s with its stored
token.

## Bundled games

| Game | Type | displayMode | Showcases |
|---|---|---|---|
| Blackjack | turn-based | device | private per-player state, turn order, dealer AI |
| Trivia | timed rounds | adaptive | timers, simultaneous answers, speed scoring |
| Boom Grid | real-time 20 Hz | shared-arena | tick loop, phone-as-gamepad, arena on TV |

Further game ideas are tracked in [BACKLOG.md](../BACKLOG.md).

## Repository layout

```
src/
  cli.ts             argument parsing → startServer()
  server/            http, ws, session, game loader/builder, qr
  shared/types.ts    protocol + SDK types (imported by server, shell, and games)
  sdk.ts             public SDK surface re-exported for game authors
shell/               React apps: player.tsx, shared.tsx, connection + game host views
games/               installed games (empty on a fresh install)
docs/                DESIGN.md, decisions.md
```
