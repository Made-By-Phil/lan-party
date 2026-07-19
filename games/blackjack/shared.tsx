// Blackjack — shared visual (the TV). Whole-table overview, readable from a couch.

import type { GameClientProps } from "lan-party/sdk";
import type { PublicState } from "./types.ts";
import {
  CountdownPill,
  HandView,
  phaseLabel,
  resultClass,
  resultLabel,
  seatStatusLabel,
  Standings,
} from "./ui.tsx";

export default function BlackjackShared({ game }: GameClientProps) {
  const state = game.state as PublicState;

  return (
    <div className="bj-shared">
      <div className="bj-shared-topbar">
        <span className="bj-handno">
          Hand {state.hand} of {state.totalHands}
        </span>
        <span className="bj-phaselabel">{phaseLabel(state.phase)}</span>
        <CountdownPill deadline={state.deadline} />
      </div>

      {state.phase === "results" ? (
        <div className="bj-pod">
          <h3>Final standings</h3>
          <Standings players={state.players} />
        </div>
      ) : (
        <>
          <div className="bj-shared-dealer">
            <div className="bj-panel-head">
              <h3>Dealer</h3>
              {state.dealer.cards.length > 0 && (
                <span className="bj-total">
                  {state.dealer.total}
                  {state.dealer.holeHidden
                    ? "+"
                    : state.dealer.total > 21
                      ? " · bust"
                      : ""}
                </span>
              )}
            </div>
            {state.dealer.cards.length > 0 ? (
              <HandView cards={state.dealer.cards} holeHidden={state.dealer.holeHidden} />
            ) : (
              <span className="muted">Shuffling…</span>
            )}
          </div>

          <div className="bj-table">
            {state.players.map((p) => {
              const isTurn = state.phase === "turns" && state.turn === p.id;
              return (
                <div
                  key={p.id}
                  className={`bj-pod${isTurn ? " bj-turn" : ""}${p.connected ? "" : " bj-offline"}`}
                >
                  <div className="bj-pod-head">
                    <span className="bj-pod-name">{p.name}</span>
                    {p.cards.length > 0 && (
                      <span className="bj-total">
                        {p.total}
                        {p.soft ? "s" : ""}
                      </span>
                    )}
                    <span className="bj-pod-chips">
                      {p.chips} chips{p.bet > 0 ? ` · bet ${p.bet}` : ""}
                    </span>
                  </div>
                  {p.cards.length > 0 && <HandView cards={p.cards} small />}
                  <div className="bj-pod-status">
                    {state.phase === "payout" && p.result ? (
                      <span className={resultClass(p)}>{resultLabel(p)}</span>
                    ) : (
                      seatStatusLabel(p, isTurn)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
