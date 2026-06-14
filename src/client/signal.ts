import type { ClientMsg, PlayerId, RosterPlayer, ServerMsg, SignalData } from "../shared/protocol";

export interface SignalHandlers {
  onJoined(playerId: PlayerId, room: string, peers: [boolean, boolean]): void;
  onPeer(connected: boolean): void;
  onRoster(players: [RosterPlayer, RosterPlayer], waiting: string[]): void;
  onWaiting(position: number): void;
  onPromoted(): void;
  onSignal(data: SignalData): void;
  onStatus(status: "connecting" | "open" | "closed"): void;
}

const MAX_BACKOFF_MS = 4000;

export class SignalChannel {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private dead = false;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly code: string,
    private readonly token: string,
    private readonly name: string,
    private readonly h: SignalHandlers,
  ) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.kick();
    });
  }

  connect(): void {
    if (this.dead || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.h.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}/ws/${this.code}` +
        `?token=${encodeURIComponent(this.token)}&name=${encodeURIComponent(this.name)}`,
    );
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.h.onStatus("open");
    };

    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data as string) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.t) {
        case "joined":
          this.h.onJoined(msg.playerId, msg.room, msg.peers);
          break;
        case "peer":
          this.h.onPeer(msg.connected);
          break;
        case "roster":
          this.h.onRoster(msg.players, msg.waiting);
          break;
        case "waiting":
          this.h.onWaiting(msg.position);
          break;
        case "promoted":
          this.h.onPromoted();
          break;
        case "signal":
          this.h.onSignal(msg.data);
          break;
      }
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.h.onStatus("closed");
      if (e.code === 4002) {
        this.dead = true; // another tab/device took this slot
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  sendSignal(data: SignalData): void {
    this.send({ t: "signal", data });
  }

  // Drop the current socket and rejoin immediately (used after a promotion:
  // the reserved seat is claimed via the normal token-match join path).
  rejoin(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    this.connect();
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private kick(): void {
    if (this.dead) return;
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.backoff = 500;
      this.connect();
    }
  }

  private scheduleReconnect(): void {
    if (this.dead || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }
}
