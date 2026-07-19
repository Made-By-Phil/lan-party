// Shape of the public game state broadcast to every client. The server builds
// it, both UIs consume it. Blackjack is played open at a party — nothing is
// private, so there is no per-player overlay.

import type { Card } from "./cards.ts";

export type Phase = "betting" | "turns" | "dealer" | "payout" | "results";

export type SeatStatus =
  | "betting"   // picking a bet this hand
  | "bet"       // bet locked, waiting for the deal
  | "playing"   // dealt in, hasn't finished their turn yet
  | "stood"     // done (stand, double resolved, or auto-stand)
  | "busted"    // went over 21
  | "blackjack" // dealt a natural; skips their turn
  | "out";      // fewer than 5 chips — sits out the remaining hands

export type HandResult = "win" | "blackjack" | "push" | "lose" | null;

export interface PublicSeat {
  id: string;
  name: string;
  chips: number;
  /** Current hand's bet (already deducted from chips; doubled if doubled). */
  bet: number;
  cards: Card[];
  total: number;
  soft: boolean;
  status: SeatStatus;
  doubled: boolean;
  /** Set during payout/results: outcome of the hand. */
  result: HandResult;
  /** Chip profit/loss of the hand (+bet, +ceil(1.5*bet), 0, -bet). */
  net: number;
  connected: boolean;
}

export interface PublicState {
  phase: Phase;
  /** 1-based hand number. */
  hand: number;
  totalHands: number;
  /** Epoch ms when the current phase auto-advances, or null. */
  deadline: number | null;
  /** Player id whose turn it is (turns phase only). */
  turn: string | null;
  dealer: {
    /** Visible cards only — the hole card is omitted while hidden. */
    cards: Card[];
    holeHidden: boolean;
    /** Value of the visible cards. */
    total: number;
  };
  players: PublicSeat[];
}

export const BET_OPTIONS = [5, 10, 15, 25] as const;
