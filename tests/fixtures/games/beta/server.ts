import type { GameContext, GameServer } from "lan-party/sdk";

/** Minimal well-behaved game that echoes the settings it was handed. */
export default function createGame(ctx: GameContext): GameServer {
  let clicks = 0;
  return {
    onAction(_playerId, action) {
      if (action && typeof action === "object" && (action as { type?: unknown }).type === "click") {
        clicks++;
        ctx.update();
      }
    },
    getPublicState() {
      return { label: "beta", clicks, settings: ctx.settings };
    },
  };
}
