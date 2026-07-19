# Backlog

Ideas deliberately deferred to keep scope manageable. Roughly ordered.

## More bundled games
- **Sketch & Guess** — Pictionary-style: one player draws on their phone, the drawing
  streams live to the shared visual, others type guesses. Showcases streaming input,
  asymmetric roles, and timers.
- **Buzzer Quiz** — fastest-finger quiz: question on the shared visual, phones become
  big buzzer buttons. Showcases low-latency races resolved by the authoritative host.
  Very little UI; quick to build.
- **Word Imposter** — social deduction: everyone secretly gets the same word except one
  imposter; discussion happens in the room, voting on phones. Showcases hidden
  per-player state and voting mechanics.
- **Snake Royale** — multiplayer snake battle on the shared visual, phones as steering
  controllers. A second real-time/controller showcase.

## Framework
- Hot-reload of game folders (watch games dir, rebuild bundles, refresh clients)
  instead of requiring a host restart.
- Spectator support: let late joiners watch the in-progress game via shared state
  instead of a waiting screen.
- Sound effects hooks in the SDK (host-triggered cues playing on the shared visual).
- `lan-party new <name>` scaffolding command for game authors.
- Game-over podium/celebration screen owned by the shell (currently each game rolls
  its own end screen).
- Optional vote-to-start auto-launch when everyone has voted for the same game.
- Publish a game folder format spec + example standalone repo demonstrating
  "download a game folder into games/".
