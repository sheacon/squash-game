export type PlayerId = 0 | 1;

// Client → server (the room is just a 2-slot WebRTC signaling relay)
export type ClientMsg =
  | { t: "signal"; data: SignalData }
  | { t: "ping"; ts: number };

export interface RosterPlayer {
  name: string | null;
  connected: boolean;
}

// Server → client
export type ServerMsg =
  | { t: "joined"; playerId: PlayerId; room: string; peers: [boolean, boolean] }
  | { t: "peer"; connected: boolean }
  | { t: "roster"; players: [RosterPlayer, RosterPlayer]; waiting: string[] }
  | { t: "waiting"; position: number }
  | { t: "promoted" }
  | { t: "signal"; data: SignalData }
  | { t: "pong"; ts: number };

// Structural mirror of the DOM's RTCIceCandidateInit (this module is also
// compiled for the worker, which has no DOM lib).
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// Relayed verbatim between the two peers
export type SignalData =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: IceCandidate | null };

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 64 * 1024) return null;
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (m === null || typeof m !== "object") return null;
  switch (m.t) {
    case "signal":
      return m.data && typeof m.data === "object" && typeof m.data.kind === "string"
        ? { t: "signal", data: m.data }
        : null;
    case "ping":
      return typeof m.ts === "number" && Number.isFinite(m.ts) ? { t: "ping", ts: m.ts } : null;
    default:
      return null;
  }
}

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_RE = /^[A-Z2-9]{4,8}$/;

export const NAME_MAX = 12;

export function sanitizeName(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/[^\x20-\x7E]/g, "") // printable ASCII only
    .trim()
    .slice(0, NAME_MAX)
    .toUpperCase();
  return cleaned || fallback;
}
