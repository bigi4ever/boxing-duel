'use strict';
// The two physics modes, on top of the classic game's rooms, rounds, HUD and sounds (index.html):
//  'phys'  – real time: the same buttons, but fighters are ragdolls (physics.js) that sway, fall and get back up.
//  'turns' – planned moves: the fight freezes, each player drags their fighter's hands, feet and head to plan
//            a move, and when both are ready (or the 20 s timer runs out) the physics plays it out for under a
//            second. Then the next move, until a knockout.
// The host (or practice) runs the world; the guest draws snapshots and sends its inputs or its plan.
const TURN = { PLAN: 20 * 60, SIM: 48 };
let PW = null;            // host/solo: the physics world
let RV = null;            // drawn ragdolls: [fighter][part] = [x, y (up, pixels), angle]
let RT = null;            // guest: latest snapshot to glide toward
let plans = [null, null]; // host: each side's submitted plan for this turn
let myPlan = null;        // the plan being edited on this phone
let drag = null;

// ---------- host / practice ----------
function physStart() {
  // abilities are for the live modes; in the planning mode all fighters are equal
  PW = PH.newMatchWorld({ touch: mode === 'turns', hp: maxHp(), stats: mode === 'turns' ? null : [statsOf(0), statsOf(1)] });
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
      G.turn++; G.tp = 'plan'; G.tt = TURN.PLAN; G.ready = [0, 0]; plans = [null, null];
    }
  }
  PW.rag.forEach((r, i) => {
    Object.assign(F[i], { hp: r.hp, en: 0, x: PH.centerX(r), y: 0, act: r.ko ? 'ko' : r.act || 'idle' });
  });
  RV = PH.pack(PW);
}

function stepWorld() {
  if (G.slow > 0 && G.slow-- % 3) return; // slow motion: the world moves every third tick
  for (const e of PH.step(PW)) {
    if (e.k === 'decap') { G.decap = true; G.slow = 120; } // about 2 s at half speed
    emit({ k: e.k, w: e.w, x: e.x, y: GROUND - e.y * PH.SCALE, big: e.big });
  }
  if (mode === 'phys' && G.phase === 'fight' && PW.tick % 120 === 0) regen(1); // recovery ability: 1 health per 2 s
}

function regen(n) {
  PW.rag.forEach((r, i) => { if (stat(i, 'regen') && !r.ko && r.hp > 0) r.hp = Math.min(maxHp(), r.hp + n * stat(i, 'regen')); });
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
  return { t, lean: Math.random() * 0.35, move: dist > 1.75 * PH.SCALE ? 1 : 0, jump: Math.random() < 0.08 };
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
    a0: end(R[3], -18 * K()), a1: end(R[5], -18 * K()), l0: end(R[7], -24 * K(), face * 5 * K()), l1: end(R[9], -24 * K(), face * 5 * K()),
  };
}

function planPayload() {
  const torso = RV[me][0], face = me ? -1 : 1, t = {};
  for (const [k, limb] of [['a0', 'arm0'], ['a1', 'arm1'], ['l0', 'leg0'], ['l1', 'leg1']]) Object.assign(t, PH.solveLimb(torso, face, limb, myPlan[k]));
  const lean = clamp((myPlan.h[0] - myPlan.h0[0]) * face / (70 * K()), -0.6, 0.6);
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
  const r = cv.getBoundingClientRect(), { sc, ox, oy } = view();
  let x = (e.clientX - r.left - ox) / sc;
  const y = (e.clientY - r.top - oy) / sc;
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
    myPlan.h = [clamp(x, myPlan.h0[0] - 50 * K(), myPlan.h0[0] + 50 * K()), myPlan.h0[1]];
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
  if (tstickId === null) showStickChoice();
  $('#tReady').disabled = myPlan.sent;
  $('#tReady').textContent = myPlan.sent ? 'מחכים ליריב…' : '✔ מוכן';
}

// Movement for the planned move, by joystick like the other modes: sideways = step back / forward, up = jump,
// diagonal = both. Unlike real time the choice stays when the finger lifts (the knob rests on it); dragging back
// to the middle, or a light tap, means stay in place. My fighter always faces right on my own screen.
let tstickId = null;
const TR = 38;
function showStickChoice() {
  const set = myPlan && (myPlan.move || myPlan.jump);
  $('#tknob').style.transform = set ? `translate(${myPlan.move * TR * 0.8}px, ${myPlan.jump ? -TR * 0.8 : 0}px)` : '';
  $('#tstick').classList.toggle('set', !!set);
}
function tstickMove(e) {
  const r = $('#tstick').getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy), k = d > TR ? TR / d : 1;
  $('#tknob').style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  if (!planEditable()) return;
  const out = d > TR * 0.3;
  myPlan.move = out && dx > TR * 0.25 ? 1 : out && dx < -TR * 0.25 ? -1 : 0;
  myPlan.jump = out && -dy > Math.abs(dx) * 0.47;
}
$('#tstick').addEventListener('pointerdown', e => {
  e.preventDefault();
  if (tstickId !== null || !planEditable()) return;
  tstickId = e.pointerId; $('#tstick').classList.add('on');
  try { $('#tstick').setPointerCapture(tstickId); } catch (_) {}
  tstickMove(e);
});
$('#tstick').addEventListener('pointermove', e => { if (e.pointerId === tstickId) tstickMove(e); });
for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#tstick').addEventListener(t, e => {
  if (e.pointerId !== tstickId) return;
  tstickId = null; $('#tstick').classList.remove('on');
  showStickChoice();
});
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

// Part sizes below are in centimeters; K() turns them into pixels at the world's scale.
const K = () => PH.SCALE / 100;

function seg(p, half, width, color) {
  const a = at(p, half * K()), b = at(p, -half * K());
  ctx.strokeStyle = color; ctx.lineWidth = width * K();
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}

function drawRagdoll(i) {
  const R = RV[i], col = colorOf(i), ch = charOf(i), face = i ? -1 : 1, skin = ch.skin, back = shade(skin, 0.75);
  const [torso, head, ua0, fa0, ua1, fa1, th0, sh0, th1, sh1] = R;
  ctx.lineCap = ctx.lineJoin = 'round';
  // shadow
  ctx.fillStyle = '#0006';
  ctx.beginPath(); ctx.ellipse(torso[0], GROUND + 4, 40 * K(), 8, 0, 0, Math.PI * 2); ctx.fill();
  // back leg and arm
  seg(th1, 21, 13, back); seg(sh1, 22, 11, back);
  foot(sh1, face, shade(col, 0.7));
  seg(ua1, 18, 10, back); seg(fa1, 17, 9, back);
  glove(fa1, shade(col, 0.75));
  // torso and shorts
  seg(torso, 25, 26, skin);
  const hipA = at(torso, -25 * K()), hipB = at(torso, -10 * K());
  ctx.strokeStyle = col; ctx.lineWidth = 32 * K();
  ctx.beginPath(); ctx.moveTo(hipA[0], hipA[1]); ctx.lineTo(hipB[0], hipB[1]); ctx.stroke();
  // head with the character's look
  ctx.save();
  ctx.translate(head[0], GROUND - head[1]);
  ctx.rotate(-head[2]);
  ctx.scale(face * K(), K());
  drawHead(ch, col, 0, 0);
  ctx.restore();
  // front leg and arm
  seg(th0, 21, 13, skin); seg(sh0, 22, 11, skin);
  foot(sh0, face, col);
  seg(ua0, 18, 10, skin); seg(fa0, 17, 9, skin);
  glove(fa0, col);
}

function glove(p, col) {
  const g = at(p, -18 * K());
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(g[0], g[1], 12 * K(), 0, Math.PI * 2); ctx.fill();
}

function foot(p, face, col) {
  const a = at(p, -24 * K(), -face * 4 * K()), b = at(p, -24 * K(), face * 14 * K());
  ctx.strokeStyle = col; ctx.lineWidth = 9 * K();
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
    ctx.fillText((myPlan.jump ? '↑' : '') + (myPlan.move > 0 ? '→' : myPlan.move < 0 ? '←' : ''), 0, 0); // my fighter always faces right on my screen
    ctx.restore();
  }
  ctx.restore();
}

// Called from render() for the physics modes.
// ---------- blood when a head comes off ----------
// Drops spray from the neck for about a second, fall, and leave stains on the mat until the next round.
// Plain drawing on both phones (not physics), started by the 'decap' event.
const blood = { from: [], drops: [], stains: [], round: 0 };
let lastPhysFrame = 0;

function startBlood(w) { blood.from.push({ w, until: performance.now() + 1100, head: performance.now() + 500 }); }

function drawBlood(now) {
  const dt = Math.min(0.05, (now - (lastPhysFrame || now)) / 1000);
  lastPhysFrame = now;
  if (G && G.round !== blood.round) { blood.round = G.round; blood.from = []; blood.drops = []; blood.stains = []; }
  for (const s of blood.from) {
    if (now > s.until) continue;
    const torso = RV[s.w][0], head = RV[s.w][1];
    const neck = at(torso, 27 * K());
    const up = [-Math.sin(torso[2]), -Math.cos(torso[2])]; // up along the torso, on screen
    const strength = (s.until - now) / 1100;
    for (let n = 0; n < 5; n++) {
      const sp = (380 + Math.random() * 380) * (0.5 + strength * 0.7);
      blood.drops.push({ x: neck[0], y: neck[1], vx: up[0] * sp + (Math.random() - 0.5) * 220, vy: up[1] * sp + (Math.random() - 0.5) * 120, r: 2.5 + Math.random() * 3.5 });
    }
    if (now < s.head) { // a few from the head too
      const h = at(head, -14 * K());
      blood.drops.push({ x: h[0], y: h[1], vx: (Math.random() - 0.5) * 160, vy: Math.random() * 80, r: 2 + Math.random() * 2.5 });
    }
  }
  blood.from = blood.from.filter(s => now <= s.until);
  ctx.fillStyle = '#b3121f';
  for (const st of blood.stains) {
    ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.ellipse(st.x, GROUND + 2, st.r * 2.2, st.r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  blood.drops = blood.drops.filter(d => {
    d.vy += 1700 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
    if (d.y >= GROUND) { if (blood.stains.length < 140) blood.stains.push({ x: d.x, r: d.r }); return false; }
    ctx.fillStyle = '#d0182a';
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    return d.x > -50 && d.x < W + 50;
  });
}

function renderPhys(now) {
  if (role === 'guest') smoothRagdolls();
  if (!RV) return;
  drawRagdoll(0); drawRagdoll(1);
  drawBlood(now);
  if (G && mode === 'turns') {
    if (G.tp === 'plan' && G.phase === 'fight' && (!myPlan || myPlan.turn !== G.turn)) { initPlan(); updateTurnPad(); }
    drawPlan(now);
  }
}

// HUD bits for the planning mode: who's ready, and the plan timer in the clock.
function physHud() {
  const info = $('#turnInfo');
  updateTurnPad();
  const on = mode === 'turns' && G && G.turn && G.phase === 'fight';
  const parts = [];
  if (on && G.tp === 'plan') {
    if (G.ready && G.ready[1 - me]) parts.push('היריב מוכן ✓');
    if (myPlan && !myPlan.sent && G.turn === 1 && G.round === 1) parts.push('גררו את העיגולים ואז ✔ מוכן');
  }
  const text = parts.join(' · ');
  info.textContent = text; info.hidden = !text;
  if (mode === 'turns' && G) $('#timer').textContent = G.phase === 'fight' && G.tp === 'plan' ? Math.ceil(G.tt / 60) : '⚔';
}
