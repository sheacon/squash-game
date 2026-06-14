// RetroPad button ids (libretro standard) used over the input DataChannel and
// with EmulatorJS's gameManager.simulateInput(player, id, value).
export const PAD = {
  B: 0, // FBNeo: fire 1
  Y: 1, // FBNeo: fire 2
  SELECT: 2, // coin
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  A: 8,
  X: 9,
} as const;

// Gaelco Squash uses an 8-way stick + 2 buttons per player.
// Playtested: FBNeo maps the cabinet's two buttons to RetroPad B and A.
export const FIRE1 = PAD.B;
export const FIRE2 = PAD.A;

// Out-of-band message id on the input DataChannel: "my talk line is open/closed".
export const VOICE_STATE = 200;

// Input messages on the DataChannel: [buttonId, value] as a 2-byte payload.
export function encodeInput(id: number, value: 0 | 1): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(new ArrayBuffer(2));
  view[0] = id;
  view[1] = value;
  return view;
}

export function decodeInput(buf: ArrayBuffer): { id: number; value: 0 | 1 } | null {
  const v = new Uint8Array(buf);
  if (v.length !== 2) return null;
  return { id: v[0], value: v[1] ? 1 : 0 };
}

// --- low-latency pad snapshots ------------------------------------------
// The input channel is UNORDERED (see rtc.ts): an ordered channel head-of-
// line-blocks every input behind one lost packet for a full retransmission
// round trip. Edge events can't survive reordering (a retransmitted "press"
// landing after its "release" wedges the button), so the guest sends its
// COMPLETE pad state in every message: [seq, bits_lo, bits_hi], 3 bytes,
// where bit N = RetroPad id N held. Any single message fully describes the
// controller; the receiver just ignores anything older than what it applied.
// The guest still sends the legacy 2-byte edge event alongside each snapshot
// so a not-yet-reloaded host from before this protocol keeps working.

export const PAD_COUNT = 10; // RetroPad ids 0-9 fit the snapshot bitmask

export function encodePadState(seq: number, bits: number): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(new ArrayBuffer(3));
  view[0] = seq & 0xff;
  view[1] = bits & 0xff;
  view[2] = (bits >> 8) & 0xff;
  return view;
}

export function decodePadState(buf: ArrayBuffer): { seq: number; bits: number } | null {
  const v = new Uint8Array(buf);
  if (v.length !== 3) return null;
  return { seq: v[0], bits: v[1] | (v[2] << 8) };
}

// serial-number compare on the wrapping 1-byte seq
function seqNewer(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xff) < 0x80;
}

// Host-side receiver: turns snapshots back into (id, value) edges for
// simulateInput, dropping stale ones. Falls back to legacy edge events until
// the first snapshot arrives (old guest, or the opening race), then latches
// onto snapshots and ignores the duplicated legacy stream.
export function createPadReceiver(apply: (id: number, value: 0 | 1) => void) {
  let lastSeq = -1;
  let applied = 0;
  let snapshots = false;
  return (buf: ArrayBuffer): void => {
    const snap = decodePadState(buf);
    if (snap) {
      if (lastSeq >= 0 && !seqNewer(snap.seq, lastSeq)) return; // stale/duplicate
      lastSeq = snap.seq;
      snapshots = true;
      const diff = snap.bits ^ applied;
      for (let id = 0; id < PAD_COUNT; id++) {
        if (diff & (1 << id)) apply(id, ((snap.bits >> id) & 1) as 0 | 1);
      }
      applied = snap.bits;
      return;
    }
    const input = decodeInput(buf);
    if (!input || snapshots) return;
    // legacy mode: mirror into the bitmask so a mid-stream switch diffs right
    if (input.id < PAD_COUNT) {
      if (input.value) applied |= 1 << input.id;
      else applied &= ~(1 << input.id);
    }
    apply(input.id, input.value);
  };
}
