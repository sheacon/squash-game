// Signaling/queue test against a running `wrangler dev`: seats, names,
// roster broadcasts, waiting queue, and promotion after the grace period.
// The promotion step waits out the 45s grace, so this test takes ~1 minute.
const BASE = process.argv[2] ?? "ws://127.0.0.1:8787";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

function makeClient(token, name) {
  const ws = new WebSocket(`${BASE}/ws/${code}?token=${token}&name=${encodeURIComponent(name)}`);
  const c = { ws, msgs: [], waiters: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
  };
  c.waitFor = (desc, pred, ms = 8000) => {
    const hit = c.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${desc}`)), ms);
      c.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  };
  c.send = (m) => ws.send(JSON.stringify(m));
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`room ${code} @ ${BASE}`);

  const a = makeClient("tok-a", "Anna");
  const ja = await a.waitFor("A joined", (m) => m.t === "joined");
  if (ja.playerId !== 0) throw new Error("A should be host (slot 0)");

  const b = makeClient("tok-b", "Bob");
  const jb = await b.waitFor("B joined", (m) => m.t === "joined");
  if (jb.playerId !== 1) throw new Error("B should be guest (slot 1)");
  const roster1 = await a.waitFor(
    "roster with both names",
    (m) => m.t === "roster" && m.players[0].name === "ANNA" && m.players[1].name === "BOB" && m.players[1].connected,
  );
  console.log(`✓ seats filled: ${roster1.players.map((p) => p.name).join(" vs ")}`);

  // third joiner queues instead of being rejected
  const c = makeClient("tok-c", "Cara");
  const waitMsg = await c.waitFor("C waiting", (m) => m.t === "waiting");
  if (waitMsg.position !== 1) throw new Error(`C expected position 1, got ${waitMsg.position}`);
  await a.waitFor("roster shows CARA waiting", (m) => m.t === "roster" && m.waiting.includes("CARA"));
  await c.waitFor("C sees the roster too", (m) => m.t === "roster" && m.players[0].name === "ANNA");
  console.log("✓ third joiner queues (position 1), roster broadcast to all");

  // signaling still relays between seats only
  a.send({ t: "signal", data: { kind: "offer", sdp: "fake-offer" } });
  await b.waitFor("offer relayed", (m) => m.t === "signal" && m.data.kind === "offer");
  if (a.msgs.some((m) => m.t === "signal")) throw new Error("signal echoed to sender");
  await sleep(300);
  if (c.msgs.some((m) => m.t === "signal")) throw new Error("waiter received signaling");
  console.log("✓ signaling relays between seats only");

  // guest leaves: waiter is promoted after the grace period
  b.ws.close();
  await a.waitFor("A told peer left", (m) => m.t === "peer" && m.connected === false);
  console.log("waiting out the 45s promotion grace period...");
  await c.waitFor("C promoted", (m) => m.t === "promoted", 60_000);
  const c2 = makeClient("tok-c", "Cara"); // promoted client reconnects
  const jc = await c2.waitFor("C seated", (m) => m.t === "joined");
  if (jc.playerId !== 1) throw new Error(`promoted waiter expected seat 1, got ${jc.playerId}`);
  await a.waitFor(
    "roster shows CARA as P2",
    (m) => m.t === "roster" && m.players[1].name === "CARA" && m.players[1].connected,
  );
  console.log("✓ waiter promoted to Player 2 after grace period, roster updated");

  a.ws.close();
  c.ws.close();
  c2.ws.close();
  console.log("\nRELAY TEST PASS");
  process.exit(0);
} catch (err) {
  console.error(`\nRELAY TEST FAIL: ${err.message}`);
  process.exit(1);
}
