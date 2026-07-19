// Card primitives for Blackjack. Pure data + pure functions, shared by the
// server (hand math) and the clients (rendering).

export type Suit = "♠" | "♥" | "♦" | "♣";

export interface Card {
  /** Rank: "A", "2".."10", "J", "Q", "K". */
  r: string;
  s: Suit;
}

export const SUITS: readonly Suit[] = ["♠", "♥", "♦", "♣"];
export const RANKS: readonly string[] = [
  "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
];

/** Build a shuffled multi-deck shoe. */
export function buildShoe(decks: number): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) shoe.push({ r, s });
    }
  }
  // Fisher–Yates.
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shoe[i]!;
    shoe[i] = shoe[j]!;
    shoe[j] = tmp;
  }
  return shoe;
}

function rankValue(r: string): number {
  if (r === "A") return 11;
  if (r === "K" || r === "Q" || r === "J") return 10;
  return parseInt(r, 10);
}

/** Best blackjack value of a hand; soft = an ace is still counted as 11. */
export function handValue(cards: readonly Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += rankValue(c.r);
    if (c.r === "A") aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

/** A natural: exactly two cards making 21. */
export function isBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function isRed(s: Suit): boolean {
  return s === "♥" || s === "♦";
}
