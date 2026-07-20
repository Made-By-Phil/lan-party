import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { GameClientProps, GameManifest } from "../src/sdk.ts";
import { App } from "./App.tsx";
import { store } from "./store.ts";
import "./styles.css";

export interface GameRegistryEntry {
  manifest: GameManifest;
  Client: ComponentType<GameClientProps>;
  Shared: ComponentType<GameClientProps> | null;
}

export type GameRegistry = Map<string, GameRegistryEntry>;

/**
 * Entry point invoked by the host-generated bundle: receives every discovered
 * game's client components and mounts the shell.
 */
export function boot(entries: GameRegistryEntry[]): void {
  const registry: GameRegistry = new Map(entries.map((e) => [e.manifest.id, e]));
  store.connect();
  // Guests are on phones with no devtools, so anything uncaught goes to the host.
  window.addEventListener("error", (e) => store.reportError("uncaught", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => store.reportError("unhandled-rejection", e.reason));
  createRoot(document.getElementById("root")!).render(<App registry={registry} />);
}
