// Shared touch controls for game authors. Import as `lan-party/sdk/controls`.
//
// Unlike `lan-party/sdk` (types only), this module has a runtime React
// dependency. It is a separate entry point so the SDK's no-runtime-dependency
// guarantee still holds for games that only want the types.

import { useCallback, useEffect, useRef, useState } from "react";
import "./controls.css";

export type Dir4 = "up" | "down" | "left" | "right";

const KEY_DIRS: Record<string, Dir4> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
};

/**
 * Bias applied when deciding whether the finger has crossed from one axis to
 * the other. Without it, holding near a 45° diagonal flip-flops between two
 * directions many times a second.
 */
const AXIS_HYSTERESIS = 1.3;

/**
 * Resolve a finger offset from the pad centre to a direction. Pure and exported
 * so the feel can be tuned and tested without a DOM.
 *
 * `current` is the direction already held: staying on it is biased by
 * AXIS_HYSTERESIS so a thumb resting near a 45° diagonal doesn't rapidly
 * alternate between two directions.
 */
export function stickDirection(
  dx: number,
  dy: number,
  radius: number,
  current: Dir4 | null,
  deadzone = 0.3,
): Dir4 | null {
  if (!(radius > 0)) return null;
  if (Math.hypot(dx, dy) < deadzone * radius) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let horizontal = ax > ay;
  if (current === "left" || current === "right") horizontal = ax * AXIS_HYSTERESIS > ay;
  else if (current === "up" || current === "down") horizontal = ax > ay * AXIS_HYSTERESIS;
  if (horizontal) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export interface ThumbstickProps {
  /** Called only when the direction actually changes. null = centered. */
  onChange: (dir: Dir4 | null) => void;
  /** Also drive the stick from WASD/arrows, for laptop players. */
  keyboard?: boolean;
  /** Dead zone at the centre, as a fraction of the pad radius. */
  deadzone?: number;
  className?: string;
}

/**
 * Analog-feeling stick that resolves to one of four directions. The finger is
 * tracked continuously, so switching direction never means finding a new
 * button — that, rather than true analog movement, is what makes a virtual
 * stick feel smooth on a grid game.
 */
export function Thumbstick({
  onChange,
  keyboard = true,
  deadzone = 0.3,
  className,
}: ThumbstickProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const dirRef = useRef<Dir4 | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);

  // Pointer moves fire at up to ~120 Hz; the server only cares about
  // transitions, so collapse the stream to direction changes.
  const emit = useCallback((dir: Dir4 | null) => {
    if (dirRef.current === dir) return;
    dirRef.current = dir;
    onChangeRef.current(dir);
  }, []);

  const track = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (!pad) return;
      const r = pad.getBoundingClientRect();
      const radius = r.width / 2;
      const dx = clientX - (r.left + radius);
      const dy = clientY - (r.top + r.height / 2);
      emit(stickDirection(dx, dy, radius, dirRef.current, deadzone));
      // Clamp the knob to the pad so it reads as a physical stick.
      const mag = Math.hypot(dx, dy);
      const k = mag > radius ? radius / mag : 1;
      setKnob({ x: dx * k, y: dy * k });
    },
    [emit, deadzone],
  );

  const release = useCallback(() => {
    emit(null);
    setKnob(null);
  }, [emit]);

  useEffect(() => {
    if (!keyboard) return;
    const held = new Set<string>();
    const down = (e: KeyboardEvent) => {
      const dir = KEY_DIRS[e.code];
      if (!dir || e.repeat) return;
      e.preventDefault();
      held.add(e.code);
      emit(dir);
    };
    const up = (e: KeyboardEvent) => {
      if (!KEY_DIRS[e.code]) return;
      held.delete(e.code);
      // Fall back to another still-held key rather than stopping dead.
      const next = [...held].map((c) => KEY_DIRS[c]).find(Boolean) ?? null;
      emit(next ?? null);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [keyboard, emit]);

  // Never leave the player walking into a wall because the round ended or the
  // component unmounted mid-drag.
  useEffect(() => () => emit(null), [emit]);

  return (
    <div
      ref={padRef}
      className={`lp-stick${knob ? " active" : ""}${className ? ` ${className}` : ""}`}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture unsupported — pointerleave still releases */
        }
        track(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0 && e.pointerType === "mouse") return;
        if (!knob) return;
        track(e.clientX, e.clientY);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="lp-stick-ring" />
      <span
        className="lp-stick-knob"
        style={knob ? { transform: `translate(${knob.x}px, ${knob.y}px)` } : undefined}
      />
    </div>
  );
}

export interface ActionButtonProps {
  onPress: () => void;
  /** Large glyph, e.g. an emoji. */
  icon?: string;
  /** Caption under the icon. */
  label?: string;
  /** Repeat while held, every N ms. Omit for a single fire per press. */
  repeatMs?: number;
  /** KeyboardEvent.code that also fires this action, e.g. "Space". */
  hotkey?: string;
  disabled?: boolean;
  className?: string;
}

/** Chunky primary action, sized for thumbs. Fires on press, not on release. */
export function ActionButton({
  onPress,
  icon,
  label,
  repeatMs,
  hotkey,
  disabled,
  className,
}: ActionButtonProps) {
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!hotkey || disabled) return;
    const down = (e: KeyboardEvent) => {
      // Key repeat would machine-gun the action; press-and-hold is repeatMs' job.
      if (e.code !== hotkey || e.repeat) return;
      e.preventDefault();
      onPressRef.current();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [hotkey, disabled]);

  return (
    <button
      type="button"
      className={`lp-action${className ? ` ${className}` : ""}`}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        onPressRef.current();
        if (repeatMs) {
          stop();
          timer.current = setInterval(() => onPressRef.current(), repeatMs);
        }
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {icon && <span className="lp-action-icon">{icon}</span>}
      {label && <span className="lp-action-label">{label}</span>}
    </button>
  );
}

/** Stick on the left, actions on the right. Stacks safely on short screens. */
export function Gamepad({
  children,
  compact,
}: {
  children: React.ReactNode;
  compact?: boolean;
}) {
  return <div className={`lp-gamepad${compact ? " compact" : ""}`}>{children}</div>;
}
