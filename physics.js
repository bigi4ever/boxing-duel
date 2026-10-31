'use strict';
// Physics fighters for the "physics" modes: each fighter is a ragdoll of 10 bodies joined by 9 motorized joints
// (planck.js). Muscles are joint motors driven toward target angles; a balance assist keeps a fighter upright
// unless it is stunned or knocked out. Damage comes from how hard body parts collide.
// Only the phone that runs the simulation (host / practice) loads this file's world; the other phone draws snapshots.
//
// Angles are in the fighter's own frame: 0 = limb hanging straight down, positive = swung forward (toward the
// opponent). For the fighter facing left, physical angles are mirrored (face = -1).
const PH = (() => {
  const pl = typeof planck !== 'undefined' ? planck : typeof require === 'function' ? require('planck') : null;
  if (!pl) return null; // library didn't load (offline): only the classic mode is offered
  const V = (x, y) => pl.Vec2(x, y);
  const SCALE = 120;           // world pixels per meter (the arena is 1000 px wide: 8.3 m)
  const RING = 1000 / SCALE;
  const GRAV = -16;
  const PARTS = ['torso', 'head', 'uarm0', 'farm0', 'uarm1', 'farm1', 'thigh0', 'shin0', 'thigh1', 'shin1'];
  // joint: [parent, child, anchor y, lower, upper, max torque]
  const JOINTS = {
    neck: ['torso', 'head', 1.47, -0.5, 0.5, 60],
    sh0:  ['torso', 'uarm0', 1.43, -1.2, 3.0, 120],
    el0:  ['uarm0', 'farm0', 1.07, 0, 2.6, 90],
    sh1:  ['torso', 'uarm1', 1.43, -1.2, 3.0, 120],
    el1:  ['uarm1', 'farm1', 1.07, 0, 2.6, 90],
    hip0: ['torso', 'thigh0', 0.95, -0.9, 1.9, 320],
    kn0:  ['thigh0', 'shin0', 0.52, -2.5, 0, 260],
    hip1: ['torso', 'thigh1', 0.95, -0.9, 1.9, 320],
    kn1:  ['thigh1', 'shin1', 0.52, -2.5, 0, 260],
  };
  const JN = Object.keys(JOINTS);
  // Damage per m/s of impact speed above the threshold, by the part that gets hit. Arms barely count: that's blocking.
  const TAKES = { head: 1.7, torso: 1, thigh0: 0.45, thigh1: 0.45, shin0: 0.3, shin1: 0.3, uarm0: 0.15, uarm1: 0.15, farm0: 0.1, farm1: 0.1 };
  const STRIKERS = new Set(['farm0', 'farm1', 'shin0', 'shin1', 'uarm0', 'uarm1', 'thigh0', 'thigh1', 'head']);

  const POSES = {
    guard: { neck: 0, sh0: 0.55, el0: 2.2, sh1: 0.25, el1: 2.4, hip0: 0.25, kn0: -0.25, hip1: -0.25, kn1: -0.15 },
    punch: { sh0: 1.55, el0: 0.05 },
    punch2: { sh1: 1.55, el1: 0.05, sh0: 0.3, el0: 2.3 },
    kick: { hip0: 1.55, kn0: -0.1, hip1: -0.15, kn1: -0.15, sh0: 0.2, el0: 2.2, sh1: -0.4, el1: 1.6 },
    block: { sh0: 1.15, el0: 2.45, sh1: 1.0, el1: 2.5 },
    tuck: { hip0: 0.9, kn0: -1.4, hip1: 0.5, kn1: -1.2 },
  };

  function box(body, hw, hh, cx, cy, opts) {
    return body.createFixture(pl.Box(hw, hh, V(cx, cy), 0), opts);
  }

  function makeWorld() {
    const world = new pl.World({ gravity: V(0, GRAV) });
    const ground = world.createBody();
    ground.createFixture(pl.Edge(V(-5, 0), V(15, 0)), { friction: 1 });
    ground.createFixture(pl.Edge(V(0.25, 0), V(0.25, 6)), { friction: 0.2 });
    ground.createFixture(pl.Edge(V(RING - 0.25, 0), V(RING - 0.25, 6)), { friction: 0.2 });
    const W = { world, rag: [], hits: [], press: [], tick: 0, touch: false };
    world.on('begin-contact', c => onContact(W, c));
    world.on('post-solve', (c, imp) => { if (W.touch) onPress(W, c, imp); });
    return W;
  }

  function buildRagdoll(W, i, x, face) {
    const { world } = W;
    const group = -(i + 1); // a fighter's own parts never collide with each other
    const B = {};
    const mk = (name, px, py) => {
      const b = world.createBody({ type: 'dynamic', position: V(px, py), angularDamping: 0.6, linearDamping: 0.05 });
      b.setUserData({ f: i, part: name });
      B[name] = b; return b;
    };
    // Legs (category 4) don't meet the other fighter's legs, so feet don't tangle when close; kicks still
    // land on body, head and arms (category 1), and everything stands on the ground (category 1).
    const leg = /^(thigh|shin)/.test.bind(/^(thigh|shin)/);
    const fx = (part, extra = {}) => Object.assign({ density: 6, friction: 0.4, filterGroupIndex: group,
      filterCategoryBits: leg(part) ? 4 : 1, filterMaskBits: leg(part) ? 1 : 5, userData: { f: i, part } }, extra);
    box(mk('torso', x, 1.2), 0.13, 0.27, 0, 0, fx('torso', { density: 8 }));
    mk('head', x, 1.64).createFixture(pl.Circle(0.16), fx('head', { density: 4 }));
    for (const a of ['0', '1']) {
      box(mk('uarm' + a, x, 1.25), 0.045, 0.18, 0, 0, fx('uarm' + a));
      const f = mk('farm' + a, x, 0.90);
      box(f, 0.04, 0.17, 0, 0, fx('farm' + a));
      f.createFixture(pl.Circle(V(0, -0.18), 0.07), fx('farm' + a, { density: 3 }));
      box(mk('thigh' + a, x, 0.735), 0.065, 0.215, 0, 0, fx('thigh' + a));
      const s = mk('shin' + a, x, 0.295);
      box(s, 0.05, 0.225, 0, 0, fx('shin' + a));
      box(s, 0.1, 0.035, face * 0.05, -0.24, fx('shin' + a, { friction: 1.2 }));
    }
    const J = {};
    for (const n of JN) {
      const [pa, ch, ay, lo, hi, torque] = JOINTS[n];
      const [l, u] = face > 0 ? [lo, hi] : [-hi, -lo];
      J[n] = world.createJoint(pl.RevoluteJoint({
        enableLimit: true, lowerAngle: l, upperAngle: u, enableMotor: true, maxMotorTorque: torque, motorSpeed: 0,
      }, B[pa], B[ch], V(x, ay)));
    }
    const r = { i, face, B, J, target: { ...POSES.guard }, lean: 0, speed: 14, stun: 0, ko: false, hp: 200, armed: false,
      st: { punch: 1, kick: 1, def: 1, speed: 1, jump: 1, quick: 1 }, // the character's ability (index.html CHARS)
      walk: 0, act: null, actT: 0, cool: {}, moveDir: 0, blocking: false };
    W.rag[i] = r;
    return r;
  }

  // touch: the planning mode's rules — every touch on body or head hurts, and sustained pressure on the head
  // can knock it clean off.
  function newMatchWorld(opts = {}) {
    const W = makeWorld();
    W.touch = !!opts.touch;
    buildRagdoll(W, 0, RING / 2 - 1.4, 1);
    buildRagdoll(W, 1, RING / 2 + 1.4, -1);
    if (opts.hp) for (const r of W.rag) r.hp = opts.hp;
    if (opts.stats) W.rag.forEach((r, i) => Object.assign(r.st, opts.stats[i]));
    return W;
  }

  // ---- muscles & balance ----
  function angleOf(r, n) { return r.J[n] ? r.face * r.J[n].getJointAngle() : 0; }

  function drive(r) {
    const limp = r.ko ? 0.01 : r.stun > 0 ? 0.15 : 1;
    for (const n of JN) {
      const j = r.J[n];
      if (!j) continue; // neck gone
      j.setMaxMotorTorque(JOINTS[n][5] * limp);
      const t = r.target[n] ?? 0;
      const err = t - angleOf(r, n);
      const sp = r.speed * (r.st.quick < 1 ? 1.25 : 1);
      j.setMotorSpeed(r.face * Math.max(-sp, Math.min(sp, err * 12)));
    }
  }

  function totalMass(r) { return PARTS.reduce((m, p) => m + r.B[p].getMass(), 0); }

  function balance(r) {
    if (r.ko || r.stun > 0) return;
    const t = r.B.torso, m = totalMass(r);
    const ang = t.getAngle() * r.face; // forward lean is negative angle for face +1 (CW), so mirror
    const err = -r.lean - ang;
    t.applyTorque((err * 900 - t.getAngularVelocity() * r.face * 60) * r.face * m / 10, true);
    // help back up after a knockdown, and carry some weight so standing is steady
    const lowest = Math.min(r.B.shin0.getPosition().y, r.B.shin1.getPosition().y);
    const y = t.getPosition().y;
    if (lowest < 0.45 && y < 1.15) t.applyForceToCenter(V(0, m * -GRAV * (y < 0.8 ? 1.4 : 0.6)), true);
    // walking: steer the torso's horizontal speed
    if (r.moveDir && lowest < 0.4) {
      const v = t.getLinearVelocity();
      t.setLinearVelocity(V(v.x + (r.moveDir * 2.8 * r.st.speed - v.x) * 0.3, v.y));
      // feet planted in a pose (planning mode) hold the body back by friction: push the legs along too
      if (Math.abs(v.x) < 2.6 * r.st.speed) for (const p of ['thigh0', 'thigh1', 'shin0', 'shin1']) {
        const b = r.B[p];
        b.applyForceToCenter(V(r.moveDir * b.getMass() * 34 * r.st.speed, 0), true);
      }
    }
  }

  // ---- damage ----
  function onContact(W, c) {
    const fa = c.getFixtureA(), fb = c.getFixtureB();
    const a = fa.getUserData(), b = fb.getUserData();
    if (!a || !b || a.f === b.f) return;
    const wm = c.getWorldManifold(null);
    const pt = wm && wm.points && wm.points[0] ? wm.points[0] : fa.getBody().getPosition();
    const va = fa.getBody().getLinearVelocityFromWorldPoint(pt), vb = fb.getBody().getLinearVelocityFromWorldPoint(pt);
    // Strike speed = how fast a part moves relative to its own fighter's torso: a real punch or kick,
    // not two bodies walking into each other. The faster one is the one hitting.
    const own = (u, v) => { const t = W.rag[u.f].B.torso.getLinearVelocity(); return Math.hypot(v.x - t.x, v.y - t.y); };
    const sa = own(a, va), sb = own(b, vb);
    const [atk, def, rel] = sa >= sb ? [a, b, sa] : [b, a, sb];
    W.hits.push({ atk: atk.f, part: atk.part, def: def.f, dpart: def.part, rel, x: pt.x, y: pt.y });
  }

  function resolveHits(W) {
    const out = [];
    for (const h of W.hits) {
      const A = W.rag[h.atk], D = W.rag[h.def];
      if (!STRIKERS.has(h.part) || D.ko || !A.armed) continue;
      if ((A.cool[h.part] || 0) > W.tick) continue;
      const over = h.rel - (W.touch ? 1.5 : 3);
      const vital = h.dpart === 'head' || h.dpart === 'torso';
      // planning mode: even a slow touch on body (1) or head (2) counts
      const touch = W.touch && vital ? (h.dpart === 'head' ? 2 : 1) : 0;
      if (over <= 0 && !touch) continue;
      const power = /^(farm|uarm)/.test(h.part) ? A.st.punch : /^(shin|thigh)/.test(h.part) ? A.st.kick : 1;
      // the cap applies before the fighters' abilities, so a maxed-out hit still feels them
      const dmg = Math.max(touch, Math.round(Math.min(24, Math.max(0, over) * 3.2 * (TAKES[h.dpart] || 0.3)) * power * D.st.def));
      if (dmg < 1) continue;
      A.cool[h.part] = W.tick + 14;
      D.hp = Math.max(0, D.hp - dmg);
      const big = dmg >= 18;
      if (D.hp <= 0) {
        D.ko = true;
        const t = D.B.torso;
        t.applyLinearImpulse(V(-D.face * t.getMass() * 2.5, 0), t.getWorldPoint(V(0, 0.25)), true);
      }
      else if (big && D.stun <= 0 && W.tick > (D.stunFree || 0)) {
        D.stun = 32;
        D.stunFree = W.tick + 32 + 90; // after getting up, a moment before the next knockdown can happen
      }
      out.push({ k: D.ko ? 'ko' : 'hit', w: h.def, x: h.x * SCALE, y: h.y, dmg, big, head: h.dpart === 'head' });
    }
    W.hits = [];
    return out;
  }

  // ---- sustained pressure (planning mode) ----
  // Which joints move each part: a part only presses while its muscles are still trying to go further
  // (a guard held still doesn't hurt someone leaning into it). The head presses on a deliberate lean.
  const MOVERS = { farm0: ['sh0', 'el0'], uarm0: ['sh0'], farm1: ['sh1', 'el1'], uarm1: ['sh1'],
    shin0: ['hip0', 'kn0'], thigh0: ['hip0'], shin1: ['hip1', 'kn1'], thigh1: ['hip1'] };
  function pushing(r, part) {
    if (part === 'head') return r.lean >= 0.2;
    const js = MOVERS[part];
    return !!js && js.some(n => Math.abs((r.target[n] ?? 0) - angleOf(r, n)) > 0.25);
  }
  function onPress(W, c, imp) {
    const fa = c.getFixtureA(), fb = c.getFixtureB();
    const a = fa.getUserData(), b = fb.getUserData();
    if (!a || !b || a.f === b.f) return;
    const n = Math.max(...imp.normalImpulses);
    if (!(n > 0)) return;
    const wm = c.getWorldManifold(null);
    const pt = wm && wm.points && wm.points[0] ? wm.points[0] : fa.getBody().getPosition();
    for (const [def, by] of [[a, b], [b, a]]) {
      if ((def.part === 'head' || def.part === 'torso') && pushing(W.rag[by.f], by.part)) {
        const st = W.rag[by.f].st, power = /^(farm|uarm)/.test(by.part) ? st.punch : /^(shin|thigh)/.test(by.part) ? st.kick : 1;
        W.press.push({ def: def.f, dpart: def.part, n, power, x: pt.x, y: pt.y });
      }
    }
  }

  const NECK_LIMIT = 8;      // accumulated head pressure (decaying) that snaps the neck: about a full move of hard pushing
  function resolvePress(W) {
    const out = [];
    for (const r of W.rag) { r.neck = (r.neck || 0) * 0.97; r.pdmg = r.pdmg || 0; }
    for (const p of W.press) {
      const D = W.rag[p.def];
      if (D.ko) continue;
      const head = p.dpart === 'head';
      D.pdmg += p.n * (head ? 1.2 : 0.6) * p.power * D.st.def;
      if (head) D.neck += p.n;
      D.lastPress = p;
    }
    W.press = [];
    for (const D of W.rag) {
      if (D.ko) continue;
      if (D.neck > NECK_LIMIT && D.J.neck) {
        W.world.destroyJoint(D.J.neck);
        D.J.neck = null; D.ko = true; D.hp = 0; D.headless = true;
        // the head pops up and away; from now on it only meets the floor and walls, so nothing pins it
        const h = D.B.head;
        for (let f = h.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: -(D.i + 1), categoryBits: 8, maskBits: 1 });
        h.setLinearVelocity(V(-D.face * 3, 8));
        h.setAngularVelocity(-D.face * 9);
        const q = h.getPosition();
        out.push({ k: 'decap', w: D.i, x: q.x * SCALE, y: q.y, dmg: 0, big: true, head: true });
        continue;
      }
      const whole = Math.floor(D.pdmg);
      if (whole >= 1 && W.tick >= (D.pressShown || 0)) {
        D.pdmg -= whole;
        D.hp = Math.max(0, D.hp - whole);
        D.pressShown = W.tick + 10;
        const p = D.lastPress;
        if (D.hp <= 0) D.ko = true;
        out.push({ k: D.ko ? 'ko' : 'press', w: D.i, x: p.x * SCALE, y: p.y, dmg: whole, big: false, head: p.dpart === 'head' });
      }
    }
    return out;
  }

  // ---- real-time controls: buttons → target pose ----
  const ACT_LEN = { punch: 20, punch2: 20, kick: 26 };
  function controlRealtime(r, held, taps, B) {
    if (r.ko) return;
    const t = { ...POSES.guard };
    r.moveDir = 0; r.lean = 0; r.speed = 14;
    if (r.stun > 0) { r.target = t; return; }
    const fwd = r.face > 0 ? B.r : B.l, back = r.face > 0 ? B.l : B.r;
    const onGround = Math.min(r.B.shin0.getPosition().y, r.B.shin1.getPosition().y) < 0.45;
    const dir = (held & fwd ? 1 : 0) - (held & back ? 1 : 0);
    // a jump pressed mid-stride (a foot in the air) is kept for a moment and happens on the next step down
    if (taps & B.j) r.jumpBuf = 12;
    else if (held & B.j) r.jumpBuf = Math.max(r.jumpBuf, 1); // held up: jump again on landing
    else if (r.jumpBuf > 0) r.jumpBuf--;
    if (r.jumpCd > 0) r.jumpCd--;
    if (!r.act) {
      if (taps & B.p) { r.act = r.lastPunch === 'punch' ? 'punch2' : 'punch'; r.lastPunch = r.act; r.actT = 0; }
      else if (taps & B.k) { r.act = 'kick'; r.actT = 0; }
      else if (r.jumpBuf > 0 && onGround && !(r.jumpCd > 0)) {
        r.jumpBuf = 0; r.jumpCd = 20; // feet are still low right after take-off
        // jumping while moving (joystick diagonal) takes off in that direction
        for (const p of PARTS) { const b = r.B[p], v = b.getLinearVelocity(); b.setLinearVelocity(V(dir ? dir * r.face * 2.8 : v.x, 6.2 * r.st.jump)); }
      }
    }
    if (!onGround && dir) { // a little steering in the air
      const t = r.B.torso, v = t.getLinearVelocity();
      t.setLinearVelocity(V(v.x + (dir * r.face * 2.8 - v.x) * 0.05, v.y));
    }
    r.blocking = !r.act && !!(held & B.b);
    r.armed = !!r.act;
    if (r.act && r.act !== 'kick') r.moveDir = dir * r.face * 0.7; // can step in while punching
    if (r.act) {
      r.actT++;
      const len = ACT_LEN[r.act], punch = r.act !== 'kick';
      // punches snap out early and stay straight longer (more reach); kicks as before
      const strike = punch ? r.actT > 1 && r.actT < len * 0.75 : r.actT > 2 && r.actT < len * 0.65;
      if (strike) Object.assign(t, POSES[r.act]);
      if (r.act === 'kick') r.lean = -0.25;
      else r.lean = strike ? 0.3 : 0;
      r.speed = punch ? 24 : 18;
      if (punch && r.actT === 2 && onGround) { // a small step into the punch
        const tb = r.B.torso, v = tb.getLinearVelocity();
        tb.setLinearVelocity(V(v.x + r.face * 1.6, v.y));
      }
      if (r.actT >= len) r.act = null;
    } else if (r.blocking) {
      Object.assign(t, POSES.block);
    } else {
      if (dir) {
        r.moveDir = dir * r.face;
        r.walk += 0.22 * r.st.speed;
        const s = Math.sin(r.walk);
        t.hip0 = 0.1 + s * 0.45; t.hip1 = 0.1 - s * 0.45;
        t.kn0 = -0.2 - Math.max(0, -s) * 0.9; t.kn1 = -0.2 - Math.max(0, s) * 0.9;
      }
    }
    if (!onGround && !r.act) Object.assign(t, POSES.tuck);
    r.target = t;
  }

  // ---- turn-based: a planned pose (targets per joint + lean) held for the whole turn ----
  // plan: { t: joint targets, lean, move: -1 back / 0 / 1 toward the opponent, jump }
  function setPlan(r, plan) {
    if (r.ko) return;
    r.target = { ...POSES.guard, ...plan.t };
    r.lean = plan.lean || 0;
    r.speed = 16; r.act = null; r.armed = true;
    r.moveDir = (plan.move || 0) * r.face;
    const onGround = Math.min(r.B.shin0.getPosition().y, r.B.shin1.getPosition().y) < 0.4;
    if (plan.jump && onGround) for (const p of PARTS) { // a jump with a step takes off in that direction
      const b = r.B[p], v = b.getLinearVelocity();
      b.setLinearVelocity(V(plan.move ? plan.move * r.face * 2.8 : v.x, 6.2 * r.st.jump));
    }
  }

  function currentAngles(r) {
    const t = {};
    for (const n of JN) if (r.J[n]) t[n] = angleOf(r, n);
    return t;
  }

  // Between turns everything freezes in place; the next turn picks up with the same velocities.
  function freeze(W, on) {
    for (const r of W.rag) for (const p of PARTS) r.B[p].setAwake(true);
    W.frozen = on;
  }

  // Personal space: a horizontal push keeps the two bodies about half a meter apart (limbs still reach to hit),
  // so they can't walk through or climb over each other, without tipping anyone over.
  const SPACE = 0.75;
  function personalSpace(W) {
    const [a, b] = W.rag;
    const dx = b.B.torso.getPosition().x - a.B.torso.getPosition().x;
    const gap = dx * a.face; // positive while each is on their own side
    if (gap >= SPACE) return;
    const push = Math.min(1, (SPACE - gap) / SPACE) * 260;
    for (const [r, s] of [[a, -a.face], [b, a.face]]) {
      for (const p of ['torso', 'thigh0', 'thigh1', 'shin0', 'shin1']) {
        const body = r.B[p];
        body.applyForceToCenter(V(s * push * body.getMass(), 0), true);
      }
    }
  }

  function step(W) {
    W.tick++;
    for (const r of W.rag) {
      if (r.stun > 0) r.stun--;
      drive(r); balance(r);
    }
    personalSpace(W);
    W.world.step(1 / 60, 8, 3);
    const out = resolveHits(W);
    return W.touch ? out.concat(resolvePress(W)) : out;
  }

  // Snapshot: per fighter, every part's x, y (pixels) and angle.
  function pack(W) {
    return W.rag.map(r => PARTS.map(p => {
      const b = r.B[p], q = b.getPosition();
      return [Math.round(q.x * SCALE), Math.round(q.y * SCALE), Math.round(b.getAngle() * 100) / 100];
    }));
  }

  function centerX(r) { return r.B.torso.getPosition().x * SCALE; }

  // ---- planning (pure math, works from a snapshot too) ----
  // Shoulder and hip points (pixels, y up) from the torso's packed [x, y, angle].
  function jointsFrom(torso) {
    const [x, y, a] = torso;
    const at = dy => [x - dy * Math.sin(a) * SCALE, y + dy * Math.cos(a) * SCALE];
    return { sh: at(0.23), hip: at(-0.25), a };
  }
  const LIMBS = { arm0: ['sh', 'sh0', 'el0', 0.36 * SCALE, 0.35 * SCALE, 1], arm1: ['sh', 'sh1', 'el1', 0.36 * SCALE, 0.35 * SCALE, 1],
    leg0: ['hip', 'hip0', 'kn0', 0.43 * SCALE, 0.5 * SCALE, -1], leg1: ['hip', 'hip1', 'kn1', 0.43 * SCALE, 0.5 * SCALE, -1] };

  // Two-bone IK: joint angles (fighter's frame) that put a hand or foot at point T (pixels, y up).
  // Elbows bend forward (+), knees backward (−). Out-of-reach points get the straight limb pointed at them.
  function solveLimb(torso, face, limb, T) {
    const [base, n1, n2, L1, L2, bend] = LIMBS[limb];
    const J = jointsFrom(torso), S = J[base];
    let dx = (T[0] - S[0]) * face, dy = T[1] - S[1];
    // into the torso's own frame
    const ta = J.a * face;
    const c = Math.cos(-ta), s = Math.sin(-ta);
    [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
    const d = Math.max(8, Math.min(L1 + L2 - 0.5, Math.hypot(dx, dy)));
    const phi = Math.atan2(dx, -dy);
    const a = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
    const inner = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))));
    return { [n1]: phi - bend * a, [n2]: bend * (Math.PI - inner) };
  }

  // Where a limb's end sits for given joint angles (to place the handles at the start of a turn).
  function limbEnd(torso, face, limb, t) {
    const [base, n1, n2, L1, L2] = LIMBS[limb];
    const J = jointsFrom(torso), S = J[base];
    const ta = J.a * face;
    const a1 = ta + t[n1], a2 = a1 + t[n2];
    const fx = Math.sin(a1) * L1 + Math.sin(a2) * L2, fy = -Math.cos(a1) * L1 - Math.cos(a2) * L2;
    return [S[0] + fx * face, S[1] + fy];
  }

  // The elbow / knee point for given joint angles.
  function limbMid(torso, face, limb, t) {
    const [base, n1, , L1] = LIMBS[limb];
    const J = jointsFrom(torso), S = J[base];
    const a1 = J.a * face + t[n1];
    return [S[0] + Math.sin(a1) * L1 * face, S[1] - Math.cos(a1) * L1];
  }

  // Joint positions in pixels (y up) for the planning screen.
  function anchors(r) {
    const tp = r.B.torso.getPosition(), a = r.B.torso.getAngle();
    const at = (dx, dy) => [(tp.x + dx * Math.cos(a) - dy * Math.sin(a)) * SCALE, (tp.y + dx * Math.sin(a) + dy * Math.cos(a)) * SCALE];
    return { sh: at(0, 0.23), hip: at(0, -0.25), torsoAngle: a };
  }

  return { SCALE, PARTS, JN, POSES, newMatchWorld, step, controlRealtime, setPlan, pack, centerX, anchors, freeze,
    solveLimb, limbEnd, limbMid, jointsFrom, LIMBS, currentAngles,
    LEN: { uarm: 36, farm: 35, thigh: 43, shin: 47 } };
})();
if (typeof module !== 'undefined') module.exports = PH;
