// Full pipeline test in headless Chrome via CDP: host page boots the test
// pattern (no ROM needed), guest page receives WebRTC video, guest keyboard
// input arrives at the host. Requires `wrangler dev` running.
//
// Usage: node scripts/e2e-test.mjs [http://127.0.0.1:8787]
import { spawn } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const PORT = 9230;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const room = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
const URL_ROOM = `${BASE}/?testpattern=1#${room}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--user-data-dir=/tmp/chrome-e2e-${Math.random().toString(36).slice(2, 8)}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function newPage(url) {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
        method: "PUT",
      });
      target = await res.json();
    } catch {
      await sleep(300);
    }
  }
  if (!target) throw new Error("chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (desc, expression, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch {}
      await sleep(250);
    }
    throw new Error(`timeout: ${desc}`);
  };
  return { send, evaluate, waitFor };
}

try {
  console.log(`room ${room} @ ${BASE}`);

  // tabs share the profile's localStorage, so only the first tab is asked
  const enterName = async (page, name) => {
    await page.waitFor("app ready", `!!document.getElementById('overlay-card')`);
    const needsName = await page.evaluate(`!localStorage.getItem('squash-name')`);
    if (!needsName) return;
    await page.waitFor("name input", `!!document.getElementById('name-input')`);
    await page.evaluate(
      `(() => { const i = document.getElementById('name-input'); i.value = '${name}';
        i.dispatchEvent(new Event('input')); document.getElementById('name-btn').click(); return true; })()`,
    );
  };

  const host = await newPage(URL_ROOM);
  await enterName(host, "HOSTBOT");
  await host.waitFor("host boot button", `!!document.getElementById('boot-btn')`);
  await host.evaluate(`document.getElementById('boot-btn').click(); true`);
  await host.waitFor("host ready", `window.__hostReady === true`);
  console.log("✓ host booted test pattern");

  const guest = await newPage(URL_ROOM);
  await enterName(guest, "GUESTBOT");
  await guest.waitFor("guest got stream (play button)", `!!document.getElementById('play-btn')`, 20000);
  console.log("✓ WebRTC offer/answer completed, guest received track");
  await guest.evaluate(`document.getElementById('play-btn').click(); true`);
  await guest.waitFor("guest playing", `window.__guestPlaying === true`);

  const dims = await guest.waitFor(
    "video frames decoding",
    `(() => { const v = document.getElementById('remote');
       return v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null; })()`,
    20000,
  );
  console.log(`✓ guest video playing at ${dims.w}x${dims.h}`);
  const t1 = await guest.evaluate(`document.getElementById('remote').currentTime`);
  await sleep(1200);
  const t2 = await guest.evaluate(`document.getElementById('remote').currentTime`);
  if (!(t2 > t1)) throw new Error(`video not advancing (${t1} → ${t2})`);
  console.log(`✓ video advancing (${t1.toFixed(2)}s → ${t2.toFixed(2)}s)`);

  // the sender is capped at TUNING.video.maxBitrate (450 kbps); 600 leaves
  // headroom for keyframe spikes inside one stats window
  const net = await guest.waitFor(
    "guest stream stats",
    `window.__netStats && window.__netStats.kbps > 0 ? window.__netStats : null`,
    20000,
  );
  if (net.kbps >= 600) throw new Error(`stream at ${Math.round(net.kbps)} kbps, bitrate cap not applied`);
  console.log(
    `✓ stream within cap: ${Math.round(net.kbps)} kbps, ${net.fps || "?"} fps, ${net.codec || "default codec"}`,
  );

  await guest.waitFor(
    "data channel open",
    `document.getElementById('rtc').textContent === 'controls live' || document.getElementById('rtc').textContent === 'connected'`,
  );
  await guest.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'z'})); true`,
  );
  await sleep(300);
  await guest.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', {key: 'z'})); true`);
  const got = await host.waitFor("host received guest input", `window.__lastGuestInput || null`);
  console.log(`✓ guest input arrived at host: ${got}`);
  // the release must land too: exercises the pad-snapshot diff path end to end
  await host.waitFor(
    "guest release applied",
    `window.__lastGuestInput === 'FIRE1=0' ? window.__lastGuestInput : null`,
  );
  console.log("✓ guest release applied via pad snapshot");

  console.log("\nE2E TEST PASS");
  process.exit(0);
} catch (err) {
  console.error(`\nE2E TEST FAIL: ${err.message}`);
  process.exit(1);
} finally {
  chrome.kill();
}
