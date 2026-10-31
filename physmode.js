'use strict';
// The two physics modes, on top of the classic game's rooms, rounds, HUD and sounds (index.html):
//  'phys'  – real time: the same buttons, but fighters are ragdolls (physics.js) that sway, fall and get back up.
//  'turns' – planned turns: the fight freezes, each player drags their fighter's hands, feet and head to plan
//            a move, and when both are ready the physics plays it out for under a second. Then the next turn.
// The host (or practice) runs the world; the guest draws snapshots and sends its inputs or its plan.
const TURN = { PLAN: 20 * 60, SIM: 48, MAX: 12 };
let PW = null;            // host/solo: the physics world
let RV = null;            // drawn ragdolls: [fighter][part] = [x, y (up, pixels), angle]
let RT = null;            // guest: latest snapshot to glide toward
let plans = [null, null]; // host: each side's submitted plan for this turn
let myPlan = null;        // the plan being edited on this phone
let drag = null;

// ---------- host / practice ----------
function physStart() {
  PW = PH.newMatchWorld();
  RV = PH.pack(PW);
  plans = [null, null];
  Object.assign(G, { tp: mode === 'turns' ? 'plan' : null, tt: TURN.PLAN, turn: 1, ready: [0, 0] });
}

function physTick(fight) {
  if (mode === 'phys') {
    if (role === 'solo') setHeld(1, fight ? botBits(F[1], F[0]) : 0);
    for (let i = 0; i < 2; i++) {
      PH.controlRealtime(PW.rag[i], fight ? inp[i].held : 0, fight ? inp[i].latch : 0, BIT);
      inp[i].latch = 0;
    }
    stepWorld();
  } else if (G.phase !== 'fight') {
    stepWorld();
  } else if (G.tp === 'plan') {
    if (role === 'solo' && !G.ready[1]) { plans[1] = botPlan(); G.ready[1] = 1; }
    if (--G.tt <= 0 || (G.ready[0] && G.ready[1])) {
      for (let i = 0; i < 2; i++) PH.setPlan(PW.rag[i], plans[i] || { t: PH.currentAngles(PW.rag[i]), lean: 0 });
      G.tp = 'sim'; G.tt = TURN.SIM;
    }
  } else {
    stepWorld();
    if (--G.tt <= 0) {
      if (++G.turn > TURN.MAX) G.timer = 0; // out of turns: the round goes to whoever has more health
      else { G.tp = 'plan'; G.tt = TURN.PLAN; G.ready = [0, 0]; plans = [null, null]; }
    }
  }
  PW.rag.forEach((r, i) => {
    Object.assign(F[i], { hp: r.hp, en: 0, x: PH.centerX(r), y: 0, act: r.ko ? 'ko' : r.act || 'idle' });
  });
  RV = PH.pack(PW);
}

function stepWorld() {
  for (const e of PH.step(PW)) emit({ k: e.k, w: e.w, x: e.x, y: GROUND - e.y * PH.SCALE, big: e.big });
}

function submitPlan(i, p) {
  if (!G || G.tp !== 'plan') return;
  plans[i] = p; G.ready[i] = 1;
}

// Practice opponent for turns: goes for the head, sometimes kicks, walks in when too far.
function botPlan() {
  const mine = RV[1], foe = RV[0], torso = mine[0], face = -1;
  const dist = Math.abs(torso[0] - foe[0][0]);
  const jit = () => (Math.random() - 0.5) * 30;
  const t = {
    ...PH.solveLimb(torso, face, 'arm0', [foe[1][0] + jit(), foe[1][1] + jit()]),
    ...PH.solveLimb(torso, face, 'arm1', [torso[0] - 20, torso[1] + 40 + jit()]),
  };
  if (Math.random() < 0.4) Object.assign(t, PH.solveLimb(torso, face, 'leg0', [foe[0][0] + jit(), foe[0][1] + jit()]));
  return { t, lean: Math.random() * 0.35, move: dist > 175 ? 1 : 0, jump: Math.random() < 0.08 };
}

// ---------- guest ----------
function physSnapshot(d) {
  RT = d.r;
  if (!RV) RV = d.r.map(f => f.map(p => p.slice()));
  if (d.q) Object.assign(G, { tp: d.q[0], tt: d.q[1], turn: d.q[2], ready: d.q[3] });
}

// ---------- planning on this phone ----------
// Handles (pixels, y up): a0/a1 hands, l0/l1 feet, h head. Start where the limbs are now.
function initPlan() {
  const R = RV[me], face = me ? -1 : 1;
  const end = (p, dy, dx = 0) => [p[0] - Math.sin(p[2]) * dy + Math.cos(p[2]) * dx, p[1] + Math.cos(p[2]) * dy + Math.sin(p[2]) * dx];
  myPlan = {
    turn: G.turn, sent: false, move: 0, jump: false,
    h: [R[1][0], R[1][1]], h0: [R[1][0], R[1][1]],
    a0: end(R[3], -15), a1: end(R[5], -15), l0: end(R[7], -24, face * 5), l1: end(R[9], -24, face * 5),
  };
}

function planPayload() {
  const torso = RV[me][0], face = me ? -1 : 1, t = {};
  for (const [k, limb] of [['a0', 'arm0'], ['a1', 'arm1'], ['l0', 'leg0'], ['l1', 'leg1']]) Object.assign(t, PH.solveLimb(torso, face, limb, myPlan[k]));
  const lean = clamp((myPlan.h[0] - myPlan.h0[0]) * face / 70, -0.6, 0.6);
  return { t, lean, move: myPlan.move, jump: myPlan.jump };
}

function planReady() {
  if (!myPlan || myPlan.sent) return;
  myPlan.sent = true;
  const p = planPayload();
  if (role === 'guest') send({ t: 'plan', p }); else submitPlan(0, p);
  updateTurnPad();
}

function planReset() { if (myPlan && !myPlan.sent) { const keep = { move: myPlan.move, jump: myPlan.jump }; initPlan(); Object.assign(myPlan, keep); } }

function planEditable() { return mode === 'turns' && G && G.phase === 'fight' && G.tp === 'plan' && myPlan && !myPlan.sent; }

// Screen ↔ world: the arena is scaled to fit and mirrored on the guest's phone.
function toWorld(e) {
  const r = cv.getBoundingClientRect(), sc = Math.min(cw / W, ch / H);
  let x = (e.clientX - r.left - (cw - W * sc) / 2) / sc;
  const y = (e.clientY - r.top - (ch - H * sc) / 2) / sc;
  if (me === 1) x = W - x;
  return [x, GROUND - y];
}

cv.addEventListener('pointerdown', e => {
  if (!planEditable()) return;
  const [x, y] = toWorld(e);
  let best = null, bd = 55;
  for (const k of ['h', 'a0', 'a1', 'l0', 'l1']) {
    const d = Math.hypot(myPlan[k][0] - x, myPlan[k][1] - y);
    if (d < bd) { bd = d; best = k; }
  }
  if (!best) return;
  drag = { k: best, id: e.pointerId };
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  sfx('pick', 76);
});
cv.addEventListener('pointermove', e => {
  if (!drag || drag.id !== e.pointerId || !planEditable()) return;
  let [x, y] = toWorld(e);
  y = Math.max(0, y);
  if (drag.k === 'h') {
    myPlan.h = [clamp(x, myPlan.h0[0] - 50, myPlan.h0[0] + 50), myPlan.h0[1]];
  } else {
    // keep the handle where the limb can actually reach
    const limb = { a0: 'arm0', a1: 'arm1', l0: 'leg0', l1: 'leg1' }[drag.k], face = me ? -1 : 1, torso = RV[me][0];
    myPlan[drag.k] = PH.limbEnd(torso, face, limb, PH.solveLimb(torso, face, limb, [x, y]));
  }
});
for (const t of ['pointerup', 'pointercancel']) cv.addEventListener(t, e => { if (drag && drag.id === e.pointerId) drag = null; });

// ---------- turn buttons ----------
function updateTurnPad() {
  const show = mode === 'turns' && role && G && G.phase === 'fight' && G.tp === 'plan';
  $('#tpad').hidden = !show;
  if (!show || !myPlan) return;
  document.querySelectorAll('#tpad [data-move]').forEach(b => b.classList.toggle('on', +b.dataset.move === myPlan.move));
  $('#tJump').classList.toggle('on', myPlan.jump);
  $('#tReady').disabled = myPlan.sent;
  $('#tReady').textContent = myPlan.sent ? 'מחכים ליריב…' : '✔ מוכן';
}
document.querySelectorAll('#tpad [data-move]').forEach(b => {
  b.onclick = () => { if (planEditable()) { myPlan.move = +b.dataset.move; updateTurnPad(); } };
});
$('#tJump').onclick = () => { if (planEditable()) { myPlan.jump = !myPlan.jump; updateTurnPad(); } };
$('#tReset').onclick = () => { planReset(); updateTurnPad(); };
$('#tReady').onclick = planReady;

// ---------- drawing ----------
function smoothRagdolls() {
  if (!RT || !RV) return;
  for (let i = 0; i < 2; i++) for (let p = 0; p < RV[i].length; p++) {
    const a = RV[i][p], b = RT[i][p];
    a[0] += (b[0] - a[0]) * 0.5; a[1] += (b[1] - a[1]) * 0.5;
    let da = b[2] - a[2];
    da = Math.atan2(Math.sin(da), Math.cos(da));
    a[2] += da * 0.5;
  }
}

// Part (pixels, y up) → screen point at local offset along the part (dy up the part, dx across).
const at = (p, dy, dx = 0) => [p[0] - Math.sin(p[2]) * dy + Math.cos(p[2]) * dx, GROUND - (p[1] + Math.cos(p[2]) * dy + Math.sin(p[2]) * dx)];

function seg(p, half, width, color) {
  const a = at(p, half), b = at(p, -half);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}

function drawRagdoll(i) {
  const R = RV[i], col = colorOf(i), ch = charOf(i), face = i ? -1 : 1, skin = ch.skin, back = shade(skin, 0.75);
  const [torso, head, ua0, fa0, ua1, fa1, th0, sh0, th1, sh1] = R;
  ctx.lineCap = ctx.lineJoin = 'round';
  // shadow
  ctx.fillStyle = '#0006';
  ctx.beginPath(); ctx.ellipse(torso[0], GROUND + 4, 40, 8, 0, 0, Math.PI * 2); ctx.fill();
  // back leg and arm
  seg(th1, 21, 13, back); seg(sh1, 22, 11, back);
  foot(sh1, face, shade(col, 0.7));
  seg(ua1, 15, 10, back); seg(fa1, 14, 9, back);
  glove(fa1, shade(col, 0.75));
  // torso and shorts
  seg(torso, 25, 26, skin);
  const hipA = at(torso, -25), hipB = at(torso, -10);
  ctx.strokeStyle = col; ctx.lineWidth = 32;
  ctx.beginPath(); ctx.moveTo(hipA[0], hipA[1]); ctx.lineTo(hipB[0], hipB[1]); ctx.stroke();
  // head with the character's look
  ctx.save();
  ctx.translate(head[0], GROUND - head[1]);
  ctx.rotate(-head[2]);
  ctx.scale(face, 1);
  drawHead(ch, col, 0, 0);
  ctx.restore();
  // front leg and arm
  seg(th0, 21, 13, skin); seg(sh0, 22, 11, skin);
  foot(sh0, face, col);
  seg(ua0, 15, 10, skin); seg(fa0, 14, 9, skin);
  glove(fa0, col);
}

function glove(p, col) {
  const g = at(p, -15);
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(g[0], g[1], 12, 0, Math.PI * 2); ctx.fill();
}

function foot(p, face, col) {
  const a = at(p, -24, -face * 4), b = at(p, -24, face * 14);
  ctx.strokeStyle = col; ctx.lineWidth = 9;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}

// My plan: the handles, lines from shoulder/hip to them, and a ghost of where the limbs will go.
function drawPlan(now) {
  if (!planEditable() && !(myPlan && myPlan.sent && G && G.tp === 'plan')) return;
  const torso = RV[me][0], face = me ? -1 : 1, J = PH.jointsFrom(torso), col = colorOf(me);
  const S = p => [p[0], GROUND - p[1]];
  ctx.save();
  ctx.globalAlpha = myPlan.sent ? 0.35 : 1;
  for (const [k, limb, base] of [['a0', 'arm0', 'sh'], ['a1', 'arm1', 'sh'], ['l0', 'leg0', 'hip'], ['l1', 'leg1', 'hip']]) {
    const ang = PH.solveLimb(torso, face, limb, myPlan[k]);
    const mid = PH.limbMid(torso, face, limb, ang);
    ctx.strokeStyle = col; ctx.globalAlpha = myPlan.sent ? 0.2 : 0.45; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(...S(J[base])); ctx.lineTo(...S(mid)); ctx.lineTo(...S(myPlan[k])); ctx.stroke();
  }
  ctx.globalAlpha = myPlan.sent ? 0.35 : 1;
  const pulse = 1 + Math.sin(now / 200) * 0.08;
  for (const k of ['a0', 'a1', 'l0', 'l1', 'h']) {
    const [x, y] = S(myPlan[k]);
    ctx.fillStyle = k === 'h' ? '#ffffff55' : col + '88';
    ctx.strokeStyle = drag && drag.k === k ? '#ffc94a' : '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, (k === 'h' ? 20 : 17) * pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // walking / jumping arrows
  if (myPlan.move || myPlan.jump) {
    const [x, y] = S([torso[0], torso[1] + 120]);
    ctx.fillStyle = '#ffc94a'; ctx.font = "26px 'Rubik', sans-serif"; ctx.textAlign = 'center';
    ctx.save(); ctx.translate(x, y); if (me === 1) ctx.scale(-1, 1);
    ctx.fillText((myPlan.jump ? '⤒' : '') + (myPlan.move > 0 ? '→' : myPlan.move < 0 ? '←' : ''), 0, 0); // my fighter always faces right on my screen
    ctx.restore();
  }
  ctx.restore();
}

// Called from render() for the physics modes.
function renderPhys(now) {
  if (role === 'guest') smoothRagdolls();
  if (!RV) return;
  drawRagdoll(0); drawRagdoll(1);
  if (G && mode === 'turns') {
    if (G.tp === 'plan' && G.phase === 'fight' && (!myPlan || myPlan.turn !== G.turn)) { initPlan(); updateTurnPad(); }
    drawPlan(now);
  }
}

// HUD bits for the physics modes: turn counter, who's ready, and the plan timer in the clock.
function physHud() {
  const info = $('#turnInfo');
  const turns = mode === 'turns' && G && G.turn;
  info.hidden = !turns;
  updateTurnPad();
  if (!turns) return;
  const oppReady = G.ready && G.ready[1 - me];
  info.textContent = G.tp === 'plan'
    ? `תור ${G.turn}/${TURN.MAX}${oppReady ? ' · היריב מוכן ✓' : ''}`
    : `תור ${G.turn}/${TURN.MAX} · ⚔`;
  // first turn of a match: how to plan
  if (G.tp === 'plan' && G.turn === 1 && G.round === 1 && myPlan && !myPlan.sent) info.textContent += ' · גררו את העיגולים ואז ✔ מוכן';
  $('#timer').textContent = G.phase === 'fight' && G.tp === 'plan' ? Math.ceil(G.tt / 60) : '⚔';
}
