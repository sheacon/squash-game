import type { SignalData } from "../shared/protocol";
import {
  applyAudioTuning,
  applyVideoTuning,
  mungeOpus,
  preferredVideoCodecs,
  TUNING,
  videoSendEncodings,
} from "./tuning";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

export interface RtcEvents {
  sendSignal(data: SignalData): void;
  onState(state: string): void;
}

// Host side: owns the media stream and the input DataChannel.
// A fresh HostSession is created every time the guest (re)appears.
export class HostSession {
  private pc: RTCPeerConnection;
  private pendingIce: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  private voiceTx: RTCRtpTransceiver;
  private videoSender: RTCRtpSender | null = null;
  private gameAudioSenders: RTCRtpSender[] = [];
  channel: RTCDataChannel;

  constructor(
    stream: MediaStream,
    private readonly ev: RtcEvents,
    onInput: (buf: ArrayBuffer) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // video first, capped from the very first encoded frame (see tuning.ts)
    for (const track of stream.getVideoTracks()) {
      try {
        track.contentHint = TUNING.video.contentHint;
      } catch {}
      try {
        const tx = this.pc.addTransceiver(track, {
          streams: [stream],
          sendEncodings: videoSendEncodings(track),
        });
        this.videoSender = tx.sender;
        const prefs = preferredVideoCodecs();
        if (prefs) tx.setCodecPreferences(prefs);
      } catch {
        // older browsers: plain addTrack; caps land post-setLocalDescription
        this.videoSender ??= this.pc.addTrack(track, stream);
      }
    }
    for (const track of stream.getAudioTracks()) {
      this.gameAudioSenders.push(this.pc.addTrack(track, stream));
    }
    // reserved walkie-talkie lane: mic tracks slot in later via replaceTrack.
    // Must stay the LAST audio m-line — the guest's voice detection and the
    // Opus munge in tuning.ts both lean on that.
    this.voiceTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });

    // Unordered: one lost packet must never head-of-line-block the inputs
    // behind it. Safe because pad messages are full-state snapshots with a
    // seq (see buttons.ts) — order doesn't matter, staleness is detectable.
    // Still reliable: the final snapshot always lands, so no stuck keys.
    this.channel = this.pc.createDataChannel("input", { ordered: false });
    this.channel.binaryType = "arraybuffer";
    this.channel.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) onInput(e.data);
    };

    this.pc.onicecandidate = (e) => {
      ev.sendSignal({ kind: "ice", candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    this.pc.onconnectionstatechange = () => {
      // some browsers only populate sender encodings once connected
      if (this.pc.connectionState === "connected") this.applySenderTuning();
      ev.onState(this.pc.connectionState);
    };

    void this.start();
  }

  private async start(): Promise<void> {
    const offer = await this.pc.createOffer();
    // our only inbound audio is the guest's voice lane: cap it + enable DTX
    const munged = mungeOpus(offer.sdp!, TUNING.audio.voice, TUNING.audio.voice);
    let sdp = offer.sdp!;
    try {
      await this.pc.setLocalDescription({ type: "offer", sdp: munged });
      sdp = munged;
    } catch {
      await this.pc.setLocalDescription(offer); // pristine fallback
    }
    this.applySenderTuning();
    // signal exactly what we applied locally
    this.ev.sendSignal({ kind: "offer", sdp });
  }

  private applySenderTuning(): void {
    applyVideoTuning(this.videoSender);
    for (const s of this.gameAudioSenders) applyAudioTuning(s, "game");
    applyAudioTuning(this.voiceTx.sender, "voice");
  }

  async onSignal(data: SignalData): Promise<void> {
    try {
      if (data.kind === "answer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        this.haveRemote = true;
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
      } else if (data.kind === "ice" && data.candidate) {
        // candidates can outrun the answer; hold them until it lands
        if (this.haveRemote) await this.pc.addIceCandidate(data.candidate);
        else this.pendingIce.push(data.candidate);
      }
    } catch (err) {
      console.warn("host signal error", err);
    }
  }

  get voiceSender(): RTCRtpSender {
    return this.voiceTx.sender;
  }

  get voiceTrack(): MediaStreamTrack {
    return this.voiceTx.receiver.track;
  }

  close(): void {
    try {
      this.pc.close();
    } catch {}
  }
}

// Guest side: receives the stream, owns nothing. Recreated on every offer.
export class GuestSession {
  private pc: RTCPeerConnection;
  private pendingIce: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  private voiceTx: RTCRtpTransceiver | null = null;
  channel: RTCDataChannel | null = null;

  constructor(
    private readonly ev: RtcEvents,
    onStream: (stream: MediaStream) => void,
    onChannelOpen: () => void,
    onMessage: (buf: ArrayBuffer) => void = () => {},
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.ontrack = (e) => {
      if (e.streams[0]) onStream(e.streams[0]);
    };
    this.pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this.channel.binaryType = "arraybuffer";
      this.channel.onopen = onChannelOpen;
      this.channel.onmessage = (ev2) => {
        if (ev2.data instanceof ArrayBuffer) onMessage(ev2.data);
      };
    };
    this.pc.onicecandidate = (e) => {
      ev.sendSignal({ kind: "ice", candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    this.pc.onconnectionstatechange = () => ev.onState(this.pc.connectionState);
  }

  async acceptOffer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    this.haveRemote = true;
    // the host's offer reserves a walkie-talkie lane as its LAST audio
    // m-line; answer it bidirectionally so our mic can ride it later
    const audioTxs = this.pc.getTransceivers().filter((t) => t.receiver.track?.kind === "audio");
    this.voiceTx = audioTxs[audioTxs.length - 1] ?? null;
    if (this.voiceTx) this.voiceTx.direction = "sendrecv";
    for (const c of this.pendingIce.splice(0)) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn("guest ice error", err);
      }
    }
    const answer = await this.pc.createAnswer();
    // cap our inbound audio: game lanes get mono+FEC, the last lane is the
    // host's voice (invariant above) and additionally gets DTX
    const munged = mungeOpus(answer.sdp!, TUNING.audio.game, TUNING.audio.voice);
    let outSdp = answer.sdp!;
    try {
      await this.pc.setLocalDescription({ type: "answer", sdp: munged });
      outSdp = munged;
    } catch {
      await this.pc.setLocalDescription(answer); // pristine fallback
    }
    applyAudioTuning(this.voiceTx?.sender ?? null, "voice");
    this.ev.sendSignal({ kind: "answer", sdp: outSdp });
  }

  // stream-health telemetry for the HUD quality dot
  stats(): Promise<RTCStatsReport> {
    return this.pc.getStats();
  }

  async addIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    if (!this.haveRemote) {
      // candidates can outrun the offer; hold them until it lands
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("guest ice error", err);
    }
  }

  send(buf: Uint8Array<ArrayBuffer>): void {
    if (this.channel && this.channel.readyState === "open") {
      this.channel.send(buf);
    }
  }

  get voiceSender(): RTCRtpSender | null {
    return this.voiceTx?.sender ?? null;
  }

  get voiceTrack(): MediaStreamTrack | null {
    return this.voiceTx?.receiver.track ?? null;
  }

  close(): void {
    try {
      this.pc.close();
    } catch {}
  }
}
