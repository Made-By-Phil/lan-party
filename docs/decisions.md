# Decision log

Running log of design decisions and why they were made. Newest at the bottom.

1. **Browser-only clients.** Phones and laptops join via URL; no native apps. Removes
   all install friction, which is the point of a LAN party tool.

2. **Host-authoritative state.** All game state lives in the host process; clients send
   actions and render snapshots. Simplest possible mental model for game authors and
   makes cheating irrelevant on a trusted LAN.

3. **Identity via localStorage token, not IP.** The original idea was to track users by
   network address, but phones rotate IPs on wifi and two tabs on one laptop would
   collide. A random token generated on first join keeps the same "no security,
   no accounts" spirit while making refresh/reconnect actually resume your seat. IP is
   kept only as a debug label.

4. **Node + TypeScript + React** (user choice). One language across server, SDK, and
   all UIs; React for the shell and game clients.

5. **esbuild at host startup instead of a build step / Vite.** Games ship as plain
   TS/TSX source; the host bundles the shell + all game clients into one bundle per
   role and bundles each game's server module on boot. Consequences: game authors need
   zero toolchain, a single React instance is shared by shell and games, and adding a
   game folder requires a host restart (acceptable — parties restart hosts freely).

6. **One bundle per role containing every game.** No per-game lazy loading. At party
   scale (a handful of games, tens of KB each) the simplicity beats the download cost.

7. **Full-state JSON snapshots, no diffing.** On a LAN, bandwidth is free at this
   scale; games stay trivial to write. Real-time games broadcast at their tick rate
   (Bomberman: 30 Hz works fine for a 13×11 grid).

8. **Game folder = manifest + server.ts + client.tsx + optional shared.tsx.** The host
   trusts and runs game server code unsandboxed, consistent with the project's explicit
   no-security stance.

9. **displayMode is per-game, never mandated** (user decision). A game may render on
   devices, use the shared visual as the arena with phones as controllers, or adapt at
   runtime via `sharedVisualPresent`. Preserves maximum flexibility for game authors.

10. **Session persisted to disk** (user choice). Debounced writes of
    players/teams/points/history to `.lan-party/session.json`; host restarts resume the
    party, in-flight rounds are lost (rounds are short by design). `--fresh` opts out.

11. **npm package with CLI** (user choice). `npx lan-party`, flags `--port`,
    `--games-dir`, `--no-shared-visual`, `--fresh`; prints LAN URL + QR code.

12. **Party lead fallback for admin.** Shared visual holds admin functions, but a party
    may run without one, so the earliest-joined connected player is "party lead" with
    the same controls. Avoids a party with no way to start a game.

13. **Voting informs, doesn't auto-start.** Live vote tally in the lobby; a human
    (lead or shared-visual admin) pulls the trigger. Auto-start on majority felt
    fragile with people mid-conversation in a room.

14. **Points ledger is per-player; team scores are derived.** Storing team totals would
    desync when teams are reshuffled between games.

15. **Generic Trivia instead of "Trivial Pursuit".** The name is trademarked; the
    bundled game is a general trivia game with its own question pack.

16. **Scope held to three bundled games** (user decision): Blackjack, Trivia,
    Bomberman. Sketch & Guess, Buzzer Quiz, Word Imposter, and Snake Royale are logged
    in BACKLOG.md for a later session.

17. **Scoring magnitude is a guideline, not enforced.** Games are asked to award
    ~0–100 points per round so cross-game totals feel comparable, but the framework
    doesn't normalize — enforcement would need per-game knowledge it can't have.

18. **Over-capacity parties bench by join order.** If more players are connected than
    a game's maxPlayers, the earliest joiners are seated and the rest see a waiting
    room for that round. Refusing to start felt worse — big parties could never play
    small games.

19. **Catalog = bundled games ∪ user games dir, user wins on id collision.** Running
    `npx lan-party` anywhere still gives you the stock games; dropping a folder with
    the same id lets you fork/override a bundled game.

20. **Erasable TypeScript syntax only** (`erasableSyntaxOnly`). Dev mode runs raw
    `.ts` via Node's native type stripping (`node src/cli.ts`), which forbids
    parameter properties/enums. Cheap constraint, removes a whole dev toolchain.

21. **One client bundle, role picked at runtime.** Player and shared-visual UIs ship
    in the same app.js; the connect screen (or saved identity) decides the role. Two
    bundles bought nothing but build complexity.

22. **Kicks are honored client-side, not enforced.** Errors carry machine-readable
    codes; on `kicked` the client forgets its saved identity and stops auto-rejoining.
    A malicious client could rejoin — accepted under the no-security stance (the admin
    can kick again; the real remedy at a LAN party is social).

23. **Games style themselves via bundled CSS with a per-game class prefix**
    (`bj-`, `tv-`, `bm-`). One global stylesheet namespace, convention over tooling.

24. **The bomberman-style game ships as "Boom Grid"** (trademark caution, same as
    Trivia) and runs at 20 Hz, not 30 — a 15×13 grid streamed as full snapshots is
    perfectly smooth at 20 with a canvas renderer, and it halves broadcast traffic.

25. **Chain-detonation kills credit the owner of the chain-triggering bomb.** The
    player who set off the wave earned it; per-bomb attribution in a chain is
    ambiguous and feels arbitrary in play.

26. **Games can end early but always show a results beat.** All three bundled games
    hold a short results state (5–6s) before calling ctx.end, so players see the
    outcome before being dropped back in the lobby. Convention, not framework —
    a shell-owned podium screen is in the backlog.

27. **Documentation is validated by cold-context build, not review.** The authoring
    guide's sufficiency claim is tested by giving an agent only "read the README"
    and requiring a working, e2e-verified game with a list of every question the
    docs couldn't answer; those gaps get folded back in. The first run (2026-07-19)
    also caught a real SDK bug: external `--games-dir` folders couldn't resolve
    react — fixed by pointing esbuild's `nodePaths` at the framework's own
    node_modules.

## Game distribution (2026-07-19)

Design for downloading and installing third-party games. Nothing below is built
yet; recorded before implementation because several choices are expensive to
reverse once people depend on them.

28. **Per-game build isolation is a prerequisite, not a nicety.** Verified
    2026-07-19: a single syntax error in one game's `client.tsx` crashes the host
    with an unhandled esbuild stack trace and the party never starts. `discoverGames`
    is resilient per-game (bad manifest, missing entry) but `buildClientApp` compiles
    every game in one pass, so any compile error is fatal. Decision 8's comment that
    "one broken download shouldn't take the party down" is currently aspirational.
    This is invisible while the author writes every game and becomes the top support
    issue the moment strangers' code lands in the folder. Fix before shipping any
    install path.

29. **Official games live in a curated monorepo, not a federated registry.** One
    repo, games as folders, one CI validating all of them against the engine; the
    "registry index" is a generated `games.json` at its root. `add-game trivia`
    fetches that subfolder at a pinned tag. Rationale: the bottleneck is curation
    effort, not federation — an index of pointers to other people's repos multiplies
    breakage without reducing review load. Federate later only if third-party volume
    justifies it. A few games stay bundled in the main package so a fresh install is
    playable with no network.

30. **One installer path, pluggable resolvers.** `add-game trivia`,
    `github:user/repo`, a tarball URL, and a local zip all resolve to the same
    pipeline: fetch → verify → validate → unpack → atomic swap. Sources differ only
    in how they produce a tarball. `validate` is one implementation shared by the
    author-facing CLI command, the curated repo's CI, and the pre-swap install check.
    Note the GitHub-zip wrinkle: archive contents are wrapped in `repo-name-branch/`,
    so `game.json` sits one level too deep — detect and flatten, or every user hits it.

31. **Installing a game is explicitly a trust decision, and is not faked.** Game
    server code runs in the host Node process with full fs/network access
    (decision 8), so `add-game <arbitrary-url>` is `curl | bash` with better
    ergonomics. Decision 8's "no security" stance was about *players on a trusted
    LAN*; downloading changes the threat model to *code from the internet*, and the
    two shouldn't be conflated. Real Node sandboxing is a project in itself and a
    half-measure that implies safety is worse than none. Therefore: curated source is
    the default and frictionless; arbitrary sources require an explicit flag plus a
    prompt naming what is about to run; installs pin by commit SHA, never a branch,
    and are recorded in a lockfile.

32. **`game.json` carries an `engine` compatibility range, added before third-party
    games exist.** Without it, SDK changes break every third-party game silently with
    no way to say "this game needs a newer host." Nearly free now, unfixable
    retroactively — which is the entire reason it is decided at design time.

33. **Drop-in install with atomic swap; revises decision 5's "restart required".**
    Watch the games dir → debounce → build into a temp dir → swap only on success →
    broadcast a reload over the existing WS hub. A failed build leaves the running
    party untouched, which is the same mechanism decision 28 needs — one piece of
    machinery, two problems. Swaps are queued until the lobby, never applied
    mid-round. Reload is safe without warning players because identity is a
    localStorage token (decision 3), so everyone rejoins their seat automatically.

34. **Offline is the expected case, not the edge case.** A LAN party is exactly where
    the uplink is someone's flaky router. Games are cached, `add-game` is designed to
    run ahead of time, and `export`/`import` lets games travel on a USB stick.
    Guests are already connected to the host, so peer-pull of the host's games is the
    natural extension.

35. **The CLI is plumbing; installing from the party is the real UX.** The host is in
    a living room, not at a terminal. Browsing and installing from the shared screen
    or the lead's phone rides the admin channel that already exists (decision 12).
    Building only the CLI would leave installation a before-the-party activity.

36. **Game ids get namespaced to survive strangers.** `mergeCatalogs` resolves
    collisions as "user wins", which is right for a deliberate fork and wrong when two
    unrelated authors both pick `trivia`. Namespace as `author/game`, or detect and
    refuse at install time.

37. **Decision 6 (one bundle, every game) has a known expiry.** Fine at a handful of
    games; at fifty, every guest downloads all of them on join. Per-game lazy chunks
    are the eventual answer, and the isolation work in 28 is the natural moment to
    reconsider — see the open question below.

### Resolved (2026-07-20, implemented)

All questions above were settled by the user and built; what shipped differs from the
sketch in two places worth recording.

38. **Isolation keeps decision 6 intact — no lazy chunks.** Measured: 18 games rebuild
    in 107ms. A full rebuild is cheaper than the machinery required to avoid one, so
    installing a game rebuilds everything and clients reload. The rejected alternative,
    an "adjacent bundle" for the newly installed game, would have shipped a second copy
    of React in that chunk and broken hooks and context the moment a game rendered.
    Isolation is instead a fast-path/probe: keep the single combined pass, and only on
    failure compile each game alone to find the culprit. Decision 37's expiry still
    stands, just not yet.

39. **Installed games live in `./games`, full stop.** Rejected user-global
    `~/.lan-party/games`: one location means one answer to "where did my game go", and
    a party directory stays self-contained and copyable. `--games-dir` still redirects
    the whole thing.

40. **Engine version tracks the package version** (`0.1.0`), asserted by test so the
    two cannot drift. Minor on release, major on breaking SDK change. npm's `0.x`
    caret rule applies: while the engine is `0.x`, `^0.1.0` accepts `0.1.9` and
    rejects `0.2.0`, because every minor bump may break games.

41. **Namespacing was retrofitted and the orphaning accepted** (user decision) — this
    predates any distribution, so it is the cheapest it will ever be. A bare id is
    scoped to `local/` rather than rejected, keeping drop-in folders frictionless while
    guaranteeing a local sketch can never shadow an installed game.

42. **Repo-wide release tags; updates never forced.** Official games are validated as
    part of the release cycle. A game updating mid-party changes nothing for the
    running round: you keep playing.

43. **The SDK gained `dispose()`, found by running the smoke test on our own games.**
    Trivia and Blackjack create their own timers, the SDK had no teardown hook, and
    `GameRunner.stop()` only cleared its own tick interval — so every abandoned round
    leaked its pending timers, and "can this game be exited?" was unsatisfiable by any
    game using a timer. The authoring guide had documented this leak as *harmless*.
    `dispose()` is now called whenever a round ends, and `validate` fails a game still
    holding the event loop open, so the rule is enforced rather than advised.

44. **The trust boundary is the network, not the filesystem.** Curated registry installs
    are frictionless (and are the only thing installable from inside a party); GitHub
    and URL sources need `--trust` and say plainly that the game's server code will run
    with full access to files and network. Local paths need nothing: you could copy the
    folder into `games/` yourself and it would run just the same, so a prompt there
    would be theatre. In-party installing is deliberately registry-only — whether code
    should run on the host is the machine owner's call, not a room's.

## Blank install (2026-07-20)

45. **No games ship with the framework** (user decision). Trivia, Blackjack and Boom
    Grid moved to `Made-By-Phil/lan-party-games`; `games/` is gone from the package
    and from `files`. This resolves the open question above by dissolving it — with
    installation cheap and validated, "which games are bundled" stops being a design
    question and becomes a choice at install time, which is where the user's
    game-packs idea points anyway. A host is now a host and nothing else.

46. **The curated repo is a monorepo, and the index points into it.** A registry entry
    carries a `tarball` plus a `subdir`, so one download serves any game and there are
    no per-game release artifacts to keep in sync. This is what decision 29 described
    but the entry format could not express, so `subdir` was added.

47. **An empty catalog is a first-class state, not an error.** The host prints how to
    add a game instead of warning that the lobby is empty, and both lobbies show an
    empty state that points at the browser. A fresh install with no games is the
    normal starting point now, so it cannot read as broken.

48. **Tests own their fixtures.** The suite used the bundled games as test data, which
    silently coupled the engine's tests to a game collection that has now left the
    repo. `tests/fixtures/games/{alpha,beta}` are minimal, well-behaved games owned by
    the suite. Coupling tests to shipped content is how content becomes un-removable.

### Still open

- **`lan-party` is not published to npm.** `npx lan-party` does not work yet, and the
  games repo's CI builds the engine from source because `dist/` is gitignored. First
  publish is the unblocker for both.

## Game settings (2026-07-20)

49. **Settings are declared as data in `game.json`, never as code** (user request for
    per-game parameters). The manifest already reaches every client in the catalog, so
    the shell renders a generic form with zero game-side UI, and the host validates
    values without executing game code. Declaring them in `server.ts` would have meant
    a round-trip for the client to learn the schema and running game code for the host
    to police it.

50. **Three control types: number, boolean, select.** Free text is deliberately
    excluded — party settings are knobs, and a text field is an unbounded validation
    surface for no gain. Twelve settings maximum: past that a game wants a mode
    `select`, not more switches.

51. **The host coerces; the game trusts.** Every declared key is present in
    `ctx.settings`, clamped to range, snapped to step, and guaranteed to be one of the
    declared options. Games never re-default or re-validate — if a game writes
    `?? 10`, that 10 belonged in the manifest. Clients are untrusted here as
    everywhere: an out-of-range or off-menu value is ignored rather than stored.

52. **Settings are locked once a round starts.** Read at `createGame` and fixed for
    the round; changing the rules under a game in flight is never intended. The UI
    disables the controls and the host refuses the op, so the two cannot disagree.

53. **A malformed settings block refuses the game.** Consistent with the rest of
    manifest validation: it is an author error, caught by `validate` before install
    rather than surfacing as a broken form at a party. The smoke test also runs each
    game with its declared defaults, so defaults that crash a game never ship.

54. **Bots are a setting, not a framework feature — for now.** A `bots` number is the
    right way for a game to ask, and a host-authoritative game can simulate them
    internally today (Blackjack's dealer already does). Real bot *players* — in the
    roster, seated, scored in the ledger — need a seating and actor mechanism that
    does not exist yet, and is deliberately not implied by this feature.

## Bots and game structure (2026-07-20)

55. **Bots are per-game and never enter the party** (user decision, refining 54).
    There is no bot player type, no bot in the roster, no framework seating. What a
    bot *is* differs per game — a seat at a table, a colour on a grid, a second hand —
    and a framework abstraction would fit none of them well. Bots rank in the round's
    own standings so the results screen tells the truth about who won, but only real
    players' points reach `ctx.end`, and that ranking dies with the round.

56. **Seating is the game's business.** The framework hands over `ctx.players`, the
    real humans; filling the remaining seats up to a requested bot count is a game
    concern. This is what makes seat-order games (poker, or a Blackjack where players
    choose where to sit) expressible without the framework knowing what a seat is.
    Convention: namespace bot ids (`bot:0`) so they can never collide with a player's
    opaque token, and so the filter before `ctx.end` is self-evident.

57. **Any entry point may be a folder.** `client/index.tsx` and `server/index.ts` are
    accepted alongside the flat forms, so a game can grow modules — bots, rules,
    tests — without the framework caring. Declaring both forms is an error rather
    than a precedence rule: one file would be dead code and the author could not tell
    which. Files a game never imports are invisible to the build, so tests live beside
    the code they cover.

58. **`validate` and unit tests answer different questions, and both are documented.**
    `validate` asks "does it build, survive junk, and let go" — it will never catch a
    scoring bug. Game rules get pinned down by the game's own tests, which is why the
    guidance is to keep rules pure and inject RNG: a bot is only testable as a
    decision function, not as something wired into a live round.

## Validation tightened after a guide experiment (2026-07-20)

59. **The guide was tested by having an agent build five games from it alone, and the
    results drove both the guide and the validator.** Every game followed the rules
    the guide states plainly — `dispose()` where timers exist, engine declared,
    settings used, ids namespaced — and every game shipped defects in the areas the
    guide left to inference. That is the useful signal: the gaps were not where the
    guide was silent, but where it was *ambiguous*.

60. **`validate` typechecks the game.** esbuild strips types without checking them, so
    two games shipped with hard type errors — a `dir` widened to `string`, a client
    reading a field its own type never declared — and passed every check we had. The
    single highest-yield addition, and deterministic. TypeScript is resolved from the
    framework's install; if absent, the step is skipped with a warning rather than
    failing.

61. **`validate` runs every numeric setting at its min and max.** Three games shipped
    bugs visible only at an extreme: a winner scoring 10 instead of 95, points
    reaching 200, a round taking 110 minutes. The defaults-only smoke test waved all
    three through. Installs stay on defaults for speed; `validate` (authoring and CI)
    is the thorough one, `--quick` opts out.

62. **`validate` reports what a snapshot costs on the wire.** A real-time game was
    sending 8.7 KB ten times a second to every device — ~0.8 MB/s across a full party
    — because the guide only asked for state to be "reasonably compact". A warning
    above ~2 KB, scaled by tick rate. A warning, not a failure: some games legitimately
    carry a big board, and the author is better placed to judge.

63. **Scoring guidance changed from a range to a rule.** "Roughly 0–100 per round" was
    read by two independent games as "distribute a 100-point pool", which makes winning
    an 8-player game worth less than losing a 2-player one. It now states that 0–100 is
    per player, that the winner should land near 100 regardless of player count, and
    that scores must be normalised against settings — with the two real failure shapes
    written out.

64. **What automated validation still cannot do.** It cannot know what winning means:
    a game stored the judge's pick and never read it, so the winner was whichever
    submission shuffled first, and every check passed. It cannot see an information
    leak that the client merely declines to render. It cannot tell that auto-playing
    only the current turn leaves a two-player round taking 32 minutes. These stay in
    the guide and the checklist, and are the argument for each game unit-testing the
    function that decides its winner.
