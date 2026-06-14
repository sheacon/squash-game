// tests/sim.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

// src/shared/constants.ts
var COURT_W = 6.4;
var COURT_L = 9.75;
var TIN_HEIGHT = 0.48;
var CEILING = 6;
var BALL_R = 0.12;
var TICK_RATE = 30;
var DT = 1 / TICK_RATE;
var BALL_SUBSTEPS = 2;
var GRAVITY = -18;
var REST_FLOOR = 0.76;
var REST_WALL = 0.85;
var AIR_DRAG = 0.15;
var PLAYER_SPEED = 6.5;
var PLAYER_MIN_X = 0.35;
var PLAYER_MAX_X = COURT_W - 0.35;
var PLAYER_MIN_Y = 0.8;
var PLAYER_MAX_Y = 8.8;
var REACH = 1;
var REACH_Z = 2.3;
var SOFT_SPEED = 9.5;
var HARD_SPEED = 17;
var SOFT_TARGET_Z = 0.75;
var HARD_TARGET_Z = 1;
var SCRAPE_Z = 0.35;
var SCRAPE_PENALTY = 2.5;
var MAX_LOFT = 8;
var STEER = 2.2;
var MAX_STEER_VX = 7;
var SWING_COOLDOWN = 0.25;
var WIN_SCORE = 11;
var POINT_PAUSE = 1.6;

// src/shared/sim.ts
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function createInitialState() {
  return {
    tick: 0,
    phase: "lobby",
    ball: { x: COURT_W / 2, y: 6, z: 1, vx: 0, vy: 0, vz: 0 },
    players: [
      { x: COURT_W * 0.3, y: 3, tx: COURT_W * 0.3, ty: 3 },
      { x: COURT_W * 0.7, y: 3, tx: COURT_W * 0.7, ty: 3 }
    ],
    turn: 0,
    servingPlayer: 0,
    score: [0, 0],
    floorBounces: 0,
    touchedFront: true,
    lastHitter: 0,
    cooldowns: [0, 0],
    pointTimer: 0,
    rallyWinner: null
  };
}
function setTarget(p, tx, ty) {
  p.tx = clamp(tx, PLAYER_MIN_X, PLAYER_MAX_X);
  p.ty = clamp(ty, PLAYER_MIN_Y, PLAYER_MAX_Y);
}
function applyInput(s, pid, tx, ty) {
  setTarget(s.players[pid], tx, ty);
}
function stepPlayer(p, dt) {
  const dx = p.tx - p.x;
  const dy = p.ty - p.y;
  const d = Math.hypot(dx, dy);
  const maxStep = PLAYER_SPEED * dt;
  if (d <= maxStep) {
    p.x = p.tx;
    p.y = p.ty;
  } else {
    p.x += dx / d * maxStep;
    p.y += dy / d * maxStep;
  }
}
function startServe(s) {
  s.phase = "serve";
  s.turn = s.servingPlayer;
  s.floorBounces = 0;
  s.touchedFront = true;
  s.rallyWinner = null;
  const leftBox = (s.score[0] + s.score[1]) % 2 === 0;
  const sp = s.players[s.servingPlayer];
  sp.x = sp.tx = leftBox ? COURT_W * 0.25 : COURT_W * 0.75;
  sp.y = sp.ty = 4.6;
  const rp = s.players[1 - s.servingPlayer];
  rp.x = rp.tx = leftBox ? COURT_W * 0.75 : COURT_W * 0.25;
  rp.y = rp.ty = 2.6;
  holdBall(s);
}
function holdBall(s) {
  const sp = s.players[s.servingPlayer];
  s.ball.x = sp.x;
  s.ball.y = sp.y;
  s.ball.z = 1.1;
  s.ball.vx = 0;
  s.ball.vy = 0;
  s.ball.vz = 0;
}
function tryHit(s, pid, kind, history) {
  if (s.cooldowns[pid] > 0) return null;
  const p = s.players[pid];
  if (s.phase === "serve") {
    if (pid !== s.servingPlayer) return null;
  } else if (s.phase === "rally") {
    if (pid !== s.turn) return null;
    const inReach = (b2) => Math.hypot(b2.x - p.x, b2.y - p.y) <= REACH && b2.z <= REACH_Z;
    let ok = inReach(s.ball);
    if (!ok && history) ok = history.some(inReach);
    if (!ok) {
      s.cooldowns[pid] = SWING_COOLDOWN;
      return null;
    }
  } else {
    return null;
  }
  const wasServe = s.phase === "serve";
  const b = s.ball;
  if (wasServe) {
    b.x = p.x;
    b.y = p.y;
    b.z = 1.1;
  }
  const speed = kind === "hard" ? HARD_SPEED : SOFT_SPEED;
  const targetZ = (kind === "hard" ? HARD_TARGET_Z : SOFT_TARGET_Z) - Math.max(0, SCRAPE_Z - b.z) * SCRAPE_PENALTY;
  const flight = Math.max(0.5, COURT_L - b.y) / speed;
  b.vy = speed;
  b.vz = clamp((targetZ - b.z) / flight + 0.5 * -GRAVITY * flight, -MAX_LOFT, MAX_LOFT);
  b.vx = wasServe ? (COURT_W / 2 - p.x) * 0.5 : clamp(STEER * (b.x - p.x), -MAX_STEER_VX, MAX_STEER_VX);
  s.lastHitter = pid;
  s.turn = 1 - pid;
  s.floorBounces = 0;
  s.touchedFront = false;
  s.cooldowns[pid] = SWING_COOLDOWN;
  s.phase = "rally";
  return wasServe ? { kind: "serve", player: pid, hit: kind } : { kind: "hit", player: pid, hit: kind };
}
function endRally(s, winner, reason, ev) {
  s.score[winner]++;
  s.phase = "point";
  s.pointTimer = POINT_PAUSE;
  s.rallyWinner = winner;
  s.servingPlayer = winner;
  ev.push({ kind: "point", winner, reason, score: [s.score[0], s.score[1]] });
}
function stepBall(s, h, ev, rules) {
  const b = s.ball;
  b.vz += GRAVITY * h;
  const drag = Math.max(0, 1 - AIR_DRAG * h);
  b.vx *= drag;
  b.vy *= drag;
  b.vz *= drag;
  b.x += b.vx * h;
  b.y += b.vy * h;
  b.z += b.vz * h;
  if (b.x < BALL_R) {
    b.x = BALL_R;
    b.vx = Math.abs(b.vx) * REST_WALL;
    ev.push({ kind: "wall" });
  } else if (b.x > COURT_W - BALL_R) {
    b.x = COURT_W - BALL_R;
    b.vx = -Math.abs(b.vx) * REST_WALL;
    ev.push({ kind: "wall" });
  }
  if (b.y > COURT_L - BALL_R) {
    const isTin = b.z < TIN_HEIGHT;
    b.y = COURT_L - BALL_R;
    b.vy = -Math.abs(b.vy) * REST_WALL;
    if (rules && s.phase === "rally") {
      if (isTin) {
        ev.push({ kind: "tin" });
        endRally(s, 1 - s.lastHitter, "tin", ev);
      } else {
        s.touchedFront = true;
        ev.push({ kind: "front" });
      }
    } else {
      ev.push({ kind: "front" });
    }
  }
  if (b.y < BALL_R) {
    b.y = BALL_R;
    b.vy = Math.abs(b.vy) * REST_WALL;
    ev.push({ kind: "wall" });
  }
  if (b.z > CEILING) {
    b.z = CEILING;
    b.vz = -Math.abs(b.vz) * REST_WALL;
  }
  if (b.z < BALL_R) {
    b.z = BALL_R;
    b.vz = Math.abs(b.vz) * REST_FLOOR;
    ev.push({ kind: "floor" });
    if (rules && s.phase === "rally") {
      if (!s.touchedFront) {
        endRally(s, 1 - s.lastHitter, "down", ev);
      } else {
        s.floorBounces++;
        if (s.floorBounces >= 2) {
          endRally(s, s.lastHitter, "double-bounce", ev);
        }
      }
    }
  }
}
function step(s, dt) {
  const ev = [];
  s.tick++;
  s.cooldowns[0] = Math.max(0, s.cooldowns[0] - dt);
  s.cooldowns[1] = Math.max(0, s.cooldowns[1] - dt);
  stepPlayer(s.players[0], dt);
  stepPlayer(s.players[1], dt);
  if (s.phase === "serve") {
    holdBall(s);
  } else if (s.phase === "rally") {
    const h = dt / BALL_SUBSTEPS;
    for (let i = 0; i < BALL_SUBSTEPS && s.phase === "rally"; i++) {
      stepBall(s, h, ev, true);
    }
  } else if (s.phase === "point") {
    const h = dt / BALL_SUBSTEPS;
    for (let i = 0; i < BALL_SUBSTEPS; i++) stepBall(s, h, [], false);
    s.pointTimer -= dt;
    if (s.pointTimer <= 0) {
      const [a, b] = s.score;
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      if (hi >= WIN_SCORE && hi - lo >= 2) {
        s.phase = "gameover";
        ev.push({ kind: "gameover", winner: a > b ? 0 : 1, score: [a, b] });
      } else {
        startServe(s);
      }
    }
  }
  return ev;
}

// tests/sim.test.ts
function runTicks(s, n) {
  const all = [];
  for (let i = 0; i < n; i++) all.push(...step(s, DT));
  return all;
}
function runUntilPoint(s, maxTicks = 30 * 30) {
  for (let i = 0; i < maxTicks; i++) {
    const evs = step(s, DT);
    const p = evs.find((e) => e.kind === "point");
    if (p) return p;
  }
  return null;
}
function serveState() {
  const s = createInitialState();
  startServe(s);
  return s;
}
test("serve launches a rally", () => {
  const s = serveState();
  assert.equal(s.phase, "serve");
  const ev = tryHit(s, 0, "hard");
  assert.ok(ev && ev.kind === "serve");
  assert.equal(s.phase, "rally");
  assert.equal(s.turn, 1);
});
test("receiver cannot serve", () => {
  const s = serveState();
  assert.equal(tryHit(s, 1, "hard"), null);
  assert.equal(s.phase, "serve");
});
test("turn enforcement: server cannot hit twice in a row", () => {
  const s = serveState();
  tryHit(s, 0, "hard");
  runTicks(s, 2);
  assert.equal(tryHit(s, 0, "hard"), null);
});
test("hard serve reaches the front wall then double bounce wins the rally for the hitter", () => {
  const s = serveState();
  tryHit(s, 0, "hard");
  const ev = runUntilPoint(s);
  assert.ok(ev && ev.kind === "point");
  assert.equal(ev.reason, "double-bounce");
  assert.equal(ev.winner, 0);
  assert.deepEqual(s.score, [1, 0]);
  assert.equal(s.servingPlayer, 0);
});
test("hard hit from deep court clears the tin (aimed loft)", () => {
  const s = serveState();
  const p0 = s.players[0];
  p0.x = p0.tx = 1;
  p0.y = p0.ty = 1;
  const ev = tryHit(s, 0, "hard");
  assert.ok(ev);
  const evs = runTicks(s, 30);
  assert.ok(evs.some((e) => e.kind === "front"), "ball reached the front wall");
  assert.ok(!evs.some((e) => e.kind === "tin"), "ball must clear the tin");
});
test("ball that lands before the front wall loses the rally for the hitter", () => {
  const s = serveState();
  tryHit(s, 0, "soft");
  s.ball.vy = 1.5;
  s.ball.vz = 0.5;
  const ev = runUntilPoint(s);
  assert.ok(ev && ev.kind === "point");
  assert.equal(ev.reason, "down");
  assert.equal(ev.winner, 1);
});
test("tin: low fast ball into the front wall loses the rally", () => {
  const s = serveState();
  tryHit(s, 0, "hard");
  s.ball.y = 8;
  s.ball.z = 0.3;
  s.ball.vz = 0;
  s.ball.vy = 30;
  const evs = runTicks(s, 10);
  const tin = evs.find((e) => e.kind === "tin");
  const point = evs.find((e) => e.kind === "point");
  assert.ok(tin, "expected a tin event");
  assert.ok(point && point.kind === "point" && point.winner === 1);
});
test("opponent in reach can return the ball and the rally continues", () => {
  const s = serveState();
  tryHit(s, 0, "hard");
  runTicks(s, 3);
  const p1 = s.players[1];
  p1.x = p1.tx = s.ball.x;
  p1.y = p1.ty = s.ball.y;
  s.cooldowns[1] = 0;
  if (s.ball.z > 2.2) s.ball.z = 1;
  const ev = tryHit(s, 1, "soft");
  assert.ok(ev && ev.kind === "hit");
  assert.equal(s.turn, 0);
  assert.equal(s.lastHitter, 1);
});
test("out-of-reach swing whiffs and sets cooldown", () => {
  const s = serveState();
  tryHit(s, 0, "hard");
  const p1 = s.players[1];
  p1.x = p1.tx = 0.5;
  p1.y = p1.ty = 0.9;
  s.cooldowns[1] = 0;
  s.ball.x = 5.5;
  s.ball.y = 8;
  assert.equal(tryHit(s, 1, "soft"), null);
  assert.ok(s.cooldowns[1] > 0);
});
test("rewind history forgives latency", () => {
  const s = serveState();
  tryHit(s, 0, "hard");
  const p1 = s.players[1];
  p1.x = p1.tx = 3;
  p1.y = p1.ty = 5;
  s.cooldowns[1] = 0;
  s.ball.x = 6.2;
  s.ball.y = 9;
  s.ball.z = 3.5;
  const history = [{ x: 3 + REACH * 0.9, y: 5, z: 1 }];
  const ev = tryHit(s, 1, "soft", history);
  assert.ok(ev && ev.kind === "hit");
});
test("movement input is clamped to the court", () => {
  const s = createInitialState();
  applyInput(s, 0, -50, 999);
  assert.ok(s.players[0].tx >= 0);
  assert.ok(s.players[0].ty <= 9.75);
});
test("rally scoring to 11 with win by 2 ends the game", () => {
  const s = serveState();
  let guard = 0;
  while (s.phase !== "gameover" && guard++ < 100) {
    if (s.phase === "serve") {
      tryHit(s, s.servingPlayer, "hard");
    }
    runTicks(s, 60);
  }
  assert.equal(s.phase, "gameover");
  assert.equal(Math.max(s.score[0], s.score[1]), WIN_SCORE);
  const evsAfter = runTicks(s, 5);
  assert.equal(evsAfter.length, 0, "gameover state is inert");
});
