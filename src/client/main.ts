import {
  NAME_MAX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_RE,
  sanitizeName,
  type RosterPlayer,
  type SignalData,
} from "../shared/protocol";
import { decodeInput, encodeInput, encodePadState, FIRE1, PAD, VOICE_STATE } from "./buttons";
import {
  installAudioTap,
  installAutoResume,
  resumeEmulator,
  setGameDuck,
  romAvailable,
  startEmulator,
  startTestPattern,
  type HostGame,
} from "./host";
import { GuestSession, HostSession } from "./rtc";
import { SignalChannel } from "./signal";
import { bindKeyboard, isTouchDevice, TouchControls } from "./touch";
import { TUNING } from "./tuning";
import { PushToTalk } from "./voice";

function genCode(): string {
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  let code = "";
  for (const n of buf) code += ROOM_CODE_ALPHABET[n % ROOM_CODE_ALPHABET.length];
  return code;
}

// --- room + identity ---
let code = location.hash.slice(1).toUpperCase();
if (!ROOM_CODE_RE.test(code)) {
  code = genCode();
  history.replaceState(null, "", "#" + code);
}
const token = sessionStorage.getItem("squash-token") ?? crypto.randomUUID();
sessionStorage.setItem("squash-token", token);

// --- elements ---
const $ = (id: string) => document.getElementById(id)!;
const emulatorEl = $("emulator");
const videoEl = $("remote") as HTMLVideoElement;
const touchControlsEl = $("touch-controls");
const overlayEl = $("overlay");
const cardEl = $("overlay-card");
const hudRoom = $("room");
const hudConn = $("conn");
const hudRtc = $("rtc");
const presenceEl = $("presence");
const announceEl = $("announce");
const voiceEl = $("voice") as HTMLAudioElement;

// --- ducking: drop game audio to 75% while either talk line is open ---
// All ducking happens in the host's audio graph (setGameDuck), which lowers
// both the host's speakers and the stream sent to the guest. The guest just
// reports its talk state over the data channel.
let remoteTalk = false;

function updateDuck(): void {
  if (role === "host") setGameDuck(ptt.open || remoteTalk);
}

function sendVoiceState(open: boolean): void {
  const buf = encodeInput(VOICE_STATE, open ? 1 : 0);
  if (role === "host" && hostSession?.channel.readyState === "open") {
    hostSession.channel.send(buf);
  } else if (role === "guest") {
    guestSession?.send(buf);
  }
}

const ptt = new PushToTalk($("talk-btn"), (open) => {
  sendVoiceState(open);
  updateDuck();
});

function onRemoteVoiceState(value: number): void {
  remoteTalk = value === 1;
  updateDuck();
}

function wireVoice(sender: RTCRtpSender | null, track: MediaStreamTrack | null): void {
  void ptt.attach(sender);
  if (track) {
    voiceEl.srcObject = new MediaStream([track]);
    void voiceEl.play().catch(() => {}); // retried on the next gesture
  }
}

hudRoom.textContent = "#" + code;

// Gameplay tips from the original game's instructions. They live on the menu
// cards (where players are idle and can read), not over live gameplay; the
// shot strengths are labeled on the fire buttons themselves (HARD/SOFT).
const TIPS_HTML = `
  <div class="tips">
    <p>First to nine points wins the game. Best of five games.</p>
    <p>At the moment you swing, aim the joystick.</p>
  </div>
`;

function showControls(): void {
  // The in-game pill carries only the coin instruction. It gates play, so it
  // has no timer: it stays up until a coin actually goes in.
  if (!touchControlsEl.hidden) return;
  touchControlsEl.hidden = false;
}

// The in-game hint walks a player through the arcade's start sequence. The
// COIN/START pill stays up until a coin goes in AND then START is pressed,
// which swaps in the player-select hint; that one stays until the first HARD
// press confirms a player. Both are one-shot: once dismissed they don't return.
let coinInserted = false;

function onCoinInserted(): void {
  coinInserted = true;
}

function onStartPressed(): void {
  if (!coinInserted) return; // arcade flow: insert COIN first, then press START
  const coin = touchControlsEl.querySelector<HTMLElement>(".coin-hint:not(.select-hint)");
  if (!coin || coin.hidden) return; // only the first qualifying START swaps it
  coin.hidden = true;
  const select = touchControlsEl.querySelector<HTMLElement>(".select-hint");
  if (select) {
    select.classList.remove("gone"); // in case HARD was mashed before START
    select.hidden = false;
  }
}

function onConfirmPressed(): void {
  touchControlsEl.querySelector(".select-hint")?.classList.add("gone");
}

function showCard(html: string): void {
  cardEl.innerHTML = html;
  overlayEl.hidden = false;
}
function hideCard(): void {
  overlayEl.hidden = true;
}

function shareLink(): void {
  const url = location.href;
  if (navigator.share) {
    navigator.share({
      title: "SQUASH",
      text: "Play the 1992 Squash arcade game with me, head-to-head:",
      url,
    }).catch(() => {});
  } else {
    void navigator.clipboard.writeText(url).then(() => {
      const note = cardEl.querySelector(".copied");
      if (note) note.textContent = "copied!";
    });
  }
}

// --- wake lock ---
let wakeLock: any = null;
async function requestWakeLock(): Promise<void> {
  try {
    wakeLock = await (navigator as any).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeLock) void requestWakeLock();
});

// --- roles ---
type Role = "host" | "guest" | "waiter";
let role: Role | null = null;
let hostGame: HostGame | null = null;
let hostSession: HostSession | null = null;
let guestSession: GuestSession | null = null;
let peerPresent = false;
let signal: SignalChannel | null = null;

// --- roster / presence ---
let roster: [RosterPlayer, RosterPlayer] | null = null;
let waitingNames: string[] = [];
let waitPosition = 0;
let announceTimer: number | null = null;

function renderPresence(): void {
  if (!roster) return;
  const seat = (i: 0 | 1) => {
    const p = roster![i];
    const label = p.name ?? "OPEN";
    const cls = p.name && p.connected ? "on" : "off";
    return `<span class="seat"><i class="dot ${cls}"></i>P${i + 1} ${label}</span>`;
  };
  const wait = waitingNames.length
    ? `<span class="wait">+${waitingNames.length} WAITING</span>`
    : "";
  presenceEl.innerHTML = seat(0) + seat(1) + wait;
}

function announce(text: string): void {
  announceEl.textContent = text;
  announceEl.classList.add("show");
  if (announceTimer !== null) clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => announceEl.classList.remove("show"), 4000);
}

// Compare rosters so a solo-playing host notices arrivals and departures.
function announceChanges(next: [RosterPlayer, RosterPlayer], nextWaiting: string[]): void {
  if (roster) {
    for (const i of [0, 1] as const) {
      const was = roster[i];
      const now = next[i];
      const me = (role === "host" && i === 0) || (role === "guest" && i === 1);
      if (me) continue;
      if (now.name && now.connected && (!was.connected || was.name !== now.name)) {
        announce(`${now.name} JOINED AS PLAYER ${i + 1}`);
      } else if (was.name && was.connected && !now.connected) {
        announce(`${was.name} LEFT`);
      }
    }
    if (nextWaiting.length > waitingNames.length) {
      announce(`${nextWaiting[nextWaiting.length - 1]} IS WAITING TO PLAY`);
    }
  }
  roster = next;
  waitingNames = nextWaiting;
}

function newRoom(): void {
  location.hash = genCode();
  location.reload();
}

function showWaiterCard(): void {
  const p0 = roster?.[0];
  const p1 = roster?.[1];
  const versus =
    p0?.name || p1?.name
      ? `<p>${p0?.name ?? "?"} (P1)${p0?.connected ? "" : " · offline"} vs ${p1?.name ?? "?"} (P2)</p>`
      : "";
  const hostGone = p0 && !p0.connected;
  showCard(`
    <h1>COURT BUSY</h1>
    ${versus}
    <p class="pulse">you're #${waitPosition} in line, you'll take Player 2 when it opens</p>
    ${hostGone ? `<p class="warn">the host is offline, this room may not come back</p>` : ""}
    <button id="new-room-btn" class="secondary">START YOUR OWN ROOM</button>
  `);
  $("new-room-btn").addEventListener("click", newRoom);
}

const rtcEvents = {
  sendSignal(data: SignalData) {
    signal?.sendSignal(data);
  },
  onState(state: string) {
    hudRtc.textContent = state;
    hudRtc.dataset.s = state;
    // surface progress on whatever waiting card is up (helps diagnose NAT issues)
    const waitState = cardEl.querySelector(".wait-state");
    if (waitState) waitState.textContent = `connection: ${state}`;
    if (role === "guest" && state === "connected") hideCard();
  },
};

// ---------------- host ----------------

async function becomeHost(): Promise<void> {
  role = "host";
  emulatorEl.hidden = false;
  videoEl.hidden = true;
  touchControlsEl.hidden = true;

  // ?testpattern=1 forces the diagnostic stream (used by the e2e tests)
  const forceTest = new URLSearchParams(location.search).has("testpattern");
  const hasRom = !forceTest && (await romAvailable());
  showCard(`
    <h1>SQUASH</h1>
    <p class="sub">gaelco &middot; 1992</p>
    <img class="manual" src="/gameplay.png" alt="Squash arcade gameplay"
      onerror="this.remove()">
    ${hasRom ? "" : `<p class="warn">No squash.zip found, so this runs a test pattern.<br>Add the ROM to public/ and redeploy for the real game.</p>`}
    <p>The original 1992 Gaelco arcade game, running right here in the browser.
    This phone is the cabinet: play solo against the computer, or share the link
    and a friend joins from their own phone as the second player, live over the
    internet.</p>
    <button id="boot-btn" class="big">${hasRom ? "START MACHINE" : "START TEST PATTERN"}</button>
  `);
  $("boot-btn").addEventListener("click", async () => {
    void requestWakeLock();
    showCard(`<h1>SQUASH</h1><p class="pulse">booting&hellip;</p>`);
    try {
      installAudioTap();
      hostGame = hasRom ? await startEmulator(emulatorEl) : startTestPattern(emulatorEl);
      if (hasRom) installAutoResume();
    } catch (err) {
      showCard(`<h1>BOOT FAILED</h1><p>${(err as Error).message}</p>`);
      return;
    }
    // Same controls as the guest, wired straight into Player 1.
    if (isTouchDevice()) {
      const controls = new TouchControls(touchControlsEl, (id, value) => {
        if (value && id === PAD.SELECT) onCoinInserted();
        else if (value && id === PAD.START) onStartPressed();
        else if (value && id === FIRE1) onConfirmPressed();
        hostGame?.localInput(id, value);
      });
      showControls();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") controls.releaseAll();
      });
    } else {
      // desktop host plays with the keyboard via EmulatorJS, but still gets
      // the presence strip and join/leave announcements
      touchControlsEl.classList.add("desktop");
      touchControlsEl.hidden = false;
    }
    (window as any).__hostReady = true; // e2e test hook
    afterBoot();
    // clear any pause overlay the core came up with, so the host doesn't land
    // on the broken "undefined / Click to resume" screen behind the card
    if (hasRom) resumeEmulator();
  });
}

function afterBoot(): void {
  if (peerPresent) {
    hideCard();
    connectToGuest();
  } else {
    showCard(`
      <h1>READY</h1>
      <p>Share this link with a friend for multiplayer:</p>
      <p class="link">${location.href}</p>
      <button id="share-btn" class="big">SHARE LINK</button>
      <p class="copied sub"></p>
      <button id="solo-btn" class="secondary">PLAY SOLO</button>
      <p class="sub">Your friend can still join mid-game with the link</p>
      ${TIPS_HTML}
    `);
    $("share-btn").addEventListener("click", shareLink);
    $("solo-btn").addEventListener("click", () => hideCard());
  }
}

function connectToGuest(): void {
  if (!hostGame) return;
  hostSession?.close();
  remoteTalk = false;
  updateDuck();
  hostSession = new HostSession(hostGame.stream, rtcEvents, (buf) => {
    const input = decodeInput(buf);
    if (input?.id === VOICE_STATE) {
      onRemoteVoiceState(input.value);
      return;
    }
    hostGame!.applyInput(buf);
  });
  hostSession.channel.onopen = () => {
    if (ptt.open) sendVoiceState(true);
  };
  wireVoice(hostSession.voiceSender, hostSession.voiceTrack);
}

// ---------------- guest ----------------

// Stream health for the HUD dot: poll inbound video stats so the guest can
// tell a struggling network from a struggling host. Always reads the CURRENT
// session — sessions are recreated on every reconnect.
const hudNet = $("net");
let netTimer: number | null = null;
let netPrev: { bytes: number; recv: number; lost: number } | null = null;

function startNetMonitor(): void {
  if (netTimer !== null) return;
  hudNet.hidden = false;
  netTimer = window.setInterval(() => void sampleNet(), TUNING.stats.pollMs);
}

async function sampleNet(): Promise<void> {
  const session = guestSession;
  if (!session) return;
  try {
    const report = await session.stats();
    let inbound: any = null;
    const byId = new Map<string, any>();
    report.forEach((s: any) => {
      byId.set(s.id, s);
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
    });
    if (!inbound) return;
    const cur = {
      bytes: inbound.bytesReceived ?? 0,
      recv: inbound.packetsReceived ?? 0,
      lost: inbound.packetsLost ?? 0,
    };
    const prev = netPrev;
    netPrev = cur;
    // first sample, or counters reset because the session was recreated
    if (!prev || cur.bytes < prev.bytes) return;
    const kbps = ((cur.bytes - prev.bytes) * 8) / TUNING.stats.pollMs;
    const dRecv = cur.recv - prev.recv;
    const dLost = Math.max(0, cur.lost - prev.lost);
    const lossPct = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
    const fps = inbound.framesPerSecond ?? 0; // absent from stats while stalled
    let s: "good" | "ok" | "bad";
    if (fps < TUNING.stats.badFps || lossPct > TUNING.stats.badLossPct) s = "bad";
    else if (fps >= TUNING.stats.goodFps && lossPct <= TUNING.stats.okLossPct) s = "good";
    else s = "ok";
    hudNet.dataset.s = s;
    const codec = inbound.codecId ? (byId.get(inbound.codecId)?.mimeType ?? "") : "";
    (window as any).__netStats = { kbps, fps, lossPct, codec }; // e2e test hook
  } catch {}
}

// Pad state mirror: every change ships immediately as a full snapshot (plus
// the legacy edge event so a not-yet-reloaded host still works), and a short
// heartbeat re-sends the snapshot while anything is held or recently changed
// so packet loss never leaves the host holding a stale stick (see buttons.ts).
let padBits = 0;
let padSeq = 0;
let padLastChange = -Infinity;
let padTimer: number | null = null;

function sendPadSnapshot(): void {
  padSeq = (padSeq + 1) & 0xff;
  guestSession?.send(encodePadState(padSeq, padBits));
}

function sendPad(id: number, value: 0 | 1): void {
  if (value) padBits |= 1 << id;
  else padBits &= ~(1 << id);
  padLastChange = performance.now();
  guestSession?.send(encodeInput(id, value)); // legacy first: old hosts apply it
  sendPadSnapshot();
}

function startPadHeartbeat(): void {
  if (padTimer !== null) return;
  padTimer = window.setInterval(() => {
    if (padBits === 0 && performance.now() - padLastChange > TUNING.input.activeTailMs) return;
    sendPadSnapshot();
  }, TUNING.input.heartbeatMs);
}

function becomeGuest(): void {
  role = "guest";
  emulatorEl.hidden = true;
  videoEl.hidden = false;
  startNetMonitor();
  startPadHeartbeat();

  showCard(`
    <h1>SQUASH</h1>
    <p class="sub">you are player 2</p>
    <p class="pulse">waiting for the host to start the machine&hellip;</p>
    <p class="sub wait-state"></p>
  `);

  guestSession = newGuestSession();

  const controls = new TouchControls(touchControlsEl, (id, value) => {
    if (value && id === PAD.SELECT) onCoinInserted();
    else if (value && id === PAD.START) onStartPressed();
    else if (value && id === FIRE1) onConfirmPressed();
    sendPad(id, value);
  });
  bindKeyboard(sendPad);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") controls.releaseAll();
  });
}

function newGuestSession(): GuestSession {
  guestSession?.close();
  remoteTalk = false;
  updateDuck();
  return new GuestSession(
    rtcEvents,
    (stream) => {
      videoEl.srcObject = stream;
      // autoplay with audio needs a gesture: make the unlock tap explicit
      showCard(`
        <h1>GAME ON</h1>
        <p>The host's machine is live.</p>
        <button id="play-btn" class="big">TAP TO PLAY</button>
        <p class="sub">joystick bottom-left &middot; buttons bottom-right</p>
        ${TIPS_HTML}
      `);
      $("play-btn").addEventListener("click", () => {
        void requestWakeLock();
        videoEl.muted = false;
        void videoEl.play().catch(() => {
          videoEl.muted = true; // fall back to muted rather than nothing
          void videoEl.play();
        });
        showControls();
        hideCard();
        (window as any).__guestPlaying = true; // e2e test hook
      });
    },
    () => {
      hudRtc.textContent = "controls live";
      // controls become usable the moment the input channel opens, even if
      // the video element is still waiting on its unlock tap
      showControls();
      if (ptt.open) sendVoiceState(true);
      // sync the pad immediately: a (re)connect mid-hold restores held keys
      sendPadSnapshot();
    },
    (buf) => {
      const input = decodeInput(buf);
      if (input?.id === VOICE_STATE) onRemoteVoiceState(input.value);
    },
  );
}

// ---------------- signaling ----------------

function startSignal(name: string): void {
  signal = new SignalChannel(code, token, name, {
    onJoined(playerId, _room, peers) {
      peerPresent = peers[1 - playerId];
      if (role === null || role === "waiter") {
        if (playerId === 0) void becomeHost();
        else becomeGuest();
      }
    },
    onPeer(connected) {
      peerPresent = connected;
      if (!connected) {
        remoteTalk = false;
        updateDuck();
      }
      if (role === "host" && hostGame) {
        if (connected) {
          hideCard();
          connectToGuest();
        } else {
          hostSession?.close();
          hostSession = null;
          showCard(`
            <h1>HOLD ON</h1>
            <p class="pulse">opponent reconnecting&hellip;</p>
            <button id="solo-btn" class="secondary">KEEP PLAYING SOLO</button>
          `);
          $("solo-btn").addEventListener("click", () => hideCard());
        }
      }
      if (role === "guest" && !connected) {
        showCard(`
          <h1>HOLD ON</h1>
          <p class="pulse">host went away, waiting&hellip;</p>
          <button id="new-room-btn" class="secondary">START YOUR OWN ROOM</button>
        `);
        $("new-room-btn").addEventListener("click", newRoom);
      }
    },
    onRoster(players, waiting) {
      announceChanges(players, waiting);
      renderPresence();
      if (role === "waiter") showWaiterCard();
    },
    onWaiting(position) {
      waitPosition = position;
      if (role !== "waiter") {
        role = "waiter";
        emulatorEl.hidden = true;
        videoEl.hidden = true;
        touchControlsEl.hidden = true;
      }
      showWaiterCard();
    },
    onPromoted() {
      showCard(`<h1>YOU'RE UP</h1><p class="pulse">taking the Player 2 seat&hellip;</p>`);
      signal?.rejoin();
    },
    onSignal(data) {
      if (role === "host") {
        void hostSession?.onSignal(data);
      } else if (role === "guest") {
        if (data.kind === "offer") {
          const session = newGuestSession();
          guestSession = session;
          void session.acceptOffer(data.sdp).then(() => {
            wireVoice(session.voiceSender, session.voiceTrack);
          });
        } else if (data.kind === "ice") {
          void guestSession?.addIce(data.candidate);
        }
      }
    },
    onStatus(status) {
      hudConn.dataset.s = status;
    },
  });
  signal.connect();
}

// ---------------- name gate ----------------

function showNameCard(): void {
  showCard(`
    <h1>SQUASH</h1>
    <p class="sub">Gaelco &middot; 1992 arcade</p>
    <p>The original 1992 Squash arcade cabinet, played head-to-head over the
    internet. One phone runs the real game; the other is the second player's
    controller. No app, no install. Just tap in and play.</p>
    <p>Who's playing on this phone?</p>
    <input id="name-input" maxlength="${NAME_MAX}" placeholder="YOUR NAME"
      autocomplete="off" autocapitalize="characters" spellcheck="false">
    <button id="name-btn" class="big" disabled>LET'S PLAY</button>
  `);
  const input = $("name-input") as HTMLInputElement;
  const btn = $("name-btn") as HTMLButtonElement;
  const submit = () => {
    const name = sanitizeName(input.value, "");
    if (!name) return;
    localStorage.setItem("squash-name", name);
    showCard(`<h1>SQUASH</h1><p class="pulse">connecting&hellip;</p>`);
    startSignal(name);
  };
  input.addEventListener("input", () => {
    btn.disabled = sanitizeName(input.value, "") === "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  btn.addEventListener("click", submit);
  input.focus();
}

// belt-and-suspenders against scroll/zoom/pull-to-refresh
$("stage").addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

// iOS Safari ignores user-scalable=no: suppress double-tap zoom by eating
// only the SECOND tap of a fast pair (single taps still produce clicks),
// and block pinch gestures outright.
// any gesture is a chance to unlock audio playback (iOS autoplay policy)
document.addEventListener("pointerdown", () => {
  if (voiceEl.srcObject && voiceEl.paused) void voiceEl.play().catch(() => {});
});

let lastTouchEnd = 0;
document.addEventListener(
  "touchend",
  (e) => {
    const now = performance.now();
    if (now - lastTouchEnd < 320) e.preventDefault();
    lastTouchEnd = now;
  },
  { passive: false },
);
for (const evt of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener("dblclick", (e) => e.preventDefault());

const storedName = localStorage.getItem("squash-name");
if (storedName) startSignal(storedName);
else showNameCard();
