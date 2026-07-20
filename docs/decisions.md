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

### Still open

- **Which bundled games stay in the main package** once the curated repo exists. The
  user's "game packs, or a completely blank install" idea points past this: bundling
  becomes a choice at install time rather than a fixed set.
- **The curated repo does not exist yet.** `Made-By-Phil/lan-party-games` is wired in
  as the default registry and every code path is exercised against a local stand-in,
  but until that repo is published `add <name>` will fail with a 404.
