# Writing a game for LAN Party

This guide is self-contained: it is written so that a developer — human or LLM — with
no other context about this repository can build a working game. The three bundled
games are reference implementations; steal from them liberally.

- `games/blackjack/` — turn-based phases with deadlines, per-turn order, dealer AI
- `games/trivia/` — simultaneous timed rounds, hidden answers, data file (JSON)
- `games/bomberman/` — real-time tick loop, TV-as-arena, phone-as-gamepad, canvas

## Mental model

One computer (the **host**) runs the server. Players join from phone/laptop browsers.
Optionally one browser is the **shared visual** — the TV in the room.

- **The host is authoritative.** Your `server.ts` owns all game state. Clients only
  send actions and render state snapshots. Never trust an action payload: validate
  everything (type, range, whose turn, phase).
- **State flows one way.** After every action and every tick, the host automatically
  re-serializes your state and broadcasts it to all clients. You never "send" anything
  from the server except by mutating your state (and calling `ctx.update()` for
  timer-driven changes).
- **Full snapshots, no diffing.** State must be JSON-serializable and reasonably
  compact (it's re-sent on every change; for real-time games at `tickRate` Hz).

## Anatomy of a game

A game is one folder dropped into `games/` (restart the host to pick it up):

```
games/my-game/
  game.json     manifest (required)
  server.ts     game rules, runs on the host in Node (required)
  client.tsx    React UI on each player's device (required)
  shared.tsx    React UI on the shared visual (optional*)
  anything else you want to import: helpers, data.json, styles.css
```

\* required if `displayMode` is `"shared-arena"`.

### game.json

The real file must be strict JSON (the comments below are annotation only):

```jsonc
{
  "id": "my-game",         // unique; convention: same as the folder name
  "name": "My Game",
  "description": "One line shown on the lobby card.",
  "minPlayers": 1,
  "maxPlayers": 8,
  "teams": "none",         // "none" | "optional" | "required"
  "tickRate": 0,           // 0 = event-driven; N>0 = host calls tick() N times/sec (max 60)
  "displayMode": "device", // "device" | "shared-arena" | "adaptive"
  "engine": "^0.1.0"       // which host versions this game works with
}
```

- `engine` — the host refuses to load a game that declares an incompatible range,
  with a message telling the player to update rather than a mystery crash. Standard
  npm range syntax (`^0.1.0`, `~0.1.0`, `>=0.1.0`, `0.1.x`, `*`). **While the engine
  is `0.x`, a minor bump may break games**, so `^0.1.0` accepts `0.1.9` but not
  `0.2.0` — that is npm's rule for `0.x` and the host follows it. Omitting the field
  is accepted but flagged: your game will load until the day it silently doesn't.

- `teams: "required"` — the lobby refuses to start unless every seated player is on a
  team and at least 2 teams are represented. `"none"` — your game never sees teams.
- `displayMode` (a *declaration of intent*; the framework never forces rendering):
  - `"device"` — gameplay renders on each player's device; `shared.tsx` (if present)
    shows ambient info (table overview, scoreboard).
  - `"shared-arena"` — the TV is the primary display; player devices are controllers.
    Your `client.tsx` must degrade when no TV is present (see `sharedVisualPresent`).
  - `"adaptive"` — you decide at runtime via `sharedVisualPresent`.

### Seating

When a game starts, the host seats up to `maxPlayers` **connected** players (earliest
joiners first) and freezes that roster: `ctx.players`. Players beyond `maxPlayers`,
and anyone joining mid-round, wait in the shell's waiting room — they are *not* your
concern. Nobody is added to `ctx.players` mid-round.

## server.ts

Default-export a factory. All types come from `lan-party/sdk` — **types only**; a
runtime import will break the build (the SDK has no runtime — this keeps games
dependency-free).

```ts
import type { GameContext, GameServer } from "lan-party/sdk";

export default function createGame(ctx: GameContext): GameServer {
  // Build initial state from ctx.players (and ctx.teams if you declared teams).
  const state = makeInitialState(ctx.players);

  return {
    onAction(playerId, action) {
      // action is typed `any` and is EXACTLY what a client sent — validate
      // everything before touching it. Canonical idiom:
      //   if (typeof action !== "object" || action === null) return;
      //   const a = action as { type?: unknown; ... };
      //   if (a.type === "hit" && itIsTheirTurn(playerId)) { ... }
      // Host rebroadcasts automatically after this returns.
    },
    tick(dtMs) {
      // Only called if manifest.tickRate > 0. dtMs = real elapsed ms.
      // Host rebroadcasts automatically after this returns.
    },
    onPlayerDisconnect(playerId) { /* optional — see "never stall" below */ },
    onPlayerReconnect(playerId) { /* optional */ },
    getPublicState() { return state.publicView; },       // sent to everyone
    getPlayerState(playerId) { return state.handOf(playerId); }, // optional, per-player private overlay
    getSharedState() { return state.tvExtras; },         // optional, TV only (shallow-merged over public)
  };
}
```

### GameContext

| member | meaning |
|---|---|
| `players: PlayerInfo[]` | seated roster, frozen at start. `PlayerInfo = { id, name, teamId }` (`teamId` is `null` — not absent — when the player has no team) |
| `teams: TeamInfo[]` | teams with seated members (`{ id, name, color }`); `[]` when teamless |
| `update()` | ask the host to rebroadcast **now**. Only needed after timer-driven mutations — actions and ticks rebroadcast automatically |
| `end(results)` | finish the round: `{ pointsByPlayer: Record<playerId, number>, summary?: string }`. Points are added to the party's cross-game ledger. Calling it twice is safe (second is ignored); after it, your instance is discarded |

### Rules the host enforces (and duties it expects)

1. **State must be JSON-serializable** (no functions, Dates, Maps, class instances in
   what the three `get*State` methods return).
2. **Validate every action.** Clients are untrusted input, period.
3. **Never stall.** A disconnected player must not freeze the game: auto-play their
   turn, skip them, or let a timeout resolve it. Use `onPlayerDisconnect` /
   `onPlayerReconnect` to track who's live. The framework will *not* pause for you.
4. **Timers are yours.** Use plain `setTimeout`/`setInterval` in `server.ts`, and call
   `ctx.update()` after any timer-driven state change. Convention for countdowns: put
   an absolute deadline (`Date.now() + ms`, epoch milliseconds) in public state and
   let clients render the countdown locally.
   ⚠️ If an admin force-ends your round, your pending timers still fire against a dead
   instance. `ctx.update()`/`ctx.end()` become no-ops and thrown errors are swallowed,
   so this is harmless — but guard your callbacks if they'd corrupt something.
5. **Exceptions are contained** — a throw in any of your callbacks is logged and
   swallowed; the game continues. Don't rely on this; it's a crash pad, not a pattern.
6. **Show the outcome before ending.** Convention: hold a short `results` phase
   (5–6 s) so players see final standings, then call `ctx.end`.
7. **Scoring guideline:** award roughly **0–100 points per round** (winner near the
   top of that range) so cross-game totals stay comparable. Not enforced.
8. `getPlayerState` is called per seated player; `getSharedState` result is
   shallow-merged **over** public state for the TV only.

## client.tsx and shared.tsx

Each default-exports a React component receiving `GameClientProps`:

```tsx
import type { GameClientProps } from "lan-party/sdk";
import "./styles.css"; // import CSS from client.tsx only; it's bundled globally

export default function MyGameClient({ game }: GameClientProps) {
  const { state, you, self, players, teams, points, send,
          sharedVisualPresent, isLead, role, manifest, gameId } = game;
  return <button onClick={() => send({ type: "grab" })}>Grab!</button>;
}
```

| prop on `game` | player device | shared visual |
|---|---|---|
| `state` | `getPublicState()` | public ⊕ `getSharedState()` merged |
| `you` | `getPlayerState(self.id)` | `undefined` |
| `self` | your `PlayerInfo` | `null` |
| `players` | seated roster | seated roster |
| `teams` | teams in play | teams in play |
| `points` | party-wide ledger (all games so far) | same |
| `send(action)` | delivers to `onAction` | **no-op** |
| `sharedVisualPresent` | is a TV connected? | `true` |
| `isLead` / `role` | party-lead flag / `"player"` | `false` / `"shared"` |

The component remounts fresh at round start and unmounts at round end; props are a new
object on every broadcast — plain `useState`/`useEffect` React, no store needed.
The shell owns the page chrome (header, reconnect banner); you own the viewport below
it. There is no shell-provided game-over screen — that's why your server holds a
results phase.

### UI rules that matter at a party

- **Mobile-first**: thumb-sized buttons (≥48 px), no hover-dependent UI, no tiny text.
- **Don't hand-roll movement controls** — import them (see below). If you do build a
  held control yourself, use pointer events (`onPointerDown`/`Up`/`Leave`/`Cancel`
  + `setPointerCapture`), never click, and set `touch-action: none` or the drag
  scrolls the page instead of driving your game.
- **Prefix every CSS class** with a short game slug (`bj-`, `tv-`, `bm-`, …): all
  games share one global stylesheet.
- Build on the shell's CSS variables — `--bg`, `--bg-raised`, `--bg-sunken`,
  `--border`, `--text`, `--text-muted`, `--accent`, `--accent-2`, `--good`, `--bad`,
  `--radius` — and utility classes `.card`, `.row`, `.muted`, `.small`, `.center`,
  `.spacer`, plus `button.primary/.ghost/.big/.small/.tiny/.danger`.
- `shared.tsx` is read from a couch: large type, high contrast, no interaction
  required (admin "End round" lives in the shell chrome, not your UI).
- Countdown bars: compute from the deadline in state (`deadline - Date.now()`), tick
  with `requestAnimationFrame` or a 250 ms interval. Don't trust phase durations —
  trust the deadline.

### Shared controls (`lan-party/sdk/controls`)

If your game needs directional movement, import the controls instead of building a
d-pad. This is the one framework module with a runtime dependency (React), which is
why it is a separate entry point from `lan-party/sdk`.

```tsx
import { ActionButton, Gamepad, Thumbstick } from "lan-party/sdk/controls";

<Gamepad compact={showArena}>
  <Thumbstick onChange={(dir) => game.send({ type: "move", dir })} />
  <ActionButton icon="💣" label="BOMB" hotkey="Space"
                onPress={() => game.send({ type: "bomb" })} />
</Gamepad>
```

- `Thumbstick` tracks the finger continuously and resolves to one of four
  directions (`"up" | "down" | "left" | "right"`, or `null` when centred). It
  **only calls `onChange` on a change**, so it is safe to send straight to the
  server — pointer events fire far faster than you want to emit. It also handles
  WASD/arrows (`keyboard={false}` to opt out) and emits `null` on unmount, so a
  round ending mid-drag can't leave a player walking.
- `ActionButton` fires on press, not release. `repeatMs` repeats while held;
  `hotkey` binds a `KeyboardEvent.code` for laptop players.
- Tune with `deadzone` (default `0.3` of the pad radius). The stick biases toward
  the direction already held so a thumb near a 45° diagonal doesn't chatter.
- Style them from your game's CSS — scope overrides under your own class
  (`.bm-client .lp-action { … }`) so you don't restyle every game's controls.

## Environment constraints (things that break builds)

- TypeScript is run through esbuild/Node type-stripping: **erasable syntax only** —
  no `enum`, no constructor parameter properties, no `namespace`. (`tsc --noEmit`
  with this repo's config catches all of it.)
- Two framework imports exist, and no others: `lan-party/sdk` (types only) and
  `lan-party/sdk/controls` (React touch controls, client side only). Games may not
  add npm dependencies; available at runtime: React (client side), Node built-ins
  (server side). JSON files can be imported directly on either side (bundled at
  build time).
- No DOM/React in `server.ts`; no Node APIs in `client.tsx`/`shared.tsx`. Files
  imported by *both* (constants, pure sim logic) must be free of either.
- The host builds all games at startup; a syntax error in your game prints a warning
  and can fail the boot — run the test below before shipping.

## Testing your game (do this before calling it done)

1. `npx tsc --noEmit` from the repo root — must be clean. If your game folder lives
   *outside* the repo, temp-copy it into `games/` for the typecheck (the repo
   tsconfig only includes repo-internal paths), then delete the copy.
2. Scripted round against the real server (Node ≥ 22.6 runs `.ts` directly). Write a
   throwaway script *outside* the repo — Node's built-in global `WebSocket` is all
   you need, no imports beyond the server itself:

```js
import { startServer } from "<repo>/src/server/index.ts";

// Returns { port, close }. With port: 0 the OS picks a free port — read s.port.
// gamesDir may be any directory of game folders (it's merged with the bundled
// games); cwd is where the session file/build cache land — use a tmp dir.
const s = await startServer({ port: 0, gamesDir: "<dir with your game>",
                              allowShared: true, fresh: true,
                              cwd: "<some tmp dir>", quiet: true });
const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
// Protocol cheat-sheet (JSON messages over that socket):
//   join:        {type:'join', token:'any-unique-string', name:'Ana', role:'player'}
//                (first joiner becomes the lead; role:'shared' for a fake TV;
//                 your playerId in all game callbacks/state === the token you sent)
//   start game:  {type:'lobby.admin', admin:{op:'startGame', gameId:'my-game'}}   (lead or shared only)
//   game action: {type:'game.action', action:{...}}                    // → your onAction
//   force end:   {type:'lobby.admin', admin:{op:'endGame'}}
// Server → client messages: {type:'session'|'joined'|'game.state'|'game.over'|'error', ...}
//   game.state = {gameId, state, you?, seated}  (seated: PlayerInfo[] of this round)
//   game.over  = {results: {gameId, gameName, pointsByPlayer, summary?}}
await s.close();
```

Assert the things that can silently rot: phase progression, your scoring math on a
hand you control exactly, a disconnect mid-turn not stalling the round, and
`game.over` carrying sane `pointsByPlayer`. The full protocol types live in
`src/shared/types.ts`.

## Checklist

- [ ] `game.json` valid; id unique; `shared.tsx` present if `shared-arena`
- [ ] every `onAction` payload validated; wrong-turn/wrong-phase actions ignored
- [ ] state JSON-serializable; secrets in `getPlayerState`, never in public state
- [ ] deadlines as epoch-ms in state; `ctx.update()` after every timer mutation
- [ ] disconnect can never stall the round (tested)
- [ ] results phase before `ctx.end`; points ≈ 0–100; summary string set
- [ ] CSS prefixed; touch targets big; works with and without a shared visual
- [ ] `tsc` clean + scripted e2e round passes
