// Trivia — shared visual (the room TV). Big question, live answered tally,
// reveal highlight, and a persistent leaderboard sidebar. Couch-readable.
import type { GameClientProps } from "lan-party/sdk";
import {
  AnsweredRoster,
  CountdownBar,
  LETTERS,
  Standings,
  TeamTotals,
  type TriviaState,
} from "./parts.tsx";

export default function TriviaShared({ game }: GameClientProps) {
  const state = game.state as TriviaState;
  if (!state || !state.phase) return null;

  const isReveal = state.phase === "reveal";

  if (state.phase === "results") {
    return (
      <div className="tv-shared">
        <div className="tv-shared-main">
          <h1 className="tv-results-title">Final standings</h1>
          <TeamTotals teams={game.teams} teamTotals={state.teamTotals} />
          <div className="card">
            <Standings state={state} players={game.players} />
          </div>
        </div>
      </div>
    );
  }

  // Who picked what, shown next to each choice during the reveal.
  const pickersByChoice = new Map<number, string[]>();
  if (isReveal && state.reveal) {
    for (const p of game.players) {
      const pick = state.reveal.picks[p.id];
      if (!pick) continue;
      const list = pickersByChoice.get(pick.choice) ?? [];
      list.push(p.name);
      pickersByChoice.set(pick.choice, list);
    }
  }

  return (
    <div className="tv-shared">
      <div className="tv-shared-main">
        <div className="tv-topline">
          <span className="tv-qnum">
            Question {state.qNum}/{state.qTotal}
          </span>
          <span className="tv-category">{state.category}</span>
        </div>
        <CountdownBar state={state} />
        <div className="tv-question">{state.question}</div>

        <div className="tv-choices">
          {state.choices.map((text, i) => {
            let cls = "tv-choice";
            if (isReveal) {
              cls += i === state.reveal?.correct ? " tv-correct" : " tv-dim";
            }
            return (
              <div key={i} className={cls}>
                <span className="tv-letter">{LETTERS[i] ?? "?"}</span>
                <span>{text}</span>
                {isReveal && (pickersByChoice.get(i)?.length ?? 0) > 0 && (
                  <span className="tv-pickers">
                    {pickersByChoice.get(i)!.map((name) => (
                      <span key={name} className="tv-picker-chip">
                        {name}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {isReveal ? (
          <div className="tv-verdict tv-good">
            {LETTERS[state.reveal?.correct ?? 0]} — {state.choices[state.reveal?.correct ?? 0]}
          </div>
        ) : (
          <AnsweredRoster state={state} players={game.players} />
        )}
      </div>

      <aside className="tv-sidebar">
        <h3>Leaderboard</h3>
        <TeamTotals teams={game.teams} teamTotals={state.teamTotals} />
        <div className="card">
          <Standings state={state} players={game.players} showDeltas={isReveal} />
        </div>
      </aside>
    </div>
  );
}
