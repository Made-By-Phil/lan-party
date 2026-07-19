# Roadmap

Where LAN Party is headed. Nothing in this file is implemented yet — these are
design sketches agreed on 2026-07-19, written down so a future session (or a
context-free LLM) can pick any of them up. Smaller deferred items live in
[BACKLOG.md](BACKLOG.md); the SDK contract lives in
[docs/writing-a-game.md](docs/writing-a-game.md) and [docs/DESIGN.md](docs/DESIGN.md).

## The thesis: LLM-authored games

The short-term measure of success: a user prompts an LLM ("build me a game where…",
recommend Claude Fable/Opus) pointed at this repo, and gets a working game folder.
The framework's real product surface is therefore **the documentation and the SDK**,
in that order. `docs/writing-a-game.md` is written to be sufficient on its own;
every support question an LLM can't answer from the docs is a documentation bug —
file it in the gaps list below.

**Validated 2026-07-19:** a cold-context agent given only "read the README" built a
new game (reaction-duel, out-of-repo folder via `--games-dir`) with a passing 12-check
e2e and zero reads of framework source. The gaps it surfaced were folded back into
the guide the same day; the ones that remain are listed below.

## Single-player sessions

**What already works:** `minPlayers: 1` is honored end-to-end today (Blackjack is
playable solo right now: join, start, play against the dealer). Nothing in the
session model assumes >1 player.

**What's missing** is intent, not mechanics:

- The lobby is multiplayer-shaped: a solo player still walks through voting/teams UI
  that means nothing at n=1. Sketch: when exactly one player is connected, the lobby
  collapses to a "quick start" list (tap a game, you're in).
- The phone-as-controller paradigm should carry over: a solo game with a TV should
  feel like a console. `displayMode: "shared-arena"` already expresses this; solo is
  just the 1-player case.
- Manifest may want a `soloFriendly: true` hint so the lobby can badge games that are
  actually fun alone (Boom Grid with `minPlayers: 2` isn't — until bots exist).
- Bots (below) are the other half of single-player: they make the existing
  multiplayer catalog solo-playable.

**Example game to build for this: "Paddle Panic"** (brick-breaker):

- `minPlayers: 1, maxPlayers: 4, teams: "none", tickRate: 30, displayMode: "shared-arena"`.
- TV renders the brick field; the phone is a controller: a horizontal touch-strip
  slider (absolute position, not buttons) driving your paddle, which is the perfect
  stress test for the controller paradigm beyond d-pads.
- Solo: classic lives-and-levels. 2–4 players: paddles share the bottom edge
  (split lanes), shared lives pool, points per brick — a cooperative couch game.
- No shared visual present → arena renders on the phone above the touch-strip
  (same degrade pattern as Boom Grid).
- Scoring: bricks + level-clear bonus, normalized to the ~0–100 guideline.

## Bots — first-class, per-session

**Goal:** a party of 2 can still play an 8-player game; a party of 1 can play
anything. Bots are added in the lobby, per session, by the lead or shared-visual
admin.

**Session model** (framework side):

- New admin ops: `addBot` / `removeBot`. A bot is a synthetic `Player` with
  `isBot: true`, a generated name ("Bot Ziggy"), `connected: true`, no socket. It
  can be kicked, assigned to teams, and accrues points in the ledger like anyone —
  bots persist for the whole party, so cross-game standings stay coherent.
- `isBot` is added to `Player`/`PlayerInfo` (SDK-visible, so games and UIs can
  badge them). Bots never become party lead.
- Seating treats bots as ordinary players. The lobby's Add-bot button is gated per
  game by manifest capability (below), and the shell shows bot chips in rosters.

**Game model** (SDK side) — bots' *behavior* belongs to the game, not the framework
(a generic framework AI can't play Blackjack and Boom Grid):

- Manifest gains `bots: "unsupported" | "supported"` (default `"unsupported"`).
  Bots can always be added to the party; when a game that doesn't support them is
  started, its seating simply skips bots for that round (same benching mechanism as
  over-capacity parties).
- The game server sees bots in `ctx.players` with `isBot: true` and drives them
  itself: in `tick()` for real-time games, or with the same timers it already uses
  for turn deadlines in turn-based games (a bot is essentially a player whose
  timeout always fires, but smarter). Recommended shape: a `bots.ts` module per game
  with a `decideAction(state, botId): Action | null` function called from
  tick/timers, feeding the normal action path so bots obey the same validation as
  humans.
- Optional later: manifest `botDifficulty` levels surfaced in the lobby.

**Retrofit plan for the bundled games:** Blackjack (basic-strategy hit/stand table —
easy), Trivia (answer after a random delay with accuracy by difficulty — easy),
Boom Grid (walk-toward-crates + flee-blast pathing — the fun one), Paddle Panic
(track ball x with capped paddle speed).

## Known gaps — flagged as future work

Documentation gaps:

- No annotated end-to-end example in docs of a *minimal* game (a 30-line
  rock-paper-scissors would make the contract obvious faster than the three real
  games).
- `docs/writing-a-game.md` documents the testing recipe but the repo has no
  `lan-party new` scaffold or test harness helper to hand authors a starting point.
- No documented versioning/compat story for `game.json` (what happens when the SDK
  adds fields — currently: unknown fields ignored, missing fields defaulted, but
  that's convention, not contract).
- No worked example of a per-round placement scoring scheme in the guide (the
  0–100 guideline is stated; the cold-context agent wanted a model to copy).

Implementation gaps (SDK/framework):

- **No `onDestroy` lifecycle hook**: on admin force-end, a game's pending
  `setTimeout`s fire against a discarded instance. Harmless today (update/end are
  no-op'd, throws swallowed) but it's a leak and a footgun for games that touch
  external resources. Add `destroy?()` to `GameServer`.
- **Client clock skew**: countdown deadlines are host epoch-ms; a phone with a
  skewed clock renders wrong countdowns. Fix: include `serverNow` in each
  `game.state`/`session` message, let the shell maintain an offset and expose
  `game.now()` in the client SDK.
- **No late-join opt-in**: seated rosters are frozen; games like Trivia could
  happily absorb mid-round joiners. Sketch: manifest `lateJoin: true` +
  `onPlayerJoin` callback.
- **No spectating**: benched/late players get a waiting card even though public
  state is already broadcast to them; the shell could render the game's shared (or
  client) view read-only. (Also in BACKLOG.)
- **No in-place typecheck for out-of-repo game folders** — authors must temp-copy
  into `games/` to run `tsc` (a `lan-party typecheck <dir>` command or a shipped
  game-tsconfig would remove the dance).
- **SDK is types-only** — deliberate and good, but it means every game hand-rolls
  countdown bars, standings tables, and results overlays. A small optional
  `lan-party/ui` component kit (Countdown, Standings, ResultsOverlay) would cut
  boilerplate in every future LLM-built game.
- Hot reload of game folders; `lan-party new <name>` scaffolder; shell-owned podium
  screen; sound hooks — all in [BACKLOG.md](BACKLOG.md).
- Not yet published to npm (`npx lan-party` works from a checkout/`npm pack` only).
- No automated browser-level QA (games are e2e-tested over WebSocket, but no one
  has automated a real phone-viewport click-through; manual playtest pending).

## Next session

Playtest feedback from tonight's session (logged by Phil) drives the agenda;
candidates in rough order: game-feel fixes from playtest → bots (framework +
Blackjack/Trivia retrofits) → Paddle Panic → single-player lobby polish →
`onDestroy` + clock skew fixes.
