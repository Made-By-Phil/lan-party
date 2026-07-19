// Boom Grid simulation. Pure logic — DOM-free and React-free — imported by the
// game server, by the clients (constants only), and directly by tests.
//
// Coordinates are cell units with *center-based* cells: cell (i, j) spans
// [i - 0.5, i + 0.5), so a player exactly on a cell center has integer x/y and
// their occupied cell is (round(x), round(y)).

export const W = 15;
export const H = 13;
export const CELLS = W * H;

export const TILE_FLOOR = 0;
export const TILE_WALL = 1; // border walls + pillars — indestructible
export const TILE_CRATE = 2;

export const PU_BOMB = 0;
export const PU_RANGE = 1;
export const PU_SPEED = 2;

export const BASE_SPEED = 3.5; // cells/s
export const SPEED_STEP = 0.5; // per speed power-up
export const MAX_SPEED = 6;
export const BASE_BOMBS = 1;
export const BASE_RANGE = 2;
export const FUSE_MS = 2000;
export const BLAST_MS = 400;
export const CRATE_DENSITY = 0.55;
export const POWERUP_CHANCE = 0.3;
export const ROUND_MS = 120_000;
export const RESULTS_MS = 5_000;

/**
 * Corner assist: when a move is blocked by the cell ahead but the player has
 * drifted sideways into the assist window — within CORNER_ASSIST cells of the
 * boundary toward an adjacent lane whose corner is open — the movement budget
 * slides them toward that lane instead of stopping dead. Combined with the
 * 0.5-cell rounding window this makes turns forgiving within ~0.85 cells of
 * an intersection.
 */
export const CORNER_ASSIST = 0.35;
const ASSIST_MIN_OFF = 0.5 - CORNER_ASSIST; // min drift off lane center: 0.15
const MAX_SUBSTEP_MS = 25; // 6 cells/s * 25 ms = 0.15 cells — no tunneling

export type Dir = "up" | "down" | "left" | "right";
export const DIRS: readonly Dir[] = ["up", "down", "left", "right"];

export const idx = (x: number, y: number): number => y * W + x;
export const cellX = (cell: number): number => cell % W;
export const cellY = (cell: number): number => Math.floor(cell / W);

/** Seat order: 4 corners (opposite pairs first), then 4 edge midpoints. */
export const SPAWNS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [W - 2, H - 2],
  [W - 2, 1],
  [1, H - 2],
  [(W - 1) / 2, 1],
  [(W - 1) / 2, H - 2],
  [1, (H - 1) / 2],
  [W - 2, (H - 1) / 2],
];

export interface SimPlayer {
  id: string;
  name: string;
  seat: number;
  x: number;
  y: number;
  dir: Dir | null;
  alive: boolean;
  bombUps: number;
  rangeUps: number;
  speedUps: number;
  kills: number;
  /** -1 while alive; equal values mean "died in the same wave" (tie). */
  deathOrder: number;
  killedBy: string | null;
}

export interface Bomb {
  cell: number;
  owner: string;
  fuseMs: number;
  range: number;
}

export interface Blast {
  cells: number[];
  msLeft: number;
  /** Kill credit. For chained bombs this is the chain-triggering bomb's owner. */
  owner: string;
}

export interface Powerup {
  cell: number;
  kind: number; // PU_BOMB | PU_RANGE | PU_SPEED
}

export interface Death {
  id: string;
  by: string | null; // null = self-kill
}

export interface Sim {
  grid: number[];
  players: SimPlayer[];
  bombs: Bomb[];
  blasts: Blast[];
  powerups: Powerup[];
  deathCounter: number;
  rng: () => number;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createSim(
  roster: ReadonlyArray<{ id: string; name: string }>,
  rng: () => number = Math.random,
): Sim {
  const grid = new Array<number>(CELLS).fill(TILE_FLOOR);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      const pillar = x % 2 === 0 && y % 2 === 0;
      if (border || pillar) grid[idx(x, y)] = TILE_WALL;
    }
  }

  const players: SimPlayer[] = [];
  const keepClear = new Set<number>();
  roster.slice(0, SPAWNS.length).forEach((p, seat) => {
    const [sx, sy] = SPAWNS[seat]!;
    keepClear.add(idx(sx, sy));
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const nx = sx + dx;
      const ny = sy + dy;
      if (grid[idx(nx, ny)] === TILE_FLOOR) keepClear.add(idx(nx, ny));
    }
    players.push({
      id: p.id,
      name: p.name,
      seat,
      x: sx,
      y: sy,
      dir: null,
      alive: true,
      bombUps: 0,
      rangeUps: 0,
      speedUps: 0,
      kills: 0,
      deathOrder: -1,
      killedBy: null,
    });
  });

  for (let i = 0; i < CELLS; i++) {
    if (grid[i] === TILE_FLOOR && !keepClear.has(i) && rng() < CRATE_DENSITY) {
      grid[i] = TILE_CRATE;
    }
  }

  return { grid, players, bombs: [], blasts: [], powerups: [], deathCounter: 0, rng };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function speedOf(p: SimPlayer): number {
  return Math.min(MAX_SPEED, BASE_SPEED + SPEED_STEP * p.speedUps);
}

export function cellOf(p: { x: number; y: number }): number {
  return idx(Math.round(p.x), Math.round(p.y));
}

function tileAt(sim: Sim, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= W || y >= H) return TILE_WALL;
  return sim.grid[idx(x, y)]!;
}

export function bombAt(sim: Sim, cell: number): Bomb | undefined {
  return sim.bombs.find((b) => b.cell === cell);
}

/** A bomb's cell stays passable for a player until they step off it. */
function canEnter(sim: Sim, p: SimPlayer, x: number, y: number): boolean {
  if (tileAt(sim, x, y) !== TILE_FLOOR) return false;
  const c = idx(x, y);
  if (bombAt(sim, c) && cellOf(p) !== c) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function setDir(sim: Sim, playerId: string, dir: Dir | null): void {
  const p = sim.players.find((pl) => pl.id === playerId);
  if (p) p.dir = dir;
}

export function plantBomb(sim: Sim, playerId: string): boolean {
  const p = sim.players.find((pl) => pl.id === playerId);
  if (!p || !p.alive) return false;
  const cell = cellOf(p);
  if (bombAt(sim, cell)) return false; // no double-plant on the same cell
  const active = sim.bombs.filter((b) => b.owner === playerId).length;
  if (active >= BASE_BOMBS + p.bombUps) return false;
  sim.bombs.push({ cell, owner: playerId, fuseMs: FUSE_MS, range: BASE_RANGE + p.rangeUps });
  return true;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

const approach = (v: number, target: number, maxStep: number): number =>
  v + Math.max(-maxStep, Math.min(maxStep, target - v));

const DELTA: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function movePlayer(sim: Sim, p: SimPlayer, dtS: number): void {
  if (!p.dir || !p.alive) return;
  const [dx] = DELTA[p.dir];
  const budget = speedOf(p) * dtS;
  if (dx !== 0) stepAxis(sim, p, true, dx, budget);
  else stepAxis(sim, p, false, DELTA[p.dir][1], budget);
}

/**
 * Move along one axis. `horizontal` picks the primary axis; `sign` is the
 * movement direction. Rules:
 *  - forward cell open → advance, and re-align the cross axis onto the lane
 *    center (free — this is what completes a forgiving turn);
 *  - forward blocked but drifted ≥ ASSIST_MIN_OFF toward an open corner →
 *    corner assist: spend the budget sliding sideways toward that lane;
 *  - otherwise settle onto the current cell center (a player can never rest
 *    off-center against a solid cell).
 */
function stepAxis(sim: Sim, p: SimPlayer, horizontal: boolean, sign: number, budget: number): void {
  const prim = horizontal ? p.x : p.y;
  const cross = horizontal ? p.y : p.x;
  const cp = Math.round(prim);
  const cc = Math.round(cross);
  const open = (primCell: number, lane: number) =>
    horizontal ? canEnter(sim, p, primCell, lane) : canEnter(sim, p, lane, primCell);
  const write = (np: number, ncr: number) => {
    if (horizontal) {
      p.x = np;
      p.y = ncr;
    } else {
      p.y = np;
      p.x = ncr;
    }
  };

  if (open(cp + sign, cc)) {
    write(prim + sign * budget, approach(cross, cc, budget));
    return;
  }
  // Blocked ahead. Corner assist toward the side we've drifted?
  const off = cross - cc;
  if (Math.abs(off) >= ASSIST_MIN_OFF) {
    const lane = cc + Math.sign(off);
    if (open(cp, lane) && open(cp + sign, lane)) {
      write(prim, approach(cross, lane, budget));
      return;
    }
  }
  // Butt against the wall: settle onto the cell center on both axes.
  write(approach(prim, cp, budget), approach(cross, cc, budget));
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

function explodeWave(sim: Sim, initial: Bomb[]): void {
  const queue = initial.map((b) => ({ bomb: b, credit: b.owner }));
  const done = new Set<Bomb>();
  const spawned: Powerup[] = [];
  while (queue.length > 0) {
    const { bomb, credit } = queue.shift()!;
    if (done.has(bomb)) continue;
    done.add(bomb);
    sim.bombs = sim.bombs.filter((b) => b !== bomb);

    const bx = cellX(bomb.cell);
    const by = cellY(bomb.cell);
    const cells = [bomb.cell];
    const crateCells: number[] = [];
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      for (let r = 1; r <= bomb.range; r++) {
        const x = bx + dx * r;
        const y = by + dy * r;
        const tile = tileAt(sim, x, y);
        if (tile === TILE_WALL) break; // pillars/border stop the blast, excluded
        const c = idx(x, y);
        cells.push(c);
        if (tile === TILE_CRATE) {
          sim.grid[c] = TILE_FLOOR;
          crateCells.push(c);
          break; // blast stops at the first crate (inclusive)
        }
      }
    }

    for (const c of cells) {
      // Chain detonation: kills by a chained bomb credit the chain trigger.
      const other = bombAt(sim, c);
      if (other && !done.has(other)) queue.push({ bomb: other, credit });
      // Blasts destroy already-exposed power-ups.
      const pi = sim.powerups.findIndex((pu) => pu.cell === c);
      if (pi >= 0) sim.powerups.splice(pi, 1);
    }
    for (const c of crateCells) {
      if (sim.rng() < POWERUP_CHANCE) {
        spawned.push({ cell: c, kind: Math.min(2, Math.floor(sim.rng() * 3)) });
      }
    }
    sim.blasts.push({ cells, msLeft: BLAST_MS, owner: credit });
  }
  // Power-ups revealed by this wave survive the wave that revealed them.
  sim.powerups.push(...spawned);
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function applyPowerup(kind: number, p: SimPlayer): void {
  if (kind === PU_BOMB) p.bombUps += 1;
  else if (kind === PU_RANGE) p.rangeUps += 1;
  else p.speedUps += 1;
}

export function stepSim(sim: Sim, dtMs: number): { deaths: Death[] } {
  // Movement in sub-steps so fast players can't tunnel through corners.
  let remaining = Math.min(dtMs, 250);
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_SUBSTEP_MS);
    for (const p of sim.players) movePlayer(sim, p, step / 1000);
    remaining -= step;
  }

  // Power-up pickup on walk-over.
  for (const p of sim.players) {
    if (!p.alive) continue;
    const c = cellOf(p);
    const i = sim.powerups.findIndex((pu) => pu.cell === c);
    if (i >= 0) {
      applyPowerup(sim.powerups[i]!.kind, p);
      sim.powerups.splice(i, 1);
    }
  }

  // Fuses → explosions (chains resolve inside the wave).
  const due: Bomb[] = [];
  for (const b of sim.bombs) {
    b.fuseMs -= dtMs;
    if (b.fuseMs <= 0) due.push(b);
  }
  if (due.length > 0) explodeWave(sim, due);

  // Deaths: standing in any active blast cell. Same-tick deaths share a wave
  // number so they tie in the standings.
  const deaths: Death[] = [];
  for (const p of sim.players) {
    if (!p.alive) continue;
    const c = cellOf(p);
    const hit = sim.blasts.find((bl) => bl.cells.includes(c));
    if (hit) {
      p.alive = false;
      p.dir = null;
      p.killedBy = hit.owner === p.id ? null : hit.owner;
      deaths.push({ id: p.id, by: p.killedBy });
    }
  }
  if (deaths.length > 0) {
    sim.deathCounter += 1;
    for (const d of deaths) {
      const p = sim.players.find((pl) => pl.id === d.id)!;
      p.deathOrder = sim.deathCounter;
      if (d.by) {
        const killer = sim.players.find((pl) => pl.id === d.by);
        if (killer) killer.kills += 1;
      }
    }
  }

  // Blast decay after the lethality check so a fresh blast is lethal this tick.
  for (const bl of sim.blasts) bl.msLeft -= dtMs;
  sim.blasts = sim.blasts.filter((bl) => bl.msLeft > 0);

  return { deaths };
}
