import { DurableObject } from "cloudflare:workers";
import {
  parseClientMsg,
  sanitizeName,
  type PlayerId,
  type ServerMsg,
} from "../shared/protocol";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface Meta {
  room: string;
  tokens: [string | null, string | null];
  names: [string | null, string | null];
}

interface PlayerAttachment {
  playerId: PlayerId;
}

interface WaiterAttachment {
  waiter: true;
  token: string;
  name: string;
  since: number;
}

type Attachment = PlayerAttachment | WaiterAttachment;

const DISCONNECT_TTL_MS = 10 * 60 * 1000;
const JANITOR_MS = 60 * 60 * 1000;
// how long a vacated guest seat is held for its owner before the first
// waiter is promoted into it (covers a phone briefly locking mid-game)
const PROMOTE_GRACE_MS = 45 * 1000;

// Room with two seats plus a waiting queue. Slot 0 = host (runs the
// emulator), slot 1 = guest. Extra joiners wait in line; the first waiter is
// promoted when the guest seat stays empty past the grace period. The DO
// relays WebRTC signaling between the two seats; game traffic is P2P.
export class GameRoom extends DurableObject<Env> {
  private meta: Meta | null = null;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const code = url.pathname.split("/").pop() || "ROOM";
    const token = url.searchParams.get("token") ?? "";
    const rawName = url.searchParams.get("name");
    await this.ensureLoaded(code);
    const meta = this.meta!;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    let slot: PlayerId | -1 = -1;
    if (token) {
      if (meta.tokens[0] === token) slot = 0;
      else if (meta.tokens[1] === token) slot = 1;
      else if (meta.tokens[0] === null) slot = 0;
      else if (meta.tokens[1] === null) slot = 1;
    }

    if (slot === -1) {
      // both seats taken: queue up
      const name = sanitizeName(rawName, "GUEST");
      this.ctx.acceptWebSocket(server, ["waiter", "all"]);
      server.serializeAttachment({
        waiter: true,
        token,
        name,
        since: Date.now(),
      } satisfies WaiterAttachment);
      this.pushQueueState();
      await this.ctx.storage.setAlarm(Date.now() + JANITOR_MS);
      return new Response(null, { status: 101, webSocket: client });
    }

    // A reconnecting player replaces any stale socket in their seat.
    for (const ws of this.ctx.getWebSockets(`p${slot}`)) {
      try {
        ws.close(4002, "replaced");
      } catch {}
    }
    const name = sanitizeName(rawName, `PLAYER ${slot + 1}`);
    if (meta.tokens[slot] !== token || meta.names[slot] !== name) {
      meta.tokens[slot] = token;
      meta.names[slot] = name;
      await this.ctx.storage.put("meta", meta);
    }
    this.ctx.acceptWebSocket(server, [`p${slot}`, "all"]);
    server.serializeAttachment({ playerId: slot } satisfies PlayerAttachment);

    this.send(server, {
      t: "joined",
      playerId: slot,
      room: meta.room,
      peers: [this.connected(0), this.connected(1)],
    });
    this.broadcastPlayersExcept(server, { t: "peer", connected: true });
    this.pushQueueState();
    await this.ctx.storage.setAlarm(Date.now() + JANITOR_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || "waiter" in att) return; // waiters only listen
    const msg = parseClientMsg(typeof message === "string" ? message : "");
    if (!msg) return;

    if (msg.t === "ping") {
      this.send(ws, { t: "pong", ts: msg.ts });
      return;
    }
    // relay signaling to the other seat
    const other = (1 - att.playerId) as PlayerId;
    const data = JSON.stringify({ t: "signal", data: msg.data } satisfies ServerMsg);
    for (const peer of this.ctx.getWebSockets(`p${other}`)) {
      try {
        peer.send(data);
      } catch {}
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleGone(ws);
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();

    // pending promotion?
    const promoteAt = await this.ctx.storage.get<number>("promoteAt");
    if (promoteAt !== undefined && Date.now() >= promoteAt) {
      await this.ctx.storage.delete("promoteAt");
      this.promoteFirstWaiter();
    }

    if (this.ctx.getWebSockets("all").length === 0) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.meta = null;
      return;
    }
    await this.setAlarmAtMost(Date.now() + JANITOR_MS);
  }

  private async handleGone(ws: WebSocket): Promise<void> {
    await this.ensureLoaded();
    const att = ws.deserializeAttachment() as Attachment | null;

    if (att && !("waiter" in att) && !this.connectedExcept(att.playerId, ws)) {
      this.broadcastPlayers({ t: "peer", connected: false });
      // guest seat emptied with people in line: start the promotion clock
      if (att.playerId === 1 && this.waiterSockets(ws).length > 0) {
        const at = Date.now() + PROMOTE_GRACE_MS;
        await this.ctx.storage.put("promoteAt", at);
        await this.setAlarmAtMost(at);
      }
    }
    this.pushQueueState(ws);

    const stillHere = this.ctx.getWebSockets("all").filter((w) => w !== ws);
    if (stillHere.length === 0) {
      await this.setAlarmAtMost(Date.now() + DISCONNECT_TTL_MS);
    }
  }

  // Reserve the guest seat for the longest-waiting waiter and tell them to
  // reconnect; the token-match path in fetch() then seats them normally.
  private promoteFirstWaiter(): void {
    const meta = this.meta!;
    if (this.connected(1)) return; // the original guest came back in time
    const first = this.waiterSockets()[0];
    if (!first) return;
    const att = first.deserializeAttachment() as WaiterAttachment;
    meta.tokens[1] = att.token || crypto.randomUUID();
    meta.names[1] = att.name;
    void this.ctx.storage.put("meta", meta);
    this.send(first, { t: "promoted" });
  }

  private waiterSockets(except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets("waiter")
      .filter((w) => w !== except)
      .sort((a, b) => {
        const aa = a.deserializeAttachment() as WaiterAttachment;
        const bb = b.deserializeAttachment() as WaiterAttachment;
        return aa.since - bb.since;
      });
  }

  // Broadcast the roster to everyone and tell each waiter their position.
  private pushQueueState(except?: WebSocket): void {
    const meta = this.meta!;
    const waiters = this.waiterSockets(except);
    const roster: ServerMsg = {
      t: "roster",
      players: [
        { name: meta.names[0], connected: this.connectedSocketsExcept(0, except).length > 0 },
        { name: meta.names[1], connected: this.connectedSocketsExcept(1, except).length > 0 },
      ],
      waiting: waiters.map((w) => (w.deserializeAttachment() as WaiterAttachment).name),
    };
    const data = JSON.stringify(roster);
    for (const ws of this.ctx.getWebSockets("all")) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {}
    }
    waiters.forEach((ws, i) => this.send(ws, { t: "waiting", position: i + 1 }));
  }

  private connected(slot: PlayerId): boolean {
    return this.ctx.getWebSockets(`p${slot}`).length > 0;
  }

  private connectedExcept(slot: PlayerId, except: WebSocket): boolean {
    return this.connectedSocketsExcept(slot, except).length > 0;
  }

  private connectedSocketsExcept(slot: PlayerId, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(`p${slot}`).filter((w) => w !== except);
  }

  private async setAlarmAtMost(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) {
      await this.ctx.storage.setAlarm(time);
    }
  }

  private async ensureLoaded(code?: string): Promise<void> {
    if (this.meta) return;
    let meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta) {
      meta = { room: code ?? "????", tokens: [null, null], names: [null, null] };
    } else {
      if (code) meta.room = code;
      if (!meta.names) meta.names = [null, null]; // rooms created before names
    }
    this.meta = meta;
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private broadcastPlayers(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const slot of [0, 1]) {
      for (const ws of this.ctx.getWebSockets(`p${slot}`)) {
        try {
          ws.send(data);
        } catch {}
      }
    }
  }

  private broadcastPlayersExcept(except: WebSocket, msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const slot of [0, 1]) {
      for (const ws of this.ctx.getWebSockets(`p${slot}`)) {
        if (ws === except) continue;
        try {
          ws.send(data);
        } catch {}
      }
    }
  }
}
