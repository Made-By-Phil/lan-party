# Writing a game for LAN Party

This guide is self-contained: it is written so that a developer — human or LLM — with
no other context about this repository can build a working game. The curated games
are reference implementations; steal from them liberally.

Reference games live in [lan-party-games](https://github.com/Made-By-Phil/lan-party-games) — clone it to read along:

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

A game is one folder dropped into `games/` — a running host picks it up and reloads
everyone, never mid-round:

```
games/my-game/
  game.json     manifest (required)
  server.ts     game rules, runs on the host in Node (required; or server/index.ts)
  client.tsx    React UI on each player's device (required; or client/index.tsx)
  shared.tsx    React UI on the shared visual (optional*)
  anything else you want to import: helpers, data.json, styles.css
```

\* required if `displayMode` is `"shared-arena"`.

### game.json

The real file must be strict JSON (the comments below are annotation only):

```jsonc
{
  "id": "you/my-game",     // namespaced "scope/name"; bare ids become "local/my-game"
  "name": "My Game",
  "description": "One line shown on the lobby card.",
  "minPlayers": 1,
  "maxPlayers": 8,
  "teams": "none",         // "none" | "optional" | "required"
  "tickRate": 0,           // 0 = event-driven; N>0 = host calls tick() N times/sec (max 60)
  "displayMode": "device", // "device" | "shared-arena" | "adaptive"
  "engine": "^0.1.0",      // which host versions this game works with
  "settings": []           // optional knobs the party sets before a round
}
```

- `id` — namespaced `scope/name`, lowercase letters, digits and dashes, so two
  authors can both ship a `trivia`. A bare id is scoped to `local/` automatically:
  dropping an unpublished folder into `games/` stays frictionless, and a local sketch
  can never shadow an installed game. Players never see the id — only `name`.
- `settings` — see [Settings](#settings) below. Declare knobs as data and the shell
  renders the form for you; you never write settings UI.
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
    dispose() { clearTimeout(myTimer); },                // optional — see "timers are yours"
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
| `settings: GameSettings` | values for the knobs your `game.json` declares, already validated and clamped — every declared key is present. See [Settings](#settings) |
| `update()` | ask the host to rebroadcast **now**. Only needed after timer-driven mutations — actions and ticks rebroadcast automatically |
| `end(results)` | finish the round: `{ pointsByPlayer: Record<playerId, number>, summary?: string }`. Points are added to the party's cross-game ledger. Calling it twice is safe (second is ignored); after it, your instance is discarded |

### Rules the host enforces (and duties it expects)

1. **State must be JSON-serializable** (no functions, Dates, Maps, class instances in
   what the three `get*State` methods return).
2. **Validate every action.** Clients are untrusted input, period.
3. **Never stall — and "never" means every later turn too.** A disconnected player
   must not freeze the game. **Auto-playing only the turn they were on is not
   enough**: record that they are gone and keep auto-playing or skipping them on
   every subsequent turn. Two real games got this wrong and a two-player round
   where one person leaves took *32 minutes* of dead air, one turn timeout at a
   time — technically "resolved by a timeout", practically a dead party.
   - Track liveness in your own state from `onPlayerDisconnect` /
     `onPlayerReconnect`; the framework will not pause, skip, or remove anyone.
   - An auto-played move is still a move that player is scored on. Pick a
     plausible one, not `legalMoves[0]` — the first legal index tends to be the
     worst square on the board.
   - **Real-time games:** none of "auto-play their turn" applies to a
     continuously-moving avatar. Decide explicitly what happens to it — freeze it,
     remove it from the world, or let it run — and decide whether an absent player
     still appears in `pointsByPlayer`. Leaving a ghost that keeps moving, keeps
     killing people and keeps scoring is the default if you decide nothing.
4. **Timers are yours — and so is releasing them.** Use plain
   `setTimeout`/`setInterval` in `server.ts`, and call `ctx.update()` after any
   timer-driven state change. Convention for countdowns: put an absolute deadline
   (`Date.now() + ms`, epoch milliseconds) in public state and let clients render the
   countdown locally.
   **Cancel a phase's timer when that phase ends early, not only in `dispose()`.**
   If everyone acts before the deadline, the deadline timer is still armed and will
   fire into a later phase — the classic "the round skipped itself" bug. `validate`
   cannot see it, because `dispose()` does clean up eventually.
   **Clear every timer in `dispose()`.** The host calls it when the round ends for any
   reason, including an admin force-end. Nothing else can release your timers: the
   host cannot see them. `ctx.update()`/`ctx.end()` are no-ops afterwards, so a stray
   callback is survivable, but each abandoned round leaks its pending timers and the
   host can never fully let go of the game. **`lan-party validate` fails a game that
   is still holding the event loop open after `dispose()`**, so this is enforced, not
   merely advised.
5. **Exceptions are contained** — a throw in any of your callbacks is logged and
   swallowed; the game continues. Don't rely on this; it's a crash pad, not a pattern.
6. **Show the outcome before ending.** Convention: hold a short `results` phase
   (5–6 s) so players see final standings, then call `ctx.end`.
7. **Scoring: 0–100 is per player, not a pool to divide.** The winner of a round
   should score near 100 **no matter how many people are seated or how the settings
   are turned**, so totals stay comparable across games.
   Two mistakes shipped in real games here:
   - *Splitting one 100-point pool between players.* `round(100 * mine / total)` makes
     winning an 8-player game worth ~20 and a 2-player game worth ~60. Normalise
     against the **best possible or best actual score**, not the sum:
     `round(100 * mine / bestScore)`.
   - *Letting a setting scale the score.* `points = wins * 20` pays 60 at
     `rounds: 3` and 200 at `rounds: 10`. Normalise against the setting too, and
     check the arithmetic at **both ends** of every numeric knob.
   A useful check: at every combination of settings, does the winner land near 100
   and nobody exceed it?
8. **Hidden information is hidden per phase.** `getPlayerState` is called per seated
   player; `getSharedState` is shallow-merged **over** public state for the TV only.
   Build `getPublicState()` *from the current phase* and **omit a secret field
   entirely** while it must stay secret — do not include it and rely on the client
   not to render it. A shipped game broadcast every player's answer the moment it
   was submitted, while others were still choosing; the UI simply didn't draw it.
   Anything in public state is in devtools, on the wire, and in every player's hands.
9. **A pending transition must not leave the old phase live.** If you pause on a
   timer — to show a resolved trick before clearing it — move to a blocking phase
   *immediately* and let the timer only move you out of it. A shipped game left
   `phase` and `turn` unchanged during a 900 ms pause, so the player who had just
   played could legally play a second card into a full trick. Your `onAction`
   guards were all correct; the state they guarded was stale.

## Real-time games (`tickRate > 0`)

Everything above still applies; these are the parts that only bite at 10–60 Hz, and
every one of them shipped as a bug in a real game.

- **Budget your public state.** Every client receives the whole snapshot on every
  tick: at `tickRate` N, that is `sizeof(getPublicState()) × N` bytes per second, to
  *each* phone plus the TV. A shipped game sent a 1440-cell grid twice over — 8.7 KB,
  10 times a second, ~87 KB/s per device and ~0.8 MB/s across a full party, on
  someone's home wifi. **Keep a real-time snapshot under ~2 KB**; `lan-party validate`
  warns above that. Put anything only the TV renders in `getSharedState()`.
- **Actions are a second broadcast channel.** The host rebroadcasts after *every*
  accepted action, not just every tick. A thumbstick drag emits several direction
  changes between ticks, each forcing a full broadcast to everyone. Treat `onAction`
  as cheap bookkeeping that records intent, and let `tick()` do the work.
- **Decide what `dtMs` means and be consistent.** `tick(dtMs)` is not called on a
  perfect schedule. Either accumulate `dtMs` into a fixed-step loop, or scale all
  motion by it — but never mix the two. A shipped game moved riders exactly one cell
  per call while counting respawn timers in real milliseconds, so a busy host quietly
  made the game shorter in distance travelled while the on-screen clock was unaffected.
- **Resolve simultaneous interactions in two passes.** Compute every player's intended
  move first, then apply outcomes. Iterating the roster in order and mutating as you
  go means seat 0 wins every head-on collision, all round — a hidden advantage nobody
  can see and nobody chose.

## Bots

**Bots belong to your game, not to the framework.** There is no bot player type, no
bot in the roster, and no framework seating for them. That is deliberate: what a bot
*is* differs per game — a seat at a table, a colour on a grid, a second hand — and a
framework abstraction would fit none of them well.

The contract:

- **Bots never touch the party ledger.** `ctx.end({ pointsByPlayer })` accepts real
  player ids only. Points for a bot id are meaningless: a bot has no seat in the
  lobby, no name in the scoreboard, and no history.
- **Bots do appear in the round's own standings.** Your public state can rank bots
  alongside players so the results screen tells the truth about who won the round.
  That ranking dies with the round; only players' points survive it.
- **Your game decides how bots take seats.** The framework hands you
  `ctx.players` — the real, seated humans. Anything else at the table is yours to
  invent. The usual pattern: fill remaining seats up to the requested bot count.

```ts
const wanted = ctx.settings.bots as number;
const seats = [
  ...ctx.players.map((p) => ({ kind: "player" as const, id: p.id, name: p.name })),
  ...Array.from({ length: wanted }, (_, i) => ({
    kind: "bot" as const,
    id: `bot:${i}`,      // namespaced so it can never collide with a player token
    name: BOT_NAMES[i],
  })),
];
```

Namespacing bot ids (`bot:0`) matters: player ids are opaque client tokens, and an
un-prefixed `"1"` could one day collide. It also makes the filter at the end obvious:

```ts
const pointsByPlayer = Object.fromEntries(
  standings
    .filter((s) => !s.id.startsWith("bot:"))   // bots score nothing in the party
    .map((s) => [s.id, s.points]),
);
ctx.end({ pointsByPlayer, summary });          // summary may still name a bot as winner
```

Two things to get right:

- **Bots must not stall the round.** If a bot acts on a timer, that timer is yours to
  clear in `dispose()` like any other. If a bot's turn resolves instantly, still route
  it through the same state machine as a human's turn — a separate "bot path" is where
  divergence bugs live.
- **Bot difficulty is a setting, not a constant.** If you find yourself tuning a
  magic number, it belongs in `game.json`.

## Structuring a game as it grows

A game starts as three files and that is fine. When it outgrows them, **any entry
point can become a folder** — the host accepts `client.tsx` *or* `client/index.tsx`,
and the same for `server` and `shared`:

```
games/my-game/
  game.json
  server/
    index.ts          default-exports createGame — the entry point
    rules.ts          pure game logic
    bots.ts           bot heuristics
    bots.test.ts      tests, beside the code they cover
  client/
    index.tsx         default-exports the React component
    Board.tsx
  shared.tsx          still flat — mix and match freely
  styles.css
```

Declaring both `client.tsx` and `client/index.tsx` is an error rather than a
precedence rule: one of them would be dead code and you could not tell which.

## Testing your game's mechanics

Files a game never imports — `*.test.ts` next to the code — are invisible to the
build, so tests can live wherever they are most useful.

The framework gives you two testing tools, and they answer different questions:

| | question | run it |
|---|---|---|
| `npx tsc --noEmit` | is it even type-correct? | first, and often |
| `lan-party validate <dir>` | does it typecheck, build, survive junk input, run at every setting extreme, and let go? | before install, in CI |
| your own `*.test.ts` | are the *rules* right? | while writing the game |

`validate` typechecks because esbuild **strips types without checking them** — a game
with hard type errors builds, runs, and used to pass. It also runs your game at the
min and max of every numeric setting, because "works on the defaults" is where three
shipped bugs hid.

`validate` will never catch a scoring bug. Unit tests are where game logic is
actually pinned down, and they pay off most for exactly the things bots need:

- **Keep rules pure.** A function from `(state, action) → state` is testable without
  a host, a socket, or a timer. Push side effects to the edges.
- **Inject randomness.** A shuffle or a bot's dice roll should take an RNG argument
  so a test can pass a seeded one. `Math.random()` inside your rules makes the
  interesting cases untestable.
- **Test the bot as a decision function.** `decide(hand, upcard) → "hit" | "stand"`
  is a table of cases; a bot wired into a live round is not.
- **Unit-test the function that decides who wins.** `validate` never runs your rules.
  A shipped game stored the judge's pick and then never read it — the winner was
  whichever submission happened to be shuffled first. It passed every automated check
  we had, because no automated check can know what winning means in your game.
- **Test both extremes of every numeric setting.** A game that works at `rounds: 10`
  and breaks at `rounds: 1` passes `validate` and fails at the party.

The curated collection ([lan-party-games](https://github.com/Made-By-Phil/lan-party-games))
runs `vitest` across every game, so a game placed there gets its tests run in CI.
For a standalone game, any test runner works — nothing in the framework depends on it.

## Sharing the state shape

Declare your public-state interface **once**, in a file free of DOM and Node imports,
and have `getPublicState()` return that type. A hand-written copy of the shape on the
client drifts silently: a shipped game's client read `rider.knockouts` off a type that
never declared it (the server did send it), and its results screen coloured players by
rank position instead of seat because the standings type omitted `seat` entirely — so
the right colour was not even recoverable on the client.

`npx tsc --noEmit` catches this class of bug in a second. `lan-party validate` now runs
it for you.

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

## Settings

Games that need parameters — rounds, scoring rules, difficulty, how many bots —
declare them in `game.json`. The shell renders the form, the host validates every
value, and your server receives them on `ctx.settings`. **You never write settings
UI, and you never validate settings input.**

```jsonc
"settings": [
  { "key": "rounds", "label": "Rounds", "type": "number",
    "default": 10, "min": 5, "max": 20, "step": 1 },
  { "key": "speedBonus", "label": "Speed bonus", "type": "boolean", "default": true,
    "help": "Faster answers score more" },
  { "key": "difficulty", "label": "Difficulty", "type": "select", "default": "normal",
    "options": [{ "value": "easy",   "label": "Easy" },
                { "value": "normal", "label": "Normal" },
                { "value": "hard",   "label": "Hard" }] }
]
```

```ts
export default function createGame(ctx: GameContext): GameServer {
  const rounds = ctx.settings.rounds as number;        // already clamped to 5..20
  const hard = ctx.settings.difficulty === "hard";     // always one of the options
  // ...
}
```

- **Three types**: `number` (renders a slider — give it `min`/`max`, optionally
  `step`), `boolean` (a switch), `select` (a menu). Free text is deliberately absent:
  party settings are knobs, and a text box is a validation problem wearing a hat.
- **Every declared key is always present** in `ctx.settings`, already coerced to the
  right type and clamped to your range. Don't default them again — if you find
  yourself writing `?? 10`, the manifest is where that 10 belongs.
- **Values are host-side.** Clients send a change request; the host checks it against
  your spec and ignores anything that doesn't fit, so a hostile client cannot hand you
  `rounds: 9999`.
- **Who can change them**: the shared screen, or the party lead when there isn't one.
  Everyone else sees the current values on the game card — people should know what
  they're voting for.
- **Locked during a round.** Settings are read once when the round starts; changing
  the rules mid-game is never what anyone meant. Read them in `createGame` and keep
  your own copy.
- **Choices persist** with the party (`.lan-party/session.json`) and survive host
  restarts. `--fresh` resets them.
- **Removing or renaming a setting is safe**: stored values for keys you no longer
  declare are dropped, and a stored value that no longer fits (you narrowed a range)
  falls back to your default.
- Max 12 settings. If you need more, the game probably wants a mode `select` rather
  than twelve switches.

A bad schema is an author error, not a runtime surprise: the host refuses to load a
game whose `settings` block is malformed, and `lan-party validate` reports it. The
smoke test runs your game with its declared defaults, so defaults that crash your game
never reach a party.

A `bots` number setting is the usual way to ask for bots — see [Bots](#bots).

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

- [ ] `npx tsc --noEmit` is clean — esbuild strips types, it does not check them
- [ ] `lan-party validate <your-folder>` passes (typechecks, builds, runs at every
      setting extreme, and lets go)
- [ ] any tunable constant is a `settings` entry, not a magic number in source
- [ ] bots (if any) score nothing in `pointsByPlayer`, but do rank in the round
- [ ] rules are pure and RNG is injected, so the mechanics have real tests
- [ ] game plays correctly at both extremes of every numeric setting
- [ ] `game.json` valid; id namespaced `scope/name`; `engine` range declared;
      `shared.tsx` present if `shared-arena`
- [ ] every timer cleared in `dispose()`
- [ ] every `onAction` payload validated; wrong-turn/wrong-phase actions ignored
- [ ] state JSON-serializable; secrets in `getPlayerState`, never in public state,
      and public state rebuilt per phase so nothing leaks early
- [ ] real-time only: snapshot under ~2 KB; `dtMs` handled one way, not two
- [ ] deadlines as epoch-ms in state; `ctx.update()` after every timer mutation
- [ ] a player who leaves is skipped on *every* later turn, not just the one
      they were on; a real-time game decides what happens to their avatar
- [ ] winner scores near 100 at every player count and every setting value;
      nobody exceeds it
- [ ] results phase before `ctx.end`; points ≈ 0–100; summary string set
- [ ] CSS prefixed; touch targets big; works with and without a shared visual
- [ ] `tsc` clean + scripted e2e round passes
