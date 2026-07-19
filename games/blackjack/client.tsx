// Blackjack — phone/laptop player view.

import type { GameClientProps } from "lan-party/sdk";
import "./styles.css";
import { BET_OPTIONS, type PublicSeat, type PublicState } from "./types.ts";
import {
  CountdownPill,
  HandView,
  phaseLabel,
  resultClass,
  resultLabel,
  seatStatusLabel,
  Standings,
} from "./ui.tsx";

export default function BlackjackClient({ game }: GameClientProps) {
  const state = game.state as PublicState;
  const me = game.self ? state.players.find((p) => p.id === game.self!.id) : undefined;

  return (
    <div className="bj-root">
      <div className="bj-topbar">
        <span className="bj-handno">
          Hand {state.hand}/{state.totalHands}
        </span>
        <span className="bj-phaselabel">{phaseLabel(state.phase)}</span>
        <CountdownPill deadline={state.deadline} />
      </div>

      {state.phase === "results" ? (
        <div className="bj-panel">
          <div className="bj-panel-head">
            <h4>Final standings</h4>
          </div>
          <Standings players={state.players} />
          <p className="bj-hint">Back to the lobby in a moment…</p>
        </div>
      ) : (
        <>
          <DealerPanel state={state} />
          {me && <YouPanel state={state} me={me} send={game.send} />}
          <OthersStrip state={state} selfId={game.self?.id ?? null} />
        </>
      )}
    </div>
  );
}

function DealerPanel({ state }: { state: PublicState }) {
  const { dealer } = state;
  const showTotal = dealer.cards.length > 0;
  return (
    <div className="bj-panel">
      <div className="bj-panel-head">
        <h4>Dealer</h4>
        {showTotal && (
          <span className="bj-total">
            {dealer.total}
            {dealer.holeHidden ? "+" : dealer.total > 21 ? " · bust" : ""}
          </span>
        )}
      </div>
      {dealer.cards.length > 0 ? (
        <HandView cards={dealer.cards} holeHidden={dealer.holeHidden} />
      ) : (
        <p className="bj-hint">Waiting for the deal…</p>
      )}
    </div>
  );
}

function YouPanel({
  state,
  me,
  send,
}: {
  state: PublicState;
  me: PublicSeat;
  send: (action: unknown) => void;
}) {
  const myTurn = state.phase === "turns" && state.turn === me.id;
  return (
    <>
      <div className={`bj-panel bj-you-panel${myTurn ? " bj-yourturn" : ""}`}>
        <div className="bj-panel-head">
          <h4>You</h4>
          {me.cards.length > 0 && (
            <span className="bj-total">
              {me.total}
              {me.soft ? " soft" : ""}
            </span>
          )}
          {me.status === "blackjack" && <span className="bj-good">Blackjack!</span>}
          {me.status === "busted" && <span className="bj-bad">Busted</span>}
        </div>
        {me.cards.length > 0 && <HandView cards={me.cards} />}
        <div className="bj-chipline">
          <span>
            Chips <strong>{me.chips}</strong>
          </span>
          {me.bet > 0 && (
            <span>
              Bet <strong>{me.bet}</strong>
              {me.doubled ? " (doubled)" : ""}
            </span>
          )}
        </div>
      </div>
      <Controls state={state} me={me} myTurn={myTurn} send={send} />
    </>
  );
}

function Controls({
  state,
  me,
  myTurn,
  send,
}: {
  state: PublicState;
  me: PublicSeat;
  myTurn: boolean;
  send: (action: unknown) => void;
}) {
  if (me.status === "out") {
    return <p className="bj-hint">Out of chips — sitting out the rest of the round.</p>;
  }

  if (state.phase === "betting") {
    if (me.status === "betting") {
      return (
        <>
          <div className="bj-bets">
            {BET_OPTIONS.map((amount) => (
              <button
                key={amount}
                className="primary big"
                disabled={amount > me.chips}
                onClick={() => send({ type: "bet", amount })}
              >
                {amount}
              </button>
            ))}
          </div>
          <p className="bj-hint">Pick your bet for this hand.</p>
        </>
      );
    }
    return <p className="bj-hint">Bet {me.bet} locked in — waiting for the others…</p>;
  }

  if (state.phase === "turns") {
    if (myTurn) {
      const canDouble = me.cards.length === 2 && me.chips >= me.bet;
      return (
        <div className="bj-actions">
          <button className="primary big" onClick={() => send({ type: "hit" })}>
            Hit
          </button>
          <button className="ghost big" onClick={() => send({ type: "stand" })}>
            Stand
          </button>
          <button
            className="ghost big"
            disabled={!canDouble}
            onClick={() => send({ type: "double" })}
          >
            Double
          </button>
        </div>
      );
    }
    const turnName = state.players.find((p) => p.id === state.turn)?.name;
    if (me.status === "blackjack") {
      return <p className="bj-hint">Blackjack — sit back and enjoy it.</p>;
    }
    if (me.status === "busted") {
      return <p className="bj-hint">Busted this hand. {turnName ? `${turnName} is up.` : ""}</p>;
    }
    return <p className="bj-hint">{turnName ? `${turnName} is deciding…` : "Waiting…"}</p>;
  }

  if (state.phase === "dealer") {
    return <p className="bj-hint">Dealer is playing…</p>;
  }

  if (state.phase === "payout" && me.result) {
    return <div className={`bj-result-banner ${resultClass(me)}`}>{resultLabel(me)}</div>;
  }

  return null;
}

function OthersStrip({ state, selfId }: { state: PublicState; selfId: string | null }) {
  const others = state.players.filter((p) => p.id !== selfId);
  if (others.length === 0) return null;
  return (
    <div className="bj-others">
      {others.map((p) => {
        const isTurn = state.phase === "turns" && state.turn === p.id;
        return (
          <div
            key={p.id}
            className={`bj-mini${isTurn ? " bj-turn" : ""}${p.connected ? "" : " bj-offline"}`}
          >
            <div className="bj-mini-name">{p.name}</div>
            <div className="bj-mini-line">
              {p.chips} chips{p.bet > 0 ? ` · bet ${p.bet}` : ""}
            </div>
            <div className="bj-mini-line">
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
  );
}
