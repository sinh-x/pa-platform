export type WsEventType = "new-inbox-item" | "inbox-item-moved" | "deployment-status-change" | "ticket-changed" | "bulletin-update" | "ping";

export interface WsEvent {
  type: WsEventType;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface WsClient {
  readyState: number;
  send(message: string): void;
  close(): void;
}

interface ClientState {
  lastPong: number;
}

export interface WsHubOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  now?: () => number;
}

export class WsHub {
  private readonly clients = new Map<WsClient, ClientState>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: WsHubOptions = {}) {
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  addClient(ws: WsClient): void {
    this.clients.set(ws, { lastPong: this.now() });
  }

  removeClient(ws: WsClient): void {
    this.clients.delete(ws);
  }

  recordPong(ws: WsClient): void {
    const state = this.clients.get(ws);
    if (state) state.lastPong = this.now();
  }

  broadcast(event: WsEvent): void {
    const message = JSON.stringify(event);
    for (const [ws] of this.clients) {
      if (ws.readyState !== 1) {
        this.clients.delete(ws);
        continue;
      }
      try {
        ws.send(message);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  startPing(): void {
    if (this.pingInterval !== null) return;
    this.pingInterval = setInterval(() => {
      const now = this.now();
      for (const [ws, state] of this.clients) {
        if (now - state.lastPong > this.pongTimeoutMs) {
          this.clients.delete(ws);
          try { ws.close(); } catch { /* ignore */ }
          continue;
        }
        try {
          ws.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() } satisfies WsEvent));
        } catch {
          this.clients.delete(ws);
        }
      }
    }, this.pingIntervalMs);
    this.pingInterval.unref?.();
  }

  stopPing(): void {
    if (this.pingInterval === null) return;
    clearInterval(this.pingInterval);
    this.pingInterval = null;
  }

  cleanup(): void {
    this.stopPing();
    for (const [ws] of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }
}

export const hub = new WsHub();
