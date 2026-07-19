// Presentational pieces shared by the phone client and the TV view.

import { useEffect, useState } from "react";
import { isRed, type Card } from "./cards.ts";
import type { Phase, PublicSeat } from "./types.ts";

/** Seconds remaining until an epoch-ms deadline, ticking locally. */
export function useCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);
  if (deadline == null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function CountdownPill({ deadline }: { deadline: number | null }) {
  const secs = useCountdown(deadline);
  if (secs == null) return null;
  return (
    <span className={`bj-timer${secs <= 5 ? " bj-urgent" : ""}`}>{secs}s</span>
  );
}

export function CardView({ card, down }: { card?: Card; down?: boolean }) {
  if (down || !card) {
    return <div className="bj-card bj-card-down" aria-label="face-down card" />;
  }
  return (
    <div className={`bj-card ${isRed(card.s) ? "bj-red" : "bj-black"}`}>
      <span className="bj-rank">{card.r}</span>
      <span className="bj-suit">{card.s}</span>
    </div>
  );
}

export function HandView({
  cards,
  holeHidden,
  small,
}: {
  cards: Card[];
  holeHidden?: boolean;
  small?: boolean;
}) {
  return (
    <div className={`bj-hand${small ? " bj-hand-small" : ""}`}>
      {cards.map((c, i) => (
        <CardView key={i} card={c} />
      ))}
      {holeHidden && <CardView down />}
    </div>
  );
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "betting":
      return "Place your bets";
    case "turns":
      return "Player turns";
    case "dealer":
      return "Dealer plays";
    case "payout":
      return "Hand results";
    case "results":
      return "Final standings";
  }
}

export function seatStatusLabel(p: PublicSeat, isTurn: boolean): string {
  if (p.status === "out") return "out of chips";
  if (p.status === "betting") return "betting…";
  if (p.status === "bet") return `bet ${p.bet}`;
  if (p.status === "blackjack") return "blackjack!";
  if (p.status === "busted") return "busted";
  if (isTurn) return "deciding…";
  if (p.status === "stood") return p.doubled ? `doubled · ${p.total}` : `stood · ${p.total}`;
  return "waiting";
}

export function resultLabel(p: PublicSeat): string {
  switch (p.result) {
    case "blackjack":
      return `Blackjack! +${p.net}`;
    case "win":
      return `Won +${p.net}`;
    case "push":
      return "Push";
    case "lose":
      return p.status === "busted" ? `Busted −${-p.net}` : `Lost −${-p.net}`;
    default:
      return "";
  }
}

export function resultClass(p: PublicSeat): string {
  if (p.result === "win" || p.result === "blackjack") return "bj-good";
  if (p.result === "lose") return "bj-bad";
  return "bj-mutedres";
}

/** Final standings, best chips first. */
export function Standings({ players }: { players: PublicSeat[] }) {
  const sorted = [...players].slice().sort((a, b) => b.chips - a.chips);
  return (
    <ol className="bj-standings">
      {sorted.map((p, i) => (
        <li key={p.id} className="bj-standing-row">
          <span className="bj-standing-place">{i + 1}</span>
          <span className="bj-standing-name">{p.name}</span>
          <span className="bj-standing-chips">{p.chips} chips</span>
          <span className={p.chips >= 100 ? "bj-good" : "bj-bad"}>
            {p.chips >= 100 ? `+${p.chips - 100}` : `${p.chips - 100}`}
          </span>
        </li>
      ))}
    </ol>
  );
}
