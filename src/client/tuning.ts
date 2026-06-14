// Every bandwidth/quality knob for the guest's stream lives here. The guest's
// whole game is this stream, so the encoder is tuned for limited links:
// a hard bitrate ceiling (uncapped canvas capture happily pushes 1-2+ Mbps,
// and on a constrained path that queueing means frozen video and laggy
// inputs), VP9 preferred for compression, smooth-over-sharp degradation
// (a choppy ball is unplayable; a chunky one is trackable), and capped
// mono Opus with FEC. Video outranks audio under contention: the picture IS
// the gameplay, and the audio lanes are capped so small they can't starve it.
//
// Deliberate non-knobs: no receiver jitterBufferTarget (it can only RAISE
// playout delay above the adaptive minimum); no getStats-driven bitrate
// controller on the host (WebRTC's congestion control already adapts the
// send rate below our ceiling, and degradationPreference governs how the
// encoder spends whatever it is granted — a second feedback loop would just
// fight the first); no non-standard x-google-* SDP params.

export const TUNING = {
  video: {
    // favor framerate over sharpness when the encoder is squeezed
    contentHint: "motion",
    degradationPreference: "maintain-framerate" as RTCDegradationPreference,
    captureFps: 30,
    maxBitrate: 450_000,
    maxFramerate: 30,
    // the game is 320x240; if a future EmulatorJS build ever hands us a
    // screen-sized canvas, scale the encode back down to native-ish
    targetWidth: 320,
    maxCaptureWidth: 480,
    // gameplay-critical: video wins bandwidth contention and QoS marking
    priority: "high" as RTCPriorityType,
  },
  audio: {
    priority: "medium" as RTCPriorityType, // below video, normal best-effort DSCP
    // fmtp params: what each receiver asks the remote sender to encode
    game: { maxaveragebitrate: 32_000, stereo: 0, useinbandfec: 1 },
    voice: { maxaveragebitrate: 24_000, stereo: 0, useinbandfec: 1, usedtx: 1 },
  },
  // AV1 deliberately absent: encode cost on a phone already running an emulator
  codecPrefs: ["video/VP9", "video/H264", "video/VP8"],
  // Run the arcade machine below original speed (1 = full speed): both
  // players get more time to react, which partly offsets the guest's stream
  // latency. Uniform slowdown (logic + video + audio); audio pitch drops
  // with speed (~1.8 semitones at 0.9). prod-e2e.mjs asserts this ratio.
  gameSpeed: 0.9,
  input: {
    // while any button is held (or just changed), the guest re-sends its full
    // pad snapshot so a lost packet is healed by the next beat instead of
    // waiting out an SCTP retransmission timeout
    heartbeatMs: 50,
    activeTailMs: 500, // keep beating briefly after release: heals a lost "all up"
  },
  stats: { pollMs: 2000, goodFps: 22, badFps: 12, badLossPct: 8, okLossPct: 2 },
};

// Each knob fails independently: an old browser missing one API loses that
// knob alone and keeps today's defaults for it. Warn once per knob, not per
// retry (sessions are recreated on every reconnect).
const warned = new Set<string>();
function warnOnce(knob: string, err: unknown): void {
  if (warned.has(knob)) return;
  warned.add(knob);
  console.warn(`tuning: ${knob} unavailable`, err);
}

// Codec list for setCodecPreferences: VP9 > H264 > VP8, AV1 dropped,
// rtx/red/fec helpers kept at the tail (some Chromes reject lists without
// them). Returns null when the capabilities API is missing (the negotiation
// then just uses the browser's default order).
export function preferredVideoCodecs(): RTCRtpCodec[] | null {
  try {
    const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
    if (!codecs?.length) return null;
    const rank = (c: RTCRtpCodec): number => {
      const mime = c.mimeType.toLowerCase();
      if (mime === "video/av1" || mime === "video/av1x") return -1;
      const i = TUNING.codecPrefs.findIndex((p) => p.toLowerCase() === mime);
      if (i >= 0) return i;
      // unknown real codecs after our picks, retransmission/FEC last
      return /\/(rtx|red|ulpfec|flexfec)/.test(mime)
        ? TUNING.codecPrefs.length + 1
        : TUNING.codecPrefs.length;
    };
    const kept = codecs.filter((c) => rank(c) >= 0);
    kept.sort((a, b) => rank(a) - rank(b)); // stable: profile order survives
    return kept.length ? kept : null;
  } catch (err) {
    warnOnce("codec preferences", err);
    return null;
  }
}

// Initial encoding for the video sender, present from the very first frame.
function videoEncoding(track: MediaStreamTrack | null): RTCRtpEncodingParameters {
  const enc: RTCRtpEncodingParameters = {
    maxBitrate: TUNING.video.maxBitrate,
    maxFramerate: TUNING.video.maxFramerate,
    priority: TUNING.video.priority,
    networkPriority: TUNING.video.priority, // Chrome-only; ignored elsewhere
  };
  try {
    const width = track?.getSettings?.().width; // may be empty pre-first-frame
    if (width && width > TUNING.video.maxCaptureWidth) {
      enc.scaleResolutionDownBy = Math.max(1, width / TUNING.video.targetWidth);
    }
  } catch (err) {
    warnOnce("capture size guard", err);
  }
  return enc;
}

export function videoSendEncodings(track: MediaStreamTrack | null): RTCRtpEncodingParameters[] {
  return [videoEncoding(track)];
}

// Re-assert the video caps on an existing sender. Idempotent; also the only
// path that applies them when addTransceiver-with-sendEncodings wasn't
// available and we fell back to addTrack.
export function applyVideoTuning(sender: RTCRtpSender | null): void {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    // some browsers leave encodings empty until negotiation/ICE completes;
    // callers re-run this on connectionstatechange === "connected"
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0], videoEncoding(sender.track));
    params.degradationPreference = TUNING.video.degradationPreference;
    sender.setParameters(params).catch((err) => warnOnce("video sender params", err));
  } catch (err) {
    warnOnce("video sender params", err);
  }
}

// Audio senders: ranked below video (the picture is the gameplay), plus a
// sender-side bitrate cap as belt-and-suspenders (the fmtp munge below is
// the primary cap and works regardless of sender browser).
export function applyAudioTuning(sender: RTCRtpSender | null, kind: "game" | "voice"): void {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const enc = params.encodings[0];
    enc.priority = TUNING.audio.priority;
    enc.networkPriority = TUNING.audio.priority;
    enc.maxBitrate = TUNING.audio[kind].maxaveragebitrate;
    sender.setParameters(params).catch((err) => warnOnce("audio sender params", err));
  } catch (err) {
    warnOnce("audio sender params", err);
  }
}

type OpusProfile = Record<string, number>;

// Tune the Opus lanes of a LOCAL description before setLocalDescription.
// fmtp params are receive-direction (RFC 7587): they tell the REMOTE sender
// how to encode what it sends to us. `lastAudioProfile` goes to the last
// audio m-line — the reserved walkie-talkie lane (same invariant as the
// guest's voice-transceiver detection in rtc.ts) — which is the one lane
// where DTX pays off (mostly silence). Game audio is continuous, and DTX
// engaging on digital silence between chiptune sounds risks edge artifacts,
// so it stays FEC-only. Returns the SDP unchanged on any unexpected shape.
export function mungeOpus(
  sdp: string,
  profile: OpusProfile,
  lastAudioProfile: OpusProfile,
): string {
  try {
    const sections = sdp.split(/(?=^m=)/m);
    const audio: number[] = [];
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].startsWith("m=audio")) audio.push(i);
    }
    if (!audio.length) return sdp;
    const last = audio[audio.length - 1];
    for (const i of audio) {
      sections[i] = mungeOpusSection(sections[i], i === last ? lastAudioProfile : profile);
    }
    return sections.join("");
  } catch (err) {
    warnOnce("opus sdp tuning", err);
    return sdp;
  }
}

function mungeOpusSection(section: string, profile: OpusProfile): string {
  // payload type can differ per m-section: resolve it from this section's rtpmap
  const rtpmap = section.match(/^(a=rtpmap:(\d+) opus\/48000[^\r\n]*)/im);
  if (!rtpmap) return section;
  const pt = rtpmap[2];
  const fmtpRe = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, "im");
  const existing = section.match(fmtpRe);
  if (!existing) {
    const line = `a=fmtp:${pt} ${renderProfile(profile)}`;
    return section.replace(rtpmap[1], `${rtpmap[1]}\r\n${line}`);
  }
  // merge, don't replace: the browser's own params (minptime, ...) survive
  const params = new Map<string, string>();
  for (const kv of existing[1].split(";")) {
    const eq = kv.indexOf("=");
    const k = (eq < 0 ? kv : kv.slice(0, eq)).trim();
    if (k) params.set(k, eq < 0 ? "" : kv.slice(eq + 1).trim());
  }
  for (const [k, v] of Object.entries(profile)) params.set(k, String(v));
  const merged = [...params].map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
  return section.replace(fmtpRe, `a=fmtp:${pt} ${merged}`);
}

function renderProfile(profile: OpusProfile): string {
  return Object.entries(profile)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
}
