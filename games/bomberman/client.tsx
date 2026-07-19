// Boom Grid — player device UI. A gamepad when the room has a shared visual,
// arena + compact controls otherwise.

import { useEffect, useRef } from "react";
import type { GameClientProps } from "lan-party/sdk";
import { ArenaCanvas, PLAYER_COLORS, PU_ICONS, type ArenaState } from "./arena.tsx";
import { PU_BOMB, PU_RANGE, PU_SPEED, type Dir } from "./sim.ts";
import { StandingsCard, TimerBadge, useRosterMaps } from "./shared.tsx";
import "./styles.css";

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
};

const DIR_ARROWS: Record<Dir, string> = { up: "▲", down: "▼", left: "◀", right: "▶" };

function DirButton({
  dir,
  onPress,
  onRelease,
}: {
  dir: Dir;
  onPress: (d: Dir) => void;
  onRelease: (d: Dir) => void;
}) {
  return (
    <button
      className={`bm-dir bm-dir-${dir}`}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } catch {
          /* not supported — pointerleave covers us */
        }
        onPress(dir);
      }}
      onPointerUp={() => onRelease(dir)}
      onPointerLeave={() => onRelease(dir)}
      onPointerCancel={() => onRelease(dir)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {DIR_ARROWS[dir]}
    </button>
  );
}

export default function BoomGridClient({ game }: GameClientProps) {
  const state = (game.state ?? {}) as ArenaState & {
    phase?: string;
    timeLeftMs?: number;
    standings?: { id: string; place: number; points: number; kills: number }[] | null;
    summary?: string | null;
  };
  const { names, colors } = useRosterMaps(game.players);

  const sendRef = useRef(game.send);
  sendRef.current = game.send;
  const heldRef = useRef<Dir | null>(null);

  const press = (dir: Dir) => {
    heldRef.current = dir;
    sendRef.current({ type: "move", dir });
  };
  const release = (dir: Dir) => {
    if (heldRef.current !== dir) return;
    heldRef.current = null;
    sendRef.current({ type: "move", dir: null });
  };
  const bomb = () => sendRef.current({ type: "bomb" });

  // Keyboard support for laptop players.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const dir = KEY_DIRS[e.code];
      if (dir) {
        e.preventDefault();
        heldRef.current = dir;
        sendRef.current({ type: "move", dir });
      } else if (e.code === "Space") {
        e.preventDefault();
        sendRef.current({ type: "bomb" });
      }
    };
    const up = (e: KeyboardEvent) => {
      const dir = KEY_DIRS[e.code];
      if (dir && heldRef.current === dir) {
        heldRef.current = null;
        sendRef.current({ type: "move", dir: null });
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const me = (state.players ?? []).find((p) => p.id === game.self?.id);
  const myColor = colors[game.self?.id ?? ""] ?? PLAYER_COLORS[0]!;
  const showArena = !game.sharedVisualPresent;
  const dead = me ? !me.alive : false;
  const inResults = state.phase === "results";

  return (
    <div className="bm-client">
      <div className="bm-topbar">
        <TimerBadge state={state} />
        <span className="bm-chip">
          <span className="bm-dot" style={{ background: myColor }} />
          {game.self?.name}
          {dead && <span className="bm-dead-note">OUT</span>}
        </span>
        {me && (
          <span className="bm-chip bm-powers">
            {PU_ICONS[PU_BOMB]} {me.bombs ?? 1} · {PU_ICONS[PU_RANGE]} {me.range ?? 2} ·{" "}
            {PU_ICONS[PU_SPEED]} {me.speed ?? 3.5}
          </span>
        )}
      </div>

      {showArena && (
        <div className="bm-arena-wrap">
          <ArenaCanvas state={state} names={names} colors={colors} />
          {inResults && state.standings && (
            <div className="bm-overlay">
              <StandingsCard
                standings={state.standings}
                summary={state.summary ?? null}
                names={names}
                colors={colors}
              />
            </div>
          )}
        </div>
      )}

      {inResults && !showArena && state.standings && (
        <StandingsCard
          standings={state.standings}
          summary={state.summary ?? null}
          names={names}
          colors={colors}
        />
      )}

      {dead && !inResults && (
        <div className="card center bm-spectating">
          <h3>💀 You're out</h3>
          <p className="muted">
            Spectating — {showArena ? "watch the arena above." : "watch the shared screen."}
          </p>
        </div>
      )}

      {!dead && !inResults && (
        <div className={`bm-controls${showArena ? " compact" : ""}`}>
          <div className="bm-dpad">
            <DirButton dir="up" onPress={press} onRelease={release} />
            <DirButton dir="left" onPress={press} onRelease={release} />
            <span className="bm-dpad-center" />
            <DirButton dir="right" onPress={press} onRelease={release} />
            <DirButton dir="down" onPress={press} onRelease={release} />
          </div>
          <button
            className="bm-bomb"
            onPointerDown={(e) => {
              e.preventDefault();
              bomb();
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            💣<span>BOMB</span>
          </button>
        </div>
      )}
    </div>
  );
}
