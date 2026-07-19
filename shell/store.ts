import { useSyncExternalStore } from "react";
import type {
  ClientMsg,
  GameManifest,
  Player,
  PlayerInfo,
  Role,
  ServerMsg,
  SessionState,
} from "../src/shared/types.ts";

export interface ActiveGame {
  gameId: string;
  state: any;
  you?: any;
  seated: PlayerInfo[];
}

export interface ClientState {
  connected: boolean;
  everConnected: boolean;
  joined: boolean;
  role: Role | null;
  self: Player | null;
  session: SessionState | null;
  catalog: GameManifest[];
  sharedVisualPresent: boolean;
  sharedVisualAllowed: boolean;
  game: ActiveGame | null;
  toast: string | null;
}

const initial: ClientState = {
  connected: false,
  everConnected: false,
  joined: false,
  role: null,
  self: null,
  session: null,
  catalog: [],
  sharedVisualPresent: false,
  sharedVisualAllowed: true,
  game: null,
  toast: null,
};

const LS = {
  token: "lan-party:token",
  name: "lan-party:name",
  role: "lan-party:role",
};

// Identity: a random token minted on first visit, kept in localStorage.
export function getToken(): string {
  let t = localStorage.getItem(LS.token);
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem(LS.token, t);
  }
  return t;
}

export function getSavedIdentity(): { name: string | null; role: Role | null } {
  const role = localStorage.getItem(LS.role);
  return {
    name: localStorage.getItem(LS.name),
    role: role === "player" || role === "shared" ? role : null,
  };
}

class Store {
  state: ClientState = initial;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retryMs = 500;
  private joinIntent: { name?: string; role: Role } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;

  private set(partial: Partial<ClientState>) {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn();
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.set({ connected: true, everConnected: true });
      if (this.joinIntent) this.sendJoin(this.joinIntent);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.set({ connected: false, joined: false });
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(5000, this.retryMs * 2);
    };
    ws.onerror = () => ws.close();
  }

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case "joined":
        this.set({ joined: true, role: msg.role, self: msg.self });
        if (this.joinIntent) {
          localStorage.setItem(LS.role, msg.role);
          if (this.joinIntent.name) localStorage.setItem(LS.name, this.joinIntent.name);
        }
        break;
      case "session": {
        const self = msg.session.players.find((p) => p.id === this.state.self?.id) ?? this.state.self;
        this.set({
          session: msg.session,
          catalog: msg.catalog,
          sharedVisualPresent: msg.sharedVisualPresent,
          sharedVisualAllowed: msg.sharedVisualAllowed,
          self,
        });
        if (msg.session.phase === "lobby" && this.state.game) this.set({ game: null });
        break;
      }
      case "game.state":
        this.set({
          game: {
            gameId: msg.gameId,
            state: msg.state,
            you: msg.you,
            seated: msg.seated,
          },
        });
        break;
      case "game.over":
        this.set({ game: null });
        break;
      case "error":
        if (msg.code === "kicked") {
          this.joinIntent = null;
          localStorage.removeItem(LS.role);
          this.set({ joined: false, self: null });
        } else if (msg.code === "shared-unavailable") {
          // Stored shared role no longer valid — fall back to the connect screen.
          if (this.joinIntent?.role === "shared") this.joinIntent = null;
          localStorage.removeItem(LS.role);
          this.set({ joined: false });
        }
        this.showToast(msg.message);
        break;
    }
  }

  join(intent: { name?: string; role: Role }): void {
    this.joinIntent = intent;
    this.sendJoin(intent);
  }

  private sendJoin(intent: { name?: string; role: Role }): void {
    this.send({
      type: "join",
      token: getToken(),
      name: intent.name,
      role: intent.role,
    });
  }

  /** Forget the saved identity and return to the connect screen. */
  leave(): void {
    this.joinIntent = null;
    localStorage.removeItem(LS.role);
    this.set({ joined: false, role: null, self: null, game: null });
    this.ws?.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  showToast(message: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.set({ toast: message });
    this.toastTimer = setTimeout(() => this.set({ toast: null }), 4000);
  }
}

export const store = new Store();

export function useClient(): ClientState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
