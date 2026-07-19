// Canvas renderer for the Boom Grid arena. Used by shared.tsx (the TV) and by
// client.tsx when no shared visual is present.

import { useEffect, useRef } from "react";
import { BLAST_MS, FUSE_MS, H, TILE_CRATE, TILE_WALL, W, idx } from "./sim.ts";

const S = 48; // px per cell (canvas resolution; CSS scales to fit)

export const PLAYER_COLORS: readonly string[] = [
  "#45c8ff", // cyan
  "#ff5d5d", // red
  "#5ce87d", // green
  "#ffd045", // yellow
  "#c07bff", // purple
  "#ff9a3d", // orange
  "#ff6fbf", // pink
  "#b9c4d8", // silver
];

export const PU_ICONS: readonly string[] = ["💣", "🔥", "⚡"];

export interface PubPlayer {
  id: string;
  x: number;
  y: number;
  dir: string | null;
  alive: boolean;
  kills: number;
  speed?: number;
  bombs?: number;
  range?: number;
}

export interface ArenaState {
  grid?: number[];
  bombs?: { cell: number; fuseMsLeft: number; range: number }[];
  blasts?: { cells: number[]; msLeft: number }[];
  powerups?: { cell: number; kind: number }[];
  players?: PubPlayer[];
}

export function ArenaCanvas({
  state,
  names,
  colors,
}: {
  state: ArenaState;
  names: Record<string, string>;
  colors: Record<string, string>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !state?.grid) return;
    const g = canvas.getContext("2d");
    if (g) draw(g, state, names, colors);
  });
  return <canvas ref={ref} className="bm-canvas" width={W * S} height={H * S} />;
}

const px = (v: number): number => (v + 0.5) * S; // cell coord -> pixel center

function draw(
  g: CanvasRenderingContext2D,
  state: ArenaState,
  names: Record<string, string>,
  colors: Record<string, string>,
): void {
  const grid = state.grid!;
  g.clearRect(0, 0, W * S, H * S);

  // Tiles
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = grid[idx(x, y)];
      if (t === TILE_WALL) {
        g.fillStyle = "#3a3a55";
        g.fillRect(x * S, y * S, S, S);
        g.fillStyle = "#2c2c40";
        g.fillRect(x * S, y * S + S - 6, S, 6);
        g.fillStyle = "#48486a";
        g.fillRect(x * S, y * S, S, 4);
      } else if (t === TILE_CRATE) {
        g.fillStyle = "#a06a35";
        g.fillRect(x * S + 2, y * S + 2, S - 4, S - 4);
        g.strokeStyle = "#7d4f24";
        g.lineWidth = 2;
        g.strokeRect(x * S + 3, y * S + 3, S - 6, S - 6);
        g.beginPath();
        g.moveTo(x * S + 3, y * S + S / 2);
        g.lineTo(x * S + S - 3, y * S + S / 2);
        g.stroke();
      } else {
        g.fillStyle = (x + y) % 2 === 0 ? "#191926" : "#1c1c2b";
        g.fillRect(x * S, y * S, S, S);
      }
    }
  }

  // Power-ups
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const pu of state.powerups ?? []) {
    const x = pu.cell % W;
    const y = Math.floor(pu.cell / W);
    g.fillStyle = "#26263c";
    g.strokeStyle = "#ffd045";
    g.lineWidth = 2;
    roundRect(g, x * S + 7, y * S + 7, S - 14, S - 14, 8);
    g.fill();
    g.stroke();
    g.font = "22px system-ui";
    g.fillText(PU_ICONS[pu.kind] ?? "?", px(x), px(y) + 1);
  }

  // Blasts
  for (const bl of state.blasts ?? []) {
    const a = Math.max(0.25, bl.msLeft / BLAST_MS);
    for (const c of bl.cells) {
      const x = c % W;
      const y = Math.floor(c / W);
      g.globalAlpha = a;
      g.fillStyle = "#ff9a2e";
      roundRect(g, x * S + 3, y * S + 3, S - 6, S - 6, 10);
      g.fill();
      g.fillStyle = "#ffe27a";
      roundRect(g, x * S + 12, y * S + 12, S - 24, S - 24, 8);
      g.fill();
      g.globalAlpha = 1;
    }
  }

  // Bombs — pulse faster as the fuse runs down
  for (const b of state.bombs ?? []) {
    const x = b.cell % W;
    const y = Math.floor(b.cell / W);
    const t = Math.max(0, b.fuseMsLeft) / FUSE_MS; // 1 -> 0
    const pulse = 1 + 0.1 * Math.sin((1 - t) * (1 - t) * 60);
    const r = S * 0.3 * pulse;
    g.fillStyle = b.fuseMsLeft < 500 ? "#552a22" : "#22222e";
    g.beginPath();
    g.arc(px(x), px(y) + 2, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#0c0c12";
    g.lineWidth = 2;
    g.stroke();
    // fuse spark
    g.strokeStyle = "#c9a15a";
    g.beginPath();
    g.moveTo(px(x) + r * 0.4, px(y) - r * 0.7);
    g.lineTo(px(x) + r * 0.9, px(y) - r * 1.3);
    g.stroke();
    g.fillStyle = "#ffd045";
    g.beginPath();
    g.arc(px(x) + r * 0.9, px(y) - r * 1.3, 3, 0, Math.PI * 2);
    g.fill();
  }

  // Players
  for (const p of state.players ?? []) {
    if (!p.alive) continue;
    const color = colors[p.id] ?? "#fff";
    const cx = px(p.x);
    const cy = px(p.y);
    const r = S * 0.36;
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.lineWidth = 3;
    g.stroke();
    // Eyes hint at facing
    const [ex, ey] = eyeOffset(p.dir);
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(cx - 6 + ex, cy - 4 + ey, 4, 0, Math.PI * 2);
    g.arc(cx + 6 + ex, cy - 4 + ey, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#14141e";
    g.beginPath();
    g.arc(cx - 6 + ex * 1.6, cy - 4 + ey * 1.6, 2, 0, Math.PI * 2);
    g.arc(cx + 6 + ex * 1.6, cy - 4 + ey * 1.6, 2, 0, Math.PI * 2);
    g.fill();
    // Name label
    const name = names[p.id] ?? "?";
    g.font = "bold 13px system-ui";
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0,0,0,0.8)";
    g.strokeText(name, cx, cy - r - 9);
    g.fillStyle = color;
    g.fillText(name, cx, cy - r - 9);
  }
}

function eyeOffset(dir: string | null): [number, number] {
  if (dir === "left") return [-3, 0];
  if (dir === "right") return [3, 0];
  if (dir === "up") return [0, -3];
  if (dir === "down") return [0, 3];
  return [0, 0];
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
