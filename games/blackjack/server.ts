// Blackjack — authoritative game server. Five hands, everyone starts with 100
// chips, open cards, dealer hits to 16 / stands on all 17s.

import type { GameContext, GameServer } from "lan-party/sdk";
import { buildShoe, handValue, isBlackjack, type Card } from "./cards.ts";
import {
  BET_OPTIONS,
  type HandResult,
  type Phase,
  type PublicState,
  type SeatStatus,
} from "./types.ts";

const TOTAL_HANDS = 5;
const START_CHIPS = 100;
const MIN_BET = 5;
const DECKS = 4;
const RESHUFFLE_BELOW = 52; // rebuild the shoe before a deal when it runs low
const BET_MS = 20_000;
const TURN_MS = 25_000;
const DEALER_STEP_MS = 700; // pacing between dealer draws
const PAYOUT_MS = 3_500; // how long the per-hand results stay up
const RESULTS_MS = 5_000; // final standings before ctx.end

interface Seat {
  id: string;
  name: string;
  chips: number;
  bet: number;
  cards: Card[];
  status: SeatStatus;
  doubled: boolean;
  result: HandResult;
  net: number;
  connected: boolean;
}

export default function createGame(ctx: GameContext): GameServer {
  const seats: Seat[] = ctx.players.map((p) => ({
    id: p.id,
    name: p.name,
    chips: START_CHIPS,
    bet: 0,
    cards: [],
    status: "betting",
    doubled: false,
    result: null,
    net: 0,
    connected: true,
  }));

  let phase: Phase = "betting";
  let hand = 1;
  let deadline: number | null = null;
  let shoe: Card[] = buildShoe(DECKS);
  let dealerCards: Card[] = [];
  let holeHidden = true;
  let turnIdx = -1;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** One pending timer at a time; every phase transition re-arms or replaces it. */
  function setTimer(ms: number, fn: () => void): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!ended) fn();
    }, ms);
  }

  function draw(): Card {
    let c = shoe.pop();
    if (!c) {
      shoe = buildShoe(DECKS);
      c = shoe.pop()!;
    }
    return c;
  }

  // ---- hand lifecycle -----------------------------------------------------

  function startBetting(): void {
    phase = "betting";
    dealerCards = [];
    holeHidden = true;
    turnIdx = -1;
    let anyoneCanBet = false;
    for (const s of seats) {
      s.bet = 0;
      s.cards = [];
      s.doubled = false;
      s.result = null;
      s.net = 0;
      if (s.chips >= MIN_BET) {
        s.status = "betting";
        anyoneCanBet = true;
      } else {
        s.status = "out";
      }
    }
    if (!anyoneCanBet) return finishRound(); // whole table is broke — wrap up early
    deadline = Date.now() + BET_MS;
    setTimer(BET_MS, () => {
      for (const s of seats) if (s.status === "betting") placeBet(s, MIN_BET);
      ctx.update();
    });
    // Disconnected players never stall the table: bet the minimum for them now.
    for (const s of seats) {
      if (s.status === "betting" && !s.connected) placeBet(s, MIN_BET);
    }
  }

  function placeBet(s: Seat, amount: number): void {
    if (phase !== "betting" || s.status !== "betting") return;
    s.bet = amount;
    s.chips -= amount;
    s.status = "bet";
    maybeDeal();
  }

  function maybeDeal(): void {
    if (phase !== "betting") return;
    if (seats.some((s) => s.status === "betting")) return;
    deal();
  }

  function deal(): void {
    if (shoe.length < RESHUFFLE_BELOW) shoe = buildShoe(DECKS);
    const active = seats.filter((s) => s.status === "bet");
    for (const s of active) s.cards = [draw()];
    dealerCards = [draw()];
    for (const s of active) s.cards.push(draw());
    dealerCards.push(draw()); // hole card
    holeHidden = true;
    for (const s of active) {
      s.status = isBlackjack(s.cards) ? "blackjack" : "playing";
    }
    phase = "turns";
    turnIdx = -1;
    advanceTurn();
  }

  function advanceTurn(): void {
    let i = turnIdx + 1;
    while (i < seats.length && seats[i]!.status !== "playing") i++;
    if (i >= seats.length) return startDealer();
    turnIdx = i;
    const s = seats[i]!;
    if (!s.connected) {
      // Auto-stand disconnected players and keep the table moving.
      s.status = "stood";
      return advanceTurn();
    }
    armTurnTimer(s);
  }

  function armTurnTimer(s: Seat): void {
    deadline = Date.now() + TURN_MS;
    setTimer(TURN_MS, () => {
      if (phase === "turns" && seats[turnIdx] === s && s.status === "playing") {
        s.status = "stood";
        advanceTurn();
        ctx.update();
      }
    });
  }

  function startDealer(): void {
    phase = "dealer";
    holeHidden = false;
    deadline = null;
    dealerStep();
  }

  function dealerStep(): void {
    // The dealer only draws if someone stood; busts and naturals are already
    // decided. Hits to 16, stands on all 17s.
    const mustDraw =
      seats.some((s) => s.status === "stood") && handValue(dealerCards).total < 17;
    setTimer(DEALER_STEP_MS, () => {
      if (mustDraw) {
        dealerCards.push(draw());
        dealerStep();
      } else {
        payout();
      }
      ctx.update();
    });
  }

  function payout(): void {
    phase = "payout";
    const dealerBJ = isBlackjack(dealerCards);
    const dealerTotal = handValue(dealerCards).total;
    for (const s of seats) {
      if (s.bet === 0) continue; // sat out
      if (s.status === "busted") {
        s.result = "lose";
        s.net = -s.bet;
      } else if (s.status === "blackjack") {
        if (dealerBJ) {
          s.result = "push";
          s.net = 0;
          s.chips += s.bet;
        } else {
          const prize = Math.ceil(s.bet * 1.5);
          s.result = "blackjack";
          s.net = prize;
          s.chips += s.bet + prize;
        }
      } else {
        // stood (including resolved doubles and auto-stands)
        const total = handValue(s.cards).total;
        if (dealerBJ) {
          s.result = "lose";
          s.net = -s.bet;
        } else if (dealerTotal > 21 || total > dealerTotal) {
          s.result = "win";
          s.net = s.bet;
          s.chips += s.bet * 2;
        } else if (total === dealerTotal) {
          s.result = "push";
          s.net = 0;
          s.chips += s.bet;
        } else {
          s.result = "lose";
          s.net = -s.bet;
        }
      }
    }
    deadline = Date.now() + PAYOUT_MS;
    setTimer(PAYOUT_MS, () => {
      if (hand >= TOTAL_HANDS) {
        finishRound();
      } else {
        hand++;
        startBetting();
      }
      ctx.update();
    });
  }

  function finishRound(): void {
    phase = "results";
    turnIdx = -1;
    deadline = Date.now() + RESULTS_MS;
    setTimer(RESULTS_MS, () => {
      ended = true;
      const pointsByPlayer: Record<string, number> = {};
      for (const s of seats) pointsByPlayer[s.id] = Math.max(0, s.chips - START_CHIPS);
      const top = Math.max(...seats.map((s) => s.chips));
      const winners = seats.filter((s) => s.chips === top);
      const summary =
        winners.length === 1
          ? `${winners[0]!.name} wins with ${top} chips`
          : `${winners.map((w) => w.name).join(" and ")} tie at ${top} chips`;
      ctx.end({ pointsByPlayer, summary });
    });
  }

  // Kick off hand 1 immediately.
  startBetting();

  // ---- GameServer ---------------------------------------------------------

  return {
    dispose() {
      ended = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    onAction(playerId, action) {
      if (ended || typeof action !== "object" || action === null) return;
      const type = (action as { type?: unknown }).type;
      const seat = seats.find((s) => s.id === playerId);
      if (!seat) return;

      if (type === "bet") {
        const amount = (action as { amount?: unknown }).amount;
        if (phase !== "betting" || seat.status !== "betting") return;
        if (typeof amount !== "number") return;
        if (!(BET_OPTIONS as readonly number[]).includes(amount)) return;
        if (amount > seat.chips) return;
        placeBet(seat, amount);
        return;
      }

      // Turn actions: only the seat whose turn it is.
      if (phase !== "turns") return;
      const current = seats[turnIdx];
      if (!current || current.id !== playerId || current.status !== "playing") return;

      if (type === "hit") {
        seat.cards.push(draw());
        const { total } = handValue(seat.cards);
        if (total > 21) {
          seat.status = "busted";
          advanceTurn();
        } else if (total === 21) {
          seat.status = "stood"; // nothing left to decide
          advanceTurn();
        } else {
          armTurnTimer(seat); // fresh clock for the next decision
        }
      } else if (type === "stand") {
        seat.status = "stood";
        advanceTurn();
      } else if (type === "double") {
        // Only as the first decision, and only if they can cover the raise.
        if (seat.cards.length !== 2 || seat.chips < seat.bet) return;
        seat.chips -= seat.bet;
        seat.bet *= 2;
        seat.doubled = true;
        seat.cards.push(draw());
        seat.status = handValue(seat.cards).total > 21 ? "busted" : "stood";
        advanceTurn();
      }
    },

    onPlayerDisconnect(playerId) {
      const seat = seats.find((s) => s.id === playerId);
      if (!seat || ended) return;
      seat.connected = false;
      if (phase === "betting" && seat.status === "betting") {
        placeBet(seat, MIN_BET);
      } else if (
        phase === "turns" &&
        seats[turnIdx] === seat &&
        seat.status === "playing"
      ) {
        seat.status = "stood";
        advanceTurn();
      }
    },

    onPlayerReconnect(playerId) {
      const seat = seats.find((s) => s.id === playerId);
      if (!seat || ended) return;
      seat.connected = true;
      ctx.update();
    },

    getPublicState(): PublicState {
      const visibleDealer = holeHidden ? dealerCards.slice(0, 1) : dealerCards;
      return {
        phase,
        hand,
        totalHands: TOTAL_HANDS,
        deadline,
        turn: phase === "turns" && turnIdx >= 0 ? seats[turnIdx]!.id : null,
        dealer: {
          cards: visibleDealer,
          holeHidden: holeHidden && dealerCards.length > 1,
          total: handValue(visibleDealer).total,
        },
        players: seats.map((s) => {
          const hv = handValue(s.cards);
          return {
            id: s.id,
            name: s.name,
            chips: s.chips,
            bet: s.bet,
            cards: s.cards,
            total: hv.total,
            soft: hv.soft,
            status: s.status,
            doubled: s.doubled,
            result: s.result,
            net: s.net,
            connected: s.connected,
          };
        }),
      };
    },
  };
}
