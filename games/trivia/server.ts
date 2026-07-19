// Trivia — authoritative game server. Ten timed questions, speed scoring.
import type { GameContext, GameServer } from "lan-party/sdk";
import questionBank from "./questions.json";

interface Question {
  category: string;
  question: string;
  choices: string[];
  answer: number;
}

interface Answer {
  choice: number;
  /** Epoch ms when the (latest) answer was locked in. */
  at: number;
}

interface RevealPick {
  choice: number;
  correct: boolean;
  points: number;
}

const QUESTION_MS = 20_000;
const GRACE_MS = 1_500;
const REVEAL_MS = 5_000;
const RESULTS_MS = 6_000;
const ROUND_LENGTH = 10;
const MAX_PER_CATEGORY = 2;
const BASE_POINTS = 7;
const SPEED_BONUS_MAX = 3;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * Sample ROUND_LENGTH questions without repeats, category-balanced:
 * greedily take from a shuffled bank while holding every category to
 * MAX_PER_CATEGORY, then (only if the bank is too small) top up freely.
 */
function sampleRound(bank: Question[]): Question[] {
  const pool = shuffle(bank);
  const picked: Question[] = [];
  const perCategory: Record<string, number> = {};
  for (const q of pool) {
    if (picked.length >= ROUND_LENGTH) break;
    const n = perCategory[q.category] ?? 0;
    if (n >= MAX_PER_CATEGORY) continue;
    perCategory[q.category] = n + 1;
    picked.push(q);
  }
  for (const q of pool) {
    if (picked.length >= ROUND_LENGTH) break;
    if (!picked.includes(q)) picked.push(q);
  }
  return shuffle(picked);
}

export default function createGame(ctx: GameContext): GameServer {
  const round = sampleRound(questionBank as Question[]);
  const totals: Record<string, number> = {};
  for (const p of ctx.players) totals[p.id] = 0;

  // Everyone seated was connected at start; track changes from there.
  const connected = new Set(ctx.players.map((p) => p.id));

  let phase: "question" | "reveal" | "results" = "question";
  let qIndex = 0;
  let deadline = 0;
  let answers: Record<string, Answer> = {};
  let reveal: { correct: number; picks: Record<string, RevealPick> } | null = null;
  let ended = false;

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let phaseTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (phaseTimer) clearTimeout(phaseTimer);
    deadlineTimer = graceTimer = phaseTimer = null;
  }

  function startQuestion(): void {
    phase = "question";
    answers = {};
    reveal = null;
    deadline = Date.now() + QUESTION_MS;
    deadlineTimer = setTimeout(doReveal, QUESTION_MS);
  }

  /** All seated players who are still connected have locked in an answer? */
  function everyoneAnswered(): boolean {
    const live = ctx.players.filter((p) => connected.has(p.id));
    return live.length > 0 && live.every((p) => answers[p.id] !== undefined);
  }

  function maybeEarlyCut(): void {
    if (phase !== "question") return;
    if (everyoneAnswered()) {
      if (!graceTimer) graceTimer = setTimeout(doReveal, GRACE_MS);
    } else if (graceTimer) {
      // A reconnect (or answer-less state change) broke the condition.
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function scoreFor(ans: Answer): number {
    const remaining = Math.min(QUESTION_MS, Math.max(0, deadline - ans.at));
    return BASE_POINTS + Math.round((SPEED_BONUS_MAX * remaining) / QUESTION_MS);
  }

  function doReveal(): void {
    if (ended || phase !== "question") return;
    clearTimers();
    const q = round[qIndex]!;
    const picks: Record<string, RevealPick> = {};
    for (const [pid, ans] of Object.entries(answers)) {
      const correct = ans.choice === q.answer;
      const points = correct ? scoreFor(ans) : 0;
      picks[pid] = { choice: ans.choice, correct, points };
      totals[pid] = (totals[pid] ?? 0) + points;
    }
    reveal = { correct: q.answer, picks };
    phase = "reveal";
    phaseTimer = setTimeout(advance, REVEAL_MS);
    ctx.update();
  }

  function advance(): void {
    if (ended) return;
    clearTimers();
    if (qIndex + 1 < round.length) {
      qIndex += 1;
      startQuestion();
      ctx.update();
    } else {
      phase = "results";
      phaseTimer = setTimeout(finish, RESULTS_MS);
      ctx.update();
    }
  }

  function finish(): void {
    if (ended) return;
    ended = true;
    clearTimers();
    const best = Math.max(0, ...Object.values(totals));
    const winners = ctx.players
      .filter((p) => (totals[p.id] ?? 0) === best)
      .map((p) => p.name);
    const summary =
      winners.length === 1
        ? `${winners[0]} wins with ${best} points`
        : `${winners.join(" & ")} tie with ${best} points`;
    ctx.end({ pointsByPlayer: totals, summary });
  }

  function teamTotals(): Record<string, number> | null {
    if (ctx.teams.length === 0) return null;
    const out: Record<string, number> = {};
    for (const t of ctx.teams) out[t.id] = 0;
    for (const p of ctx.players) {
      const tid = p.teamId;
      if (tid && out[tid] !== undefined) {
        out[tid] = (out[tid] ?? 0) + (totals[p.id] ?? 0);
      }
    }
    return out;
  }

  startQuestion();

  return {
    onAction(playerId, action) {
      if (ended || phase !== "question") return;
      if (!action || typeof action !== "object" || action.type !== "answer") return;
      const choice = (action as { choice?: unknown }).choice;
      const q = round[qIndex]!;
      if (!Number.isInteger(choice)) return;
      if ((choice as number) < 0 || (choice as number) >= q.choices.length) return;
      if (totals[playerId] === undefined) return; // not seated (belt and braces)
      if (Date.now() > deadline) return; // too late; the reveal timer will fire
      // Players may change their pick until the deadline; latest one counts.
      answers[playerId] = { choice: choice as number, at: Date.now() };
      maybeEarlyCut();
    },

    onPlayerDisconnect(playerId) {
      connected.delete(playerId);
      maybeEarlyCut(); // never stall on someone who left
    },

    onPlayerReconnect(playerId) {
      connected.add(playerId);
      maybeEarlyCut(); // cancels a pending early-cut if they haven't answered
    },

    getPublicState() {
      const q = round[qIndex]!;
      const answeredIds = Object.keys(answers);
      return {
        phase,
        qNum: qIndex + 1,
        qTotal: round.length,
        category: q.category,
        question: q.question,
        choices: q.choices,
        deadline,
        questionMs: QUESTION_MS,
        answeredCount: answeredIds.length,
        answeredIds,
        reveal,
        totals,
        teamTotals: teamTotals(),
      };
    },

    getPlayerState(playerId) {
      const ans = answers[playerId];
      return { pick: ans ? ans.choice : null };
    },
  };
}
