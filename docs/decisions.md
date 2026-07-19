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
