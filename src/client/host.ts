import { createPadReceiver } from "./buttons";
import { TUNING } from "./tuning";

const EJS_CDN = "https://cdn.emulatorjs.org/stable/data/";
const ROM_URL = "/squash.zip";

declare global {
  interface Window {
    EJS_player: string;
    EJS_core: string;
    EJS_gameUrl: string;
    EJS_gameName: string;
    EJS_pathtodata: string;
    EJS_startOnLoaded: boolean;
    EJS_backgroundColor: string;
    EJS_Buttons: Record<string, boolean>;
    EJS_VirtualGamepadSettings: unknown[];
    EJS_defaultOptions: Record<string, string>;
    EJS_onGameStart?: () => void;
    EJS_emulator?: any;
    EJS_GameManager?: any;
  }
}

// --- audio tap ---------------------------------------------------------
// The emulator creates its own AudioContext. We patch AudioNode.connect so
// anything routed to a context's speakers passes through a master GainNode
// we own, which then feeds BOTH the local speakers and a
// MediaStreamDestination (streamed to the guest). Ducking that one gain
// lowers the game for both players: the guest plays the stream through a
// plain media element (iOS can't reliably route remote tracks into
// WebAudio, so guest-side gain is a non-starter).
interface TapEntry {
  tap: MediaStreamAudioDestinationNode;
  gain: GainNode;
}

const taps = new Map<BaseAudioContext, TapEntry>();
const DUCK_LEVEL = 0.75; // game volume while a talk line is open
let duckTarget = 1;
let origConnectRef: ((...args: any[]) => any) | null = null;

function entryFor(ctx: AudioContext): TapEntry {
  let entry = taps.get(ctx);
  if (!entry) {
    const tap = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = duckTarget;
    // must bypass our own patch or this would recurse
    origConnectRef!.call(gain, ctx.destination);
    origConnectRef!.call(gain, tap);
    entry = { tap, gain };
    taps.set(ctx, entry);
  }
  return entry;
}

export function installAudioTap(): void {
  const origConnect = AudioNode.prototype.connect as (...args: any[]) => any;
  origConnectRef = origConnect;
  (AudioNode.prototype as any).connect = function (this: AudioNode, ...args: any[]) {
    const target = args[0];
    if (target instanceof AudioDestinationNode && this.context instanceof AudioContext) {
      return origConnect.call(this, entryFor(this.context).gain);
    }
    return origConnect.apply(this, args);
  };
}

// Smoothly duck (or restore) the game audio for both players.
export function setGameDuck(ducked: boolean): void {
  duckTarget = ducked ? DUCK_LEVEL : 1;
  for (const [ctx, entry] of taps) {
    const t = (ctx as AudioContext).currentTime;
    entry.gain.gain.cancelScheduledValues(t);
    entry.gain.gain.setTargetAtTime(duckTarget, t, 0.06);
  }
}

// EmulatorJS pauses itself when the page is backgrounded and shows a broken
// "undefined / Click to resume" screen. Resume automatically on return.
export function installAutoResume(): void {
  const resume = () => {
    setTimeout(() => {
      const em = window.EJS_emulator;
      try {
        if (em?.paused) em.play();
        // some pause overlays only clear via their own resume element
        for (const el of document.querySelectorAll<HTMLElement>("#emulator div, #emulator span")) {
          if (/click to resume/i.test(el.textContent ?? "")) {
            el.click();
            break;
          }
        }
        for (const ctx of taps.keys()) {
          if (ctx.state === "suspended") void (ctx as AudioContext).resume();
        }
      } catch {}
    }, 250);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resume();
  });
  window.addEventListener("focus", resume);
  // iOS may keep audio suspended until a real gesture lands
  document.addEventListener("pointerdown", () => {
    for (const ctx of taps.keys()) {
      if (ctx.state === "suspended") void (ctx as AudioContext).resume();
    }
  });
}

function tappedAudioTracks(): MediaStreamTrack[] {
  const tracks: MediaStreamTrack[] = [];
  for (const entry of taps.values()) tracks.push(...entry.tap.stream.getAudioTracks());
  return tracks;
}

// RetroArch draws its notifications INTO the game canvas, so the persistent
// "Slow-Motion." banner from our speed setting would be streamed to the
// guest. EmulatorJS has no public hook for extra retroarch.cfg lines, so
// patch GameManager.getRetroArchCfg (class is exposed on window, in the
// minified build too) before the core boots and reads its config.
function installRetroArchCfgPatch(): void {
  let cls: any;
  Object.defineProperty(window, "EJS_GameManager", {
    configurable: true,
    get: () => cls,
    set: (v: any) => {
      cls = v;
      try {
        const orig = v.prototype.getRetroArchCfg;
        v.prototype.getRetroArchCfg = function () {
          return orig.call(this) + "video_font_enable = false\n";
        };
      } catch (err) {
        console.warn("retroarch cfg patch not applied", err);
      }
    },
  });
}

// Run the cabinet at TUNING.gameSpeed via RetroArch's slow motion. The
// settings menu is disabled, so players can't see or undo it.
function applyGameSpeed(): void {
  if (TUNING.gameSpeed >= 1) return;
  try {
    const em = window.EJS_emulator;
    em.gameManager.setSlowMotionRatio(1 / TUNING.gameSpeed);
    em.gameManager.toggleSlowMotion(1);
    em.isSlowMotion = true; // keep EJS's own toggle bookkeeping in agreement
  } catch (err) {
    console.warn("game speed not applied", err);
  }
}

// --- host runtime ------------------------------------------------------

export interface HostGame {
  stream: MediaStream;
  applyInput(buf: ArrayBuffer): void; // guest input → Player 2
  localInput(id: number, value: 0 | 1): void; // host touch overlay → Player 1
  testMode: boolean;
}

export async function romAvailable(): Promise<boolean> {
  try {
    const res = await fetch(ROM_URL, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

// Boot EmulatorJS with the FBNeo arcade core and wait until the game is
// running, then capture its canvas + tapped audio.
export function startEmulator(container: HTMLElement): Promise<HostGame> {
  return new Promise((resolve, reject) => {
    window.EJS_player = "#" + container.id;
    window.EJS_core = "arcade";
    window.EJS_gameUrl = ROM_URL;
    window.EJS_gameName = "squash";
    window.EJS_pathtodata = EJS_CDN;
    window.EJS_startOnLoaded = true;
    window.EJS_backgroundColor = "#05070d";

    // Trim the menu bar: no save states / recording / speed controls.
    window.EJS_Buttons = {
      playPause: false,
      restart: true,
      mute: true,
      settings: false,
      fullscreen: true,
      gamepad: false,
      saveState: false,
      loadState: false,
      quickSave: false,
      quickLoad: false,
      screenRecord: false,
      screenshot: false,
      cheat: false,
      cacheManager: false,
      saveSavFiles: false,
      loadSavFiles: false,
      exitEmulation: false,
    };

    // Suppress EmulatorJS's own virtual gamepad entirely: the host uses the
    // same custom touch overlay as the guest (see touch.ts) so controls look
    // identical on both phones. An empty settings array falls back to the
    // default layout, so disable via the option AND a CSS kill switch.
    window.EJS_defaultOptions = { "virtual-gamepad": "disabled" };
    const css = document.createElement("style");
    css.textContent = `#${container.id} [class*="irtualGamepad"] { display: none !important; }`;
    document.head.appendChild(css);

    const timeout = setTimeout(() => reject(new Error("emulator did not start (60s)")), 60_000);

    window.EJS_onGameStart = () => {
      // give the core a moment to create its canvas + audio graph
      setTimeout(() => {
        const canvas = container.querySelector("canvas");
        if (!canvas) {
          clearTimeout(timeout);
          reject(new Error("emulator canvas not found"));
          return;
        }
        applyGameSpeed();
        const stream = (canvas as HTMLCanvasElement).captureStream(TUNING.video.captureFps);
        for (const track of tappedAudioTracks()) stream.addTrack(track);
        clearTimeout(timeout);
        resolve({
          stream,
          testMode: false,
          // player index 1 = the cabinet's Player 2 controls
          applyInput: createPadReceiver((id, value) => {
            window.EJS_emulator?.gameManager?.simulateInput?.(1, id, value);
          }),
          localInput(id: number, value: 0 | 1) {
            window.EJS_emulator?.gameManager?.simulateInput?.(0, id, value);
          },
        });
      }, 1200);
    };

    installRetroArchCfgPatch();
    const script = document.createElement("script");
    script.src = EJS_CDN + "loader.js";
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("failed to load EmulatorJS from CDN"));
    };
    document.body.appendChild(script);
  });
}

// No ROM present: stream an animated test pattern instead. Exercises the
// entire WebRTC path and doubles as a connectivity diagnostic.
export function startTestPattern(container: HTMLElement): HostGame {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.objectFit = "contain";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  const state = {
    x: 60,
    y: 60,
    vx: 2.1,
    vy: 1.4,
    lastInput: "none",
    held: new Set<number>(),
  };
  const NAMES: Record<number, string> = {
    0: "FIRE1",
    1: "FIRE2",
    2: "COIN",
    3: "START",
    4: "UP",
    5: "DOWN",
    6: "LEFT",
    7: "RIGHT",
    8: "A",
    9: "X",
  };

  function frame(): void {
    state.x += state.vx;
    state.y += state.vy;
    if (state.x < 8 || state.x > 312) state.vx *= -1;
    if (state.y < 8 || state.y > 232) state.vy *= -1;
    // guest's held direction nudges the square: visible proof inputs arrive
    if (state.held.has(6)) state.x -= 1.5;
    if (state.held.has(7)) state.x += 1.5;
    if (state.held.has(4)) state.y -= 1.5;
    if (state.held.has(5)) state.y += 1.5;

    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, 320, 240);
    ctx.strokeStyle = "#3be8ff";
    ctx.strokeRect(4, 4, 312, 232);
    ctx.fillStyle = "#eaff5e";
    ctx.fillRect(state.x - 6, state.y - 6, 12, 12);
    ctx.fillStyle = "#cfe9ff";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("TEST PATTERN: add squash.zip to public/ and redeploy", 160, 24);
    ctx.fillText(`last guest input: ${state.lastInput}`, 160, 220);
  }
  // setInterval (not rAF) so frames keep flowing even when the tab is
  // backgrounded — rAF stops entirely there and the stream would freeze.
  setInterval(frame, 33);

  const stream = canvas.captureStream(TUNING.video.captureFps);

  const handle = (id: number, value: 0 | 1, from: string) => {
    state.lastInput = `${NAMES[id] ?? id}=${value} (${from})`;
    if (value) state.held.add(id);
    else state.held.delete(id);
  };

  return {
    stream,
    testMode: true,
    applyInput: createPadReceiver((id, value) => {
      handle(id, value, "guest");
      (window as any).__lastGuestInput = `${NAMES[id] ?? id}=${value}`; // e2e hook
    }),
    localInput(id: number, value: 0 | 1) {
      handle(id, value, "host");
    },
  };
}
