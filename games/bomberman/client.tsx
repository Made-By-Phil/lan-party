// Boom Grid — player device UI. A gamepad when the room has a shared visual,
// arena + compact controls otherwise.

import { useRef } from "react";
import type { GameClientProps } from "lan-party/sdk";
import { ActionButton, Gamepad, Thumbstick } from "lan-party/sdk/controls";
import { ArenaCanvas, PLAYER_COLORS, PU_ICONS, type ArenaState } from "./arena.tsx";
import { PU_BOMB, PU_RANGE, PU_SPEED } from "./sim.ts";
import { StandingsCard, TimerBadge, useRosterMaps } from "./shared.tsx";
import "./styles.css";

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
        <Gamepad compact={showArena}>
          <Thumbstick onChange={(dir) => sendRef.current({ type: "move", dir })} />
          <ActionButton
            icon="💣"
            label="BOMB"
            hotkey="Space"
            onPress={() => sendRef.current({ type: "bomb" })}
          />
        </Gamepad>
      )}
    </div>
  );
}
