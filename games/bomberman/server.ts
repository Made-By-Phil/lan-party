// Boom Grid — authoritative game server. Runs on the host at 20 Hz.

import type { GameContext, GameServer } from "lan-party/sdk";
import {
  BASE_BOMBS,
  BASE_RANGE,
  DIRS,
  H,
  RESULTS_MS,
  ROUND_MS,
  W,
  createSim,
  plantBomb,
  setDir,
  speedOf,
  stepSim,
  type Dir,
  type Sim,
} from "./sim.ts";

interface Standing {
  id: string;
  place: number; // 1-based; ties share a place
  points: number; // placement points + 5 per kill
  kills: number;
}

const PLACE_POINTS = [50, 35, 25, 18] as const;
const KILL_POINTS = 5;

const placePoints = (place: number): number => PLACE_POINTS[place - 1] ?? 12;

/**
 * Placement: survivors first, then by death order descending (dying later is
 * better). Groups with the same rank (all survivors on a timer tie, or players
 * who died in the same blast wave) share the rounded average of the placement
 * points they span.
 */
function computeStandings(sim: Sim): Standing[] {
  const rankVal = (p: { alive: boolean; deathOrder: number }): number =>
    p.alive ? Number.MAX_SAFE_INTEGER : p.deathOrder;
  const sorted = [...sim.players].sort((a, b) => rankVal(b) - rankVal(a));
  const standings: Standing[] = [];
  let place = 1;
  let i = 0;
  while (i < sorted.length) {
    const group = sorted.filter((p) => rankVal(p) === rankVal(sorted[i]!));
    let sum = 0;
    for (let g = 0; g < group.length; g++) sum += placePoints(place + g);
    const pts = Math.round(sum / group.length);
    for (const p of group) {
      standings.push({ id: p.id, place, points: pts + KILL_POINTS * p.kills, kills: p.kills });
    }
    place += group.length;
    i += group.length;
  }
  return standings;
}

function makeSummary(sim: Sim, standings: Standing[]): string {
  const top = standings.filter((s) => s.place === 1);
  const names = top.map((s) => sim.players.find((p) => p.id === s.id)?.name ?? "?");
  if (names.length === 1) return `${names[0]} survives the arena`;
  return `${names.join(" & ")} tie for the top`;
}

export default function createGame(ctx: GameContext): GameServer {
  const sim = createSim(ctx.players.map((p) => ({ id: p.id, name: p.name })));
  const deadlineEpoch = Date.now() + ROUND_MS;
  let timeLeftMs = ROUND_MS;
  let phase: "play" | "results" = "play";
  let resultsLeftMs = RESULTS_MS;
  let standings: Standing[] | null = null;
  let summary = "";
  let ended = false;

  function decide(): void {
    phase = "results";
    standings = computeStandings(sim);
    summary = makeSummary(sim, standings);
  }

  return {
    onAction(playerId, action) {
      if (phase !== "play" || !action || typeof action !== "object") return;
      const a = action as { type?: unknown; dir?: unknown };
      if (a.type === "move") {
        if (a.dir === null) setDir(sim, playerId, null);
        else if (typeof a.dir === "string" && (DIRS as readonly string[]).includes(a.dir)) {
          setDir(sim, playerId, a.dir as Dir);
        }
      } else if (a.type === "bomb") {
        plantBomb(sim, playerId);
      }
    },

    tick(dtMs) {
      if (ended) return;
      if (phase === "play") {
        stepSim(sim, dtMs);
        timeLeftMs -= dtMs;
        const alive = sim.players.filter((p) => p.alive).length;
        // Last one standing, everyone gone in the same wave, or timer expiry
        // (all still-alive players tie for the top).
        if (alive <= 1 || timeLeftMs <= 0) decide();
      } else {
        resultsLeftMs -= dtMs;
        if (resultsLeftMs <= 0) {
          ended = true;
          const pointsByPlayer: Record<string, number> = {};
          for (const s of standings ?? []) pointsByPlayer[s.id] = s.points;
          ctx.end({ pointsByPlayer, summary });
        }
      }
    },

    onPlayerDisconnect(playerId) {
      // Stop their movement; the character keeps standing (a sitting duck).
      setDir(sim, playerId, null);
    },

    getPublicState() {
      return {
        phase,
        deadlineEpoch,
        timeLeftMs: Math.max(0, Math.round(timeLeftMs)),
        w: W,
        h: H,
        grid: sim.grid,
        bombs: sim.bombs.map((b) => ({
          cell: b.cell,
          fuseMsLeft: Math.max(0, Math.round(b.fuseMs)),
          range: b.range,
        })),
        blasts: sim.blasts.map((bl) => ({ cells: bl.cells, msLeft: Math.round(bl.msLeft) })),
        powerups: sim.powerups.map((pu) => ({ cell: pu.cell, kind: pu.kind })),
        players: sim.players.map((p) => ({
          id: p.id,
          x: Math.round(p.x * 100) / 100,
          y: Math.round(p.y * 100) / 100,
          dir: p.dir,
          alive: p.alive,
          speed: speedOf(p),
          bombs: BASE_BOMBS + p.bombUps,
          range: BASE_RANGE + p.rangeUps,
          kills: p.kills,
          deathOrder: p.deathOrder,
        })),
        standings,
        summary: phase === "results" ? summary : null,
      };
    },
  };
}
