// Trivia — player device UI. Fully self-sufficient: shows the question,
// answer buttons, countdown, reveal, and standings on the phone itself.
import type { GameClientProps } from "lan-party/sdk";
import {
  AnsweredRoster,
  CountdownBar,
  LETTERS,
  Standings,
  TeamTotals,
  type TriviaState,
} from "./parts.tsx";
import "./styles.css";

export default function TriviaClient({ game }: GameClientProps) {
  const state = game.state as TriviaState;
  const you = game.you as { pick: number | null } | undefined;
  const meId = game.self?.id ?? null;

  if (!state || !state.phase) return null;

  if (state.phase === "results") {
    return (
      <div className="tv-screen">
        <h2 className="tv-results-title">Final standings</h2>
        <TeamTotals teams={game.teams} teamTotals={state.teamTotals} />
        <div className="card">
          <Standings state={state} players={game.players} meId={meId} />
        </div>
        <p className="tv-wait">Back to the lobby in a moment…</p>
      </div>
    );
  }

  const isReveal = state.phase === "reveal";
  const myPick = isReveal ? state.reveal?.picks[meId ?? ""]?.choice ?? null : you?.pick ?? null;
  const myReveal = isReveal && meId ? state.reveal?.picks[meId] : undefined;

  return (
    <div className="tv-screen">
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
            if (i === state.reveal?.correct) cls += " tv-correct";
            else if (i === myPick) cls += " tv-wrong";
            else cls += " tv-dim";
          } else if (i === myPick) {
            cls += " tv-selected";
          }
          return (
            <button
              key={i}
              className={cls}
              disabled={isReveal}
              onClick={() => game.send({ type: "answer", choice: i })}
            >
              <span className="tv-letter">{LETTERS[i] ?? "?"}</span>
              <span>{text}</span>
            </button>
          );
        })}
      </div>

      {isReveal ? (
        <>
          <div
            className={
              myReveal?.correct
                ? "tv-verdict tv-good"
                : myPick === null
                  ? "tv-verdict"
                  : "tv-verdict tv-bad"
            }
          >
            {myReveal?.correct
              ? `Correct! +${myReveal.points}`
              : myPick === null
                ? `Time's up — the answer was ${LETTERS[state.reveal?.correct ?? 0]}`
                : `Wrong — the answer was ${LETTERS[state.reveal?.correct ?? 0]}`}
          </div>
          <TeamTotals teams={game.teams} teamTotals={state.teamTotals} />
          <div className="card">
            <Standings state={state} players={game.players} meId={meId} showDeltas />
          </div>
        </>
      ) : (
        <>
          <AnsweredRoster state={state} players={game.players} />
          {myPick !== null && (
            <p className="tv-wait small">
              Locked in {LETTERS[myPick]} — you can still change your mind.
            </p>
          )}
        </>
      )}
    </div>
  );
}
