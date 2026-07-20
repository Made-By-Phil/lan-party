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

// crypto.randomUUID() is secure-context only, and the whole point of this app is
// joining over http://<lan-ip>, which is not a secure context. getRandomValues is
// available everywhere, so build the UUID from it.
function randomToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10x
  const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Identity: a random token minted on first visit, kept in localStorage.
export function getToken(): string {
  let t = localStorage.getItem(LS.token);
  if (!t) {
    t = randomToken();
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
      if (this.joinIntent) this.trySendJoin(this.joinIntent);
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
      case "reload":
        // The host rebuilt the bundle. Identity lives in localStorage, so a
        // reload drops everyone straight back into their seat.
        location.reload();
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
    this.trySendJoin(intent);
  }

  /**
   * Joining is the one path where a thrown error is invisible: it happens before
   * any screen transition, so a failure just looks like a dead button. Always
   * surface it — to the guest as a toast, to the host as a console error.
   */
  private trySendJoin(intent: { name?: string; role: Role }): void {
    try {
      this.send({
        type: "join",
        token: getToken(),
        name: intent.name,
        role: intent.role,
      });
    } catch (err) {
      // Don't retry a throwing join on every reconnect.
      this.joinIntent = null;
      this.reportError("join", err);
      this.showToast("Couldn't join the party. The host console has the details.");
    }
  }

  /** Log locally, forward to the host terminal, and never throw while doing so. */
  reportError(context: string, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[lan-party] ${context}:`, e);
    try {
      this.send({ type: "client.error", context, message: e.message, stack: e.stack });
    } catch {
      // Reporting must never mask the original failure.
    }
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
