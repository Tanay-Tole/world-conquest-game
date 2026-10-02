'use strict';
/* =====================================================================
   WORLD CONQUEST — game.js
   Simulation core. Everything here operates on the serialisable game
   state `G` and the static world `WD`; no DOM access except through
   notification helpers (toast / gameOver) that live in ui.js.

   Daily loop (simDay):
     population → economy/recruitment → empire finances → resources
     → battles → fleets → troop movements → supply (5-day) → AI
     → diplomacy + victory (30-day) → autosave (180-day)
   ===================================================================== */

const pathCache = new Map();   // sea-route cache: "a>b" -> cell path | null

/* ---------------- empire factory ---------------- */
function makeEmpire(id, name, color, emblem, player) {
  return {
    id, name, color, rgb: hex2rgb(color), emblem, player, alive: true, capital: -1,
    doctrine: 'balanced',
    treasury: player ? 400 : 350, tech: 1, morale: 1, mil: .3, research: .1, navy: 0, busy: 0, econ: 1,
    bonus: [0, 0, 0, 0, 0, 0],
    c: { terr: 0, pop: 0, gdp: 0, troops: 0, area: 0, coastal: 0, res: [0, 0, 0, 0, 0, 0], inc: 0 },
    fin: { income: 0, milB: 0, resB: 0, upk: 0, net: 0 },
    stats: { peak: 0, won: 0, lost: 0, wars: 0 },
    ai: { next: 0, aggr: .5, naval: .5 }
  };
}

/* ---------------- economic & military formulas ---------------- */
const gdpOf = t => G.pop[t] * (600 + G.ind[t] * 260 + (G.fact ? G.fact[t] * 450 : 0)) / 1e9; // $B per year
const native = t => 400 + .1 * Math.pow(G.pop[t], .75);                  // unclaimed-land garrison target
const capOf = (t, e) => (2000 + .3 * Math.pow(G.pop[t], .75)) * (.7 + e.mil * 1.5); // manpower cap
const minGar = t => 200 + Math.pow(G.pop[t], .75) * .02;
const indCost = t => 80 + G.pop[t] / 1e6 * 4 * (1 + G.ind[t] / 100);
const factoryCost = t => 180 + G.pop[t] / 1e6 * 2 + 220 * Math.pow(G.fact[t], 1.35);
const fortCost = t => 120 * (1 + G.fort[t]);
const shipCostOf = e => CFG.SHIP_COST * (1 - e.bonus[4]);
const navalRange = e => Math.round(CFG.NAVAL_RANGE * (1 + e.bonus[2]) + (e.tech - 1) * 60);
const recruitAmt = (t, e) => Math.round(Math.max(2000, capOf(t, e) * .12));
function territoryDistance(a, b) {
  const x = WD.terr[a], y = WD.terr[b], rad = Math.PI / 180;
  const dLat = (y.lat - x.lat) * rad, dLon = (y.lon - x.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(x.lat * rad) * Math.cos(y.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
const missileRange = (e, nuclear = false) => Math.min(20000, Math.round((nuclear ? 5200 : 3200) + (e.tech - 1) * (nuclear ? 11000 : 7000)));

/* ---------------- diplomacy primitives ---------------- */
const atWar = (a, b) => a !== b && G.rel[a][b] === 2;
const allied = (a, b) => a !== b && G.rel[a][b] === 1;
function relStatus(a, b) {
  if (!G || a === b) return ST.NEUTRAL;
  const r = G.rel[a][b];
  if (r === 2) return ST.WAR;
  if (r === 1) return ST.ALLIED;
  const o = G.op[a][b];
  return o > 35 ? ST.FRIENDLY : o < -35 ? ST.HOSTILE : ST.NEUTRAL;
}
function setRel(a, b, v) { G.rel[a][b] = G.rel[b][a] = v; }
function adjOp(a, b, d) { const v = clamp(G.op[a][b] + d, -100, 100); G.op[a][b] = G.op[b][a] = v; }
const strength = e => e.alive ? e.c.troops * e.tech * e.morale * (doctrineOf(e).attack + doctrineOf(e).defense) / 2 + 1 : 0;

/* ---------------- new game generation ---------------- */
function newGame(o) {
  const T = WD.T, D = DIFF[o.diff];
  const seed = (Math.random() * 2 ** 31) | 0, rng = mulberry32(seed);
  pathCache.clear();
  G = {
    v: 1, seed, day: 0, speed: 1, diff: o.diff, goal: o.goal, won: false, over: false, nid: 1,
    owner: new Int16Array(T).fill(-1), troops: new Float32Array(T), pop: new Float64Array(T), ind: new Float32Array(T),
    fact: new Uint8Array(T), colony: new Uint8Array(T), colPolicy: new Uint8Array(T),
    silo: new Uint8Array(T), missile: new Uint8Array(T), nuke: new Uint8Array(T),
    res: new Uint8Array(T), fort: new Uint8Array(T), supply: new Float32Array(T).fill(1),
    empires: [], rel: [], op: [], truce: [], warStart: [], trade: [], battles: [], fleets: [], moves: [], strikes: [], offers: [], worldGdp: 1
  };
  // per-game variation of population, industry, resources and fortifications
  for (let t = 0; t < T; t++) {
    const tr = WD.terr[t];
    G.pop[t] = tr.basePop * (.85 + rng() * .3);
    G.ind[t] = genInd(tr, rng);
    G.res[t] = genRes(tr, rng);
    G.fort[t] = tr.terrain === 4 && rng() < .3 ? 1 : 0;
    G.troops[t] = native(t);
  }
  const P = makeEmpire(0, o.name, o.color, o.emblem, true);
  P.doctrine = DOCTRINES[o.doctrine] ? o.doctrine : 'vanguard';
  G.empires.push(P);
  const used = new Set(), claim = (e, t) => { G.owner[t] = e.id; used.add(t); };
  claim(P, o.start); P.capital = o.start;

  // distinct AI colours, avoiding the player's hue
  const pHue = rgbHue(P.rgb), pal = []; let h = rng() * 360;
  while (pal.length < D.ais) {
    h = (h + 137.508) % 360;
    const dh = Math.min(Math.abs(h - pHue), 360 - Math.abs(h - pHue));
    if (dh < 20) continue;
    pal.push(rgb2hex(hsl2rgb(h, .42 + rng() * .22, .44 + rng() * .14)));
  }
  // spread AI capitals across the globe (min distance relaxes if needed)
  const cands = [];
  for (let t = 0; t < T; t++) { const tr = WD.terr[t]; if (tr.area >= 35 && tr.terrain !== 6 && t !== o.start) cands.push(t); }
  const starts = [o.start], names = new Set([o.name]);
  let minD = 210, fails = 0;
  for (let i = 0; i < D.ais; i++) {
    let pick = -1;
    while (pick < 0) {
      const t = cands[(rng() * cands.length) | 0];
      if (used.has(t)) continue;
      const a = WD.terr[t]; let ok = true;
      for (const s of starts) {
        const b = WD.terr[s]; let dx = Math.abs(a.ax - b.ax); dx = Math.min(dx, WD.MW - dx);
        if (Math.hypot(dx, a.ay - b.ay) < minD) { ok = false; break; }
      }
      if (ok) pick = t; else if (++fails > 80) { fails = 0; minD *= .88; }
    }
    starts.push(pick);
    let nm; do nm = genName(rng); while (names.has(nm)); names.add(nm);
    const e = makeEmpire(i + 1, nm, pal[i], EMB_KEYS[(rng() * EMB_KEYS.length) | 0], false);
    e.doctrine = Object.keys(DOCTRINES)[(rng() * Object.keys(DOCTRINES).length) | 0];
    e.econ = D.econ; e.mil = .28; e.research = .07;
    e.ai = { next: 2 + ((rng() * D.think) | 0), aggr: .35 + rng() * .6, naval: .3 + rng() * .7 };
    G.empires.push(e); claim(e, pick); e.capital = pick;
  }
  // every empire starts with its capital plus up to two neighbouring regions
  for (const e of G.empires) {
    const nb = WD.terr[e.capital].nb.filter(n => G.owner[n] < 0).sort((a, b) => G.pop[b] - G.pop[a]).slice(0, 2);
    for (const n of nb) claim(e, n);
  }
  const n = G.empires.length;
  for (let a = 0; a < n; a++) { G.rel.push(new Int8Array(n)); G.op.push(new Float32Array(n)); G.truce.push(new Int32Array(n)); G.warStart.push(new Int32Array(n)); G.trade.push(new Uint8Array(n)); }
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const v = (rng() - .5) * 60; G.op[a][b] = G.op[b][a] = v; }
  for (let t = 0; t < T; t++) { const ow = G.owner[t]; if (ow >= 0) G.troops[t] = capOf(t, G.empires[ow]) * .6; }
  for (const e of G.empires) e.navy = WD.terr[e.capital].coastal ? 1 : 0;
  computeSupply();
  simDay(); G.day = 0;   // prime aggregates
  markFill();
}

/* ---------------- daily simulation ---------------- */
function simDay() {
  G.day++;
  const E = G.empires, T = WD.T, own = G.owner, pop = G.pop, tro = G.troops, ind = G.ind, sup = G.supply;
  for (const e of E) e.c = { terr: 0, pop: 0, gdp: 0, troops: 0, area: 0, coastal: 0, res: [0, 0, 0, 0, 0, 0], inc: 0 };
  let wg = 0;
  for (let t = 0; t < T; t++) {
    const o = own[t], p = pop[t], gdp = gdpOf(t);
    wg += gdp;
    if (o < 0) {
      pop[t] = p * 1.00003;
      const nat = native(t);
      if (tro[t] < nat) tro[t] += Math.max(4, (nat - tro[t]) * .004);
      continue;
    }
    const e = E[o], b = e.bonus;
    pop[t] = p * (1 + .00004 * (1 + b[0]));
    const cap = capOf(t, e); let tr = tro[t];
    const policy = COLONY_POLICIES[Object.keys(COLONY_POLICIES)[G.colPolicy[t]]] || COLONY_POLICIES.balanced;
    if (tr < cap) { if (e.treasury > -50) tr = Math.min(cap, tr + cap * .006 * (.5 + e.mil * 1.7) * sup[t] * e.morale * (1 + b[1]) * e.econ * (G.colony[t] ? policy.recovery : 1)); }
    else tr -= (tr - cap) * .003;
    tro[t] = tr;
    if (e.treasury > 0 && ind[t] < 100) ind[t] = Math.min(100, ind[t] + .0025 * (1 - e.mil) * (1 + b[3]) * e.econ);
    const c = e.c;
    c.terr++; c.pop += p; c.gdp += gdp; c.troops += tr; c.area += WD.terr[t].area;
    c.inc += (6 + gdp * .25) * (G.colony[t] ? policy.income : 1);
    if (WD.terr[t].coastal) c.coastal++;
    const r = G.res[t]; if (r) for (let k = 0; k < 6; k++) if (r >> k & 1) c.res[k]++;
  }
  G.worldGdp = wg;
  for (const b of G.battles) E[b.e].c.troops += b.force;
  for (const f of G.fleets) E[f.e].c.troops += f.force;
  for (const m of G.moves) E[m.e].c.troops += m.amount;
  for (const e of E) {
    if (!e.alive) continue;
    const c = e.c;
    const doctrine = doctrineOf(e);
    const income = c.inc * e.econ * doctrine.income;
    const trade = G.trade[e.id].reduce((sum, active, id) => (active || allied(e.id, id)) && E[id].alive ? sum + income * .05 : sum, 0);
    const milB = income * e.mil, resB = income * e.research, upk = c.troops * .00004 + e.navy * .6;
    e.fin = { income, trade, milB, resB, upk, net: income + trade - milB - resB - upk };
    e.treasury += e.fin.net;
    e.tech += (.00004 + e.research * .0012 * (1 + e.bonus[5])) * e.econ * doctrine.research;
    e.morale += (1 - e.morale) * .004;
    if (e.treasury < 0) e.morale = Math.max(.5, e.morale - .003);
    const den = Math.max(3, c.terr * .25);
    for (let k = 0; k < 6; k++) e.bonus[k] = RES_FX[k][1] * Math.min(1, c.res[k] / den);
    if (c.terr > e.stats.peak) e.stats.peak = c.terr;
  }
  stepBattles(); stepFleets(); stepMoves(); stepStrikes();
  if (G.over) return;
  if (G.day % 5 === 0) computeSupply();
  const D = DIFF[G.diff];
  for (const e of E) if (e.alive && !e.player && G.day >= e.ai.next) { aiThink(e); e.ai.next = G.day + D.think + ((Math.random() * 3) | 0); }
  if (G.day % 30 === 0) { aiDiplomacy(); expireOffers(); checkVictory(); }
  if (S.autosave && G.day % 180 === 0) Save.save('auto', true);
}

/* ---------------- supply ---------------- */
/** Land BFS from each capital through own territory; unreached land is "overseas". */
function computeSupply() {
  const T = WD.T, own = G.owner, d = new Int16Array(T).fill(-1), q = [];
  for (const e of G.empires) if (e.alive && e.capital >= 0 && own[e.capital] === e.id) { d[e.capital] = 0; q.push(e.capital); }
  for (let i = 0; i < q.length; i++) {
    const t = q[i], o = own[t];
    for (const n of WD.terr[t].nb) if (d[n] < 0 && own[n] === o) { d[n] = d[t] + 1; q.push(n); }
  }
  for (let t = 0; t < T; t++) {
    const o = own[t];
    if (o < 0) { G.supply[t] = 1; continue; }
    const e = G.empires[o];
    G.supply[t] = d[t] >= 0 ? Math.max(.55, 1 - .022 * d[t]) : clamp(.55 + Math.min(.2, (e.navy - e.busy) * .04), .5, .8);
  }
}

/* ---------------- combat ---------------- */
/** Defensive power of a territory's garrison. */
function defPow(t) {
  const o = G.owner[t], tr = WD.terr[t];
  const p = Math.max(G.troops[t], 0) * TDEF[tr.terrain] * (1 + G.fort[t] * .2);
  if (o < 0) return p * .95;
  const d = G.empires[o];
  return p * d.tech * d.morale * (.85 + .15 * G.supply[t]) * doctrineOf(d).defense * (d.capital === t ? 1.2 : 1);
}
/** Per-soldier attack multiplier. Naval landings fight at a penalty. */
const attMult = (e, src, naval) => e.tech * e.morale * (naval ? .64 : (src >= 0 ? G.supply[src] : .8)) * (1 + e.bonus[2]) * doctrineOf(e).attack;
/** Monte-Carlo estimate of victory chance using the same rules as stepBattles. */
function winChance(force, mult, t, n = 48) {
  const D0 = Math.max(G.troops[t], 0), dpm = D0 > 0 ? defPow(t) / D0 : 1;
  let wins = 0;
  for (let k = 0; k < n; k++) {
    let a = force, d = D0, g = 0;
    while (a > 0 && d > 0 && g++ < 300) {
      const ap = a * mult, dp = d * dpm;
      d -= Math.max(25, ap * .14 * (.75 + Math.random() * .5));
      a -= Math.max(25, dp * .14 * (.75 + Math.random() * .5));
    }
    if (d <= 0 && a > 0) wins++;
  }
  return wins / n;
}

/* ---------------- strategic weapons ---------------- */
function launchStrategicStrike(e, src, dst, kind) {
  const nuclear = kind === 'nuke', owner = G.owner[dst], tech = nuclear ? CFG.NUKE_TECH : CFG.MISSILE_TECH;
  const stock = nuclear ? G.nuke[src] : G.missile[src], distance = territoryDistance(src, dst);
  if (G.owner[src] !== e.id || !G.silo[src] || stock < 1 || e.tech < tech || owner < 0 || owner === e.id || !atWar(e.id, owner)) return false;
  if (distance > missileRange(e, nuclear)) return false;
  if (nuclear) G.nuke[src]--; else G.missile[src]--;
  G.strikes.push({ id: G.nid++, e: e.id, src, dst, kind, distance, arrive: G.day + Math.max(1, Math.ceil(distance / 8000)) });
  if (e.player) toast(`${nuclear ? 'Nuclear strike' : 'Missile strike'} launched toward <b>${esc(WD.terr[dst].name)}</b> · ${Math.round(distance).toLocaleString()} km`, nuclear ? 'bad' : 'info');
  R.fillDirty = true;
  return true;
}
function stepStrikes() {
  for (let i = G.strikes.length - 1; i >= 0; i--) {
    const s = G.strikes[i];
    if (G.day < s.arrive) continue;
    G.strikes.splice(i, 1);
    const owner = G.owner[s.dst], attacker = G.empires[s.e];
    if (!attacker.alive || owner < 0 || owner === s.e || !atWar(s.e, owner)) {
      if (s.e === 0) toast(`Strike on <b>${esc(WD.terr[s.dst].name)}</b> aborted: the target is no longer at war`, 'info');
      continue;
    }
    const defender = G.empires[owner], territory = WD.terr[s.dst];
    if (s.kind === 'nuke') {
      const shield = G.fort[s.dst] >= 2 ? .18 : 0;
      G.troops[s.dst] *= .08 + shield * .5;
      G.pop[s.dst] *= 1 - .04 * (1 - shield);
      G.ind[s.dst] *= 1 - .65 * (1 - shield);
      G.fact[s.dst] = Math.max(0, G.fact[s.dst] - (shield ? 1 : 2));
      G.fort[s.dst] = 0;
      G.missile[s.dst] = 0; G.nuke[s.dst] = 0; G.silo[s.dst] = 0;
      defender.morale = Math.max(.5, defender.morale - .2);
      for (const empire of G.empires) if (empire.alive && empire.id !== s.e) adjOp(empire.id, s.e, -8);
      toast(`<b>Nuclear strike</b> devastated ${esc(territory.name)}. Global opinion of ${esc(attacker.name)} has fallen.`, 'bad');
      if (owner === 0) A.sfx('alarm');
    } else {
      G.troops[s.dst] *= .62;
      G.ind[s.dst] *= .86;
      G.fort[s.dst] = Math.max(0, G.fort[s.dst] - 1);
      G.missile[s.dst] = Math.max(0, G.missile[s.dst] - 1);
      toast(`<b>Missile strike</b> hit ${esc(territory.name)} · garrison and infrastructure damaged`, owner === 0 ? 'bad' : 'info');
      if (owner === 0) A.sfx('alarm');
    }
    R.fillDirty = true;
  }
}
function launchAttack(e, src, dst, force) {
  force = Math.min(force, G.troops[src] - 1);
  if (force < 50) return false;
  G.troops[src] -= force;
  G.battles.push({ id: G.nid++, e: e.id, src, dst, force, init: force, naval: false, sup: G.supply[src], days: 0 });
  if (e.player || G.owner[dst] === 0) A.sfx('battle');
  return true;
}
function stepBattles() {
  const E = G.empires;
  for (let i = G.battles.length - 1; i >= 0; i--) {
    const b = G.battles[i], e = E[b.e], o = G.owner[b.dst];
    if (!e.alive) { G.battles.splice(i, 1); continue; }
    if (o === b.e) { G.troops[b.dst] += b.force; G.battles.splice(i, 1); continue; }     // already ours: reinforce
    if (o >= 0 && !atWar(b.e, o)) {                                                       // peace happened: withdraw
      if (b.src >= 0 && G.owner[b.src] === b.e) G.troops[b.src] += b.force;
      G.battles.splice(i, 1); continue;
    }
    const Dd = Math.max(G.troops[b.dst], 0);
    const ap = b.force * e.tech * e.morale * b.sup * (1 + e.bonus[2]) * (b.naval ? .8 : 1) * doctrineOf(e).attack;
    const dp = defPow(b.dst);
    b.force -= Math.max(25, dp * .14 * (.75 + Math.random() * .5));
    G.troops[b.dst] = Dd - Math.max(25, ap * .14 * (.75 + Math.random() * .5));
    b.days++;
    if (G.troops[b.dst] <= 0 && b.force > 0) { G.battles.splice(i, 1); capture(b.dst, b.e, b.force); if (G.over) return; }
    else if (b.force <= 0) {
      G.battles.splice(i, 1);
      G.troops[b.dst] = Math.max(G.troops[b.dst], 50);
      e.stats.lost++; e.morale = Math.max(.55, e.morale - .006);
      if (o >= 0) { E[o].stats.won++; E[o].morale = Math.min(1.25, E[o].morale + .004); }
      if (b.e === 0) toast(`Assault on <b>${esc(WD.terr[b.dst].name)}</b> was repulsed`, 'bad');
    }
  }
}
function capture(t, eid, force) {
  const prev = G.owner[t], e = G.empires[eid], tr = WD.terr[t];
  const wasCapital = prev >= 0 && G.empires[prev].capital === t;
  G.owner[t] = eid; G.troops[t] = force; G.colPolicy[t] = 0;
  updateColonies(eid);
  if (G.fort[t] > 0) G.fort[t]--;
  G.ind[t] *= .95;
  e.stats.won++; e.morale = Math.min(1.25, e.morale + .008);
  flash(t); markFill();
  if (eid === 0) A.sfx('capture');
  if (prev >= 0) {
    const p = G.empires[prev];
    p.stats.lost++; p.morale = Math.max(.55, p.morale - .012);
    if (wasCapital) {
      p.morale = Math.max(.55, p.morale - .1);
      if (eid === 0) toast(`<b>${esc(tr.name)}</b> was their capital. Their national morale is shaken.`, 'good');
      else if (prev === 0) toast(`<b>${esc(tr.name)}</b> was your capital. National morale has collapsed.`, 'bad');
    }
    if (eid === 0) toast(`Captured <b>${esc(tr.name)}</b> from ${esc(p.name)}`, 'good');
    if (prev === 0) { toast(`<b>${esc(tr.name)}</b> has fallen to ${esc(e.name)}`, 'bad'); A.sfx('alarm'); }
    if (p.capital === t) relocateCapital(p, prev === 0);
    updateColonies(prev);
    let alive = false;
    for (let u = 0; u < WD.T; u++) if (G.owner[u] === prev) { alive = true; break; }
    if (!alive) eliminate(prev, eid);
  }
}
function updateColonies(eid) {
  const e = G.empires[eid], connected = new Uint8Array(WD.T), q = [];
  if (e.capital >= 0 && G.owner[e.capital] === eid) { connected[e.capital] = 1; q.push(e.capital); }
  for (let i = 0; i < q.length; i++) for (const n of WD.terr[q[i]].nb) {
    if (!connected[n] && G.owner[n] === eid) { connected[n] = 1; q.push(n); }
  }
  for (let t = 0; t < WD.T; t++) if (G.owner[t] === eid) {
    G.colony[t] = connected[t] ? 0 : 1;
    if (!connected[t]) G.colPolicy[t] = Math.min(G.colPolicy[t], 2);
  }
}
function relocateCapital(p, notify) {
  let best = -1, bp = -1;
  for (let u = 0; u < WD.T; u++) if (G.owner[u] === p.id && G.pop[u] > bp) { bp = G.pop[u]; best = u; }
  p.capital = best;
  if (notify && best >= 0) toast(`Capital relocated to <b>${esc(WD.terr[best].name)}</b>`, 'bad');
}
function eliminate(eid, by) {
  const e = G.empires[eid];
  e.alive = false; e.capital = -1;
  G.battles = G.battles.filter(b => b.e !== eid);
  G.fleets = G.fleets.filter(f => f.e !== eid);
  G.moves = G.moves.filter(m => m.e !== eid);
  G.strikes = G.strikes.filter(s => s.e !== eid);
  G.offers = G.offers.filter(f => f.from !== eid);
  for (const o of G.empires) if (o.id !== eid) setRel(eid, o.id, 0);
  R.labelsDirty = true;
  if (e.player) { gameOver(false); return; }
  toast(`<b>${esc(e.name)}</b> has been destroyed${by >= 0 ? ' by ' + esc(G.empires[by].name) : ''}`, by === 0 ? 'good' : 'info');
}

/* ---------------- naval ---------------- */
/** A* across the sea-lane grid (4-dir + guarded diagonals + antimeridian wrap). */
const SP = { g: null, from: null, stamp: null, closed: null, cur: 0 };
function seaPath(a, b, maxLen) {
  const s = WD.terr[a].pcell, t = WD.terr[b].pcell;
  if (s < 0 || t < 0) return null;
  const key = a + '>' + b;
  let res;
  if (pathCache.has(key)) res = pathCache.get(key);
  else {
    const { GW, GH, water, wL, wR } = WD.grid, n = GW * GH;
    if (!SP.g) { SP.g = new Float32Array(n); SP.from = new Int32Array(n); SP.stamp = new Int32Array(n); SP.closed = new Int32Array(n); }
    const cur = ++SP.cur, tx = t % GW, ty = (t - tx) / GW;
    const hf = c => { const x = c % GW, y = (c - x) / GW; let dx = Math.abs(x - tx); dx = Math.min(dx, GW - dx); return Math.hypot(dx, y - ty); };
    const H = new Heap();
    SP.stamp[s] = cur; SP.g[s] = 0; SP.from[s] = -1; H.push(s, hf(s));
    const ok = c => water[c] || c === t;
    while (H.size) {
      const c = H.pop();
      if (SP.closed[c] === cur) continue;
      SP.closed[c] = cur;
      if (c === t) break;
      const x = c % GW, y = (c - x) / GW, gc = SP.g[c];
      const relax = (q, w) => {
        if (SP.closed[q] === cur || !ok(q)) return;
        const ng = gc + w;
        if (SP.stamp[q] !== cur || ng < SP.g[q]) { SP.stamp[q] = cur; SP.g[q] = ng; SP.from[q] = c; H.push(q, ng + hf(q)); }
      };
      const L = x > 0 && ok(c - 1), Rr = x < GW - 1 && ok(c + 1), U = y > 0 && ok(c - GW), Dn = y < GH - 1 && ok(c + GW);
      if (L) relax(c - 1, 1); if (Rr) relax(c + 1, 1); if (U) relax(c - GW, 1); if (Dn) relax(c + GW, 1);
      if (L && U) relax(c - GW - 1, 1.414); if (Rr && U) relax(c - GW + 1, 1.414);
      if (L && Dn) relax(c + GW - 1, 1.414); if (Rr && Dn) relax(c + GW + 1, 1.414);
      if (wL[y] === x) relax(y * GW + wR[y], 1);
      if (wR[y] === x) relax(y * GW + wL[y], 1);
    }
    if (SP.closed[t] !== cur) res = null;
    else { res = []; for (let c = t; c !== -1; c = SP.from[c]) res.push(c); res.reverse(); }
    if (pathCache.size > 6000) pathCache.clear();
    pathCache.set(key, res);
  }
  return res && res.length - 1 <= maxLen ? res : null;
}
function launchFleet(e, src, dst, force, path) {
  force = Math.min(force, G.troops[src] - 1, (e.navy - e.busy) * CFG.SHIP_CAP);
  const ships = Math.ceil(force / CFG.SHIP_CAP);
  if (force < 500 || ships < 1 || ships > e.navy - e.busy) return false;
  G.troops[src] -= force; e.busy += ships;
  G.fleets.push({ id: G.nid++, e: e.id, src, dst, force, ships, path, pos: 0 });
  return true;
}
function stepFleets() {
  for (let i = G.fleets.length - 1; i >= 0; i--) {
    const f = G.fleets[i], e = G.empires[f.e];
    f.pos += CFG.FLEET_SPEED * (1 + e.bonus[2]);
    if (f.pos < f.path.length - 1) continue;
    G.fleets.splice(i, 1);
    e.busy = Math.max(0, e.busy - f.ships);
    const o = G.owner[f.dst];
    if (o === f.e) G.troops[f.dst] += f.force;
    else if (o < 0 || atWar(f.e, o)) {
      G.battles.push({ id: G.nid++, e: f.e, src: -1, dst: f.dst, force: f.force, init: f.force, naval: true, sup: .8, days: 0 });
      if (f.e === 0 || o === 0) A.sfx('battle');
      if (o === 0) toast(`${esc(e.name)} lands troops at <b>${esc(WD.terr[f.dst].name)}</b>`, 'bad');
    } else {
      if (G.owner[f.src] === f.e) G.troops[f.src] += f.force;
      if (f.e === 0) toast('Fleet returned home: the target is no longer hostile', 'info');
    }
  }
}

/* ---------------- troop movement ---------------- */
/** Number of land steps between two own territories, or -1 if not land-connected. */
function landPath(eid, from, to) {
  if (from === to) return 0;
  const seen = new Map([[from, 0]]), q = [from];
  for (let i = 0; i < q.length; i++) {
    const t = q[i], d = seen.get(t);
    for (const n of WD.terr[t].nb) {
      if (seen.has(n) || G.owner[n] !== eid) continue;
      if (n === to) return d + 1;
      seen.set(n, d + 1); q.push(n);
    }
  }
  return -1;
}
function stepMoves() {
  for (let i = G.moves.length - 1; i >= 0; i--) {
    const m = G.moves[i];
    if (G.day < m.arrive) continue;
    G.moves.splice(i, 1);
    if (G.owner[m.to] === m.e) G.troops[m.to] += m.amount;
    else if (G.owner[m.from] === m.e) G.troops[m.from] += m.amount;
  }
}

/* ---------------- player economic actions ---------------- */
function actRecruit(t) {
  const P = PL(), amt = recruitAmt(t, P), cost = amt * CFG.RECRUIT_COST;
  if (G.owner[t] !== 0 || P.treasury < cost) return false;
  P.treasury -= cost; G.troops[t] += amt; A.sfx('build');
  toast(`Recruited <b>${fmtInt(amt)}</b> soldiers in ${esc(WD.terr[t].name)}`, 'good');
  return true;
}
function actBuild(t, kind) {
  const P = PL();
  if (G.owner[t] !== 0) return false;
  if (kind === 'ind') {
    const c = indCost(t); if (P.treasury < c || G.ind[t] >= 100) return false;
    P.treasury -= c; G.ind[t] = Math.min(100, G.ind[t] + 5); toast(`Industry expanded in ${esc(WD.terr[t].name)}`, 'good');
  } else if (kind === 'factory') {
    const c = factoryCost(t);
    if (P.treasury < c || G.fact[t] >= CFG.FACTORY_MAX) return false;
    G.fact[t]++;
    P.treasury -= c;
    toast(`${ic('factory', 14)} Factory upgraded to Tier ${roman(G.fact[t])} in <b>${esc(WD.terr[t].name)}</b>`, 'good');
  } else if (kind === 'fort') {
    const c = fortCost(t); if (P.treasury < c || G.fort[t] >= 3) return false;
    P.treasury -= c; G.fort[t]++; toast(`Fortifications raised to level ${G.fort[t]}`, 'good');
  } else if (kind === 'ship') {
    const c = shipCostOf(P); if (P.treasury < c || !WD.terr[t].coastal) return false;
    P.treasury -= c; P.navy++; toast(`Transport launched. Fleet: <b>${P.navy}</b> ships`, 'good');
  } else if (kind === 'silo') {
    if (P.tech < CFG.MISSILE_TECH || G.silo[t] || P.treasury < CFG.SILO_COST) return false;
    P.treasury -= CFG.SILO_COST; G.silo[t] = 1;
    toast(`Strategic launch site commissioned in <b>${esc(WD.terr[t].name)}</b>`, 'good');
  } else if (kind === 'missile') {
    if (P.tech < CFG.MISSILE_TECH || !G.silo[t] || G.missile[t] >= 3 || P.treasury < CFG.MISSILE_COST) return false;
    P.treasury -= CFG.MISSILE_COST; G.missile[t]++;
    toast(`Missile stockpile increased at <b>${esc(WD.terr[t].name)}</b>`, 'good');
  } else if (kind === 'nuke') {
    if (P.tech < CFG.NUKE_TECH || !G.silo[t] || G.nuke[t] >= 1 || P.treasury < CFG.NUKE_COST) return false;
    P.treasury -= CFG.NUKE_COST; G.nuke[t]++;
    toast(`Nuclear warhead secured at <b>${esc(WD.terr[t].name)}</b>`, 'good');
  }
  A.sfx('build');
  if (R.mode !== 'political') R.fillDirty = true;
  return true;
}
function setColonyPolicy(t, policy) {
  const ix = Object.keys(COLONY_POLICIES).indexOf(policy);
  if (G.owner[t] !== 0 || !G.colony[t] || ix < 0) return false;
  G.colPolicy[t] = ix;
  toast(`${COLONY_POLICIES[policy].name} adopted in <b>${esc(WD.terr[t].name)}</b>`, 'good');
  return true;
}

/* ---------------- diplomacy actions ---------------- */
function declareWar(a, b) {
  if (a === b || atWar(a, b)) return;
  const E = G.empires;
  G.trade[a][b] = G.trade[b][a] = 0;
  if (allied(a, b)) setRel(a, b, 0);
  if (G.truce[a][b] > G.day) for (const o of E) if (o.alive && o.id !== a) adjOp(a, o.id, -10); // breaking a truce angers everyone
  setRel(a, b, 2); G.warStart[a][b] = G.warStart[b][a] = G.day; adjOp(a, b, -50);
  E[a].stats.wars++; E[b].stats.wars++;
  if (b === 0) { toast(`<b>${esc(E[a].name)}</b> has declared war on you`, 'bad'); A.sfx('alarm'); }
  else if (a === 0) toast(`You declared war on <b>${esc(E[b].name)}</b>`, 'bad');
  for (const c of E) {
    if (!c.alive || c.id === a || c.id === b) continue;
    if (allied(b, c.id) && !allied(a, c.id) && !atWar(a, c.id)) {
      setRel(a, c.id, 2); G.warStart[a][c.id] = G.warStart[c.id][a] = G.day; adjOp(a, c.id, -40);
      if (a === 0 || c.id === 0) toast(`${esc(c.name)} honours its alliance and joins the war against ${esc(E[a].name)}`, 'bad');
    }
  }
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
}
function makePeace(a, b) {
  if (!atWar(a, b)) return;
  setRel(a, b, 0); G.truce[a][b] = G.truce[b][a] = G.day + 360; adjOp(a, b, 15);
  for (let i = G.battles.length - 1; i >= 0; i--) {
    const x = G.battles[i], o = G.owner[x.dst];
    if ((x.e === a && o === b) || (x.e === b && o === a)) {
      if (x.src >= 0 && G.owner[x.src] === x.e) G.troops[x.src] += x.force;
      G.battles.splice(i, 1);
    }
  }
  G.offers = G.offers.filter(f => !((f.from === a && b === 0) || (f.from === b && a === 0)));
  if (a === 0 || b === 0) toast(`Peace signed with <b>${esc(G.empires[a === 0 ? b : a].name)}</b>`, 'good');
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
}
function playerOfferPeace(x) {
  const P = PL(), ai = G.empires[x], D = DIFF[G.diff];
  const r = strength(ai) / Math.max(1, strength(P)), dur = G.day - G.warStart[0][x];
  const accept = r < .9 * D.peace || (dur > 240 && Math.random() < .5) || (r < 1.3 * D.peace && Math.random() < .35);
  if (accept) makePeace(0, x); else { adjOp(0, x, -3); toast(`${esc(ai.name)} rejected your peace offer`, 'bad'); }
  return accept;
}
function playerProposeAlliance(x) {
  const P = PL(), ai = G.empires[x];
  const allies = G.empires.filter(o => o.alive && allied(x, o.id)).length;
  const share = P.c.area / WD.landArea;
  const accept = G.op[0][x] > 25 && !atWar(0, x) && allies < 2 && share < .3 && strength(P) < strength(ai) * 3;
  if (accept) { setRel(0, x, 1); adjOp(0, x, 10); toast(`Alliance formed with <b>${esc(ai.name)}</b>`, 'good'); A.sfx('notify'); }
  else toast(`${esc(ai.name)} declined an alliance${G.op[0][x] <= 25 ? ' (relations too cold)' : ''}`, 'bad');
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
  return accept;
}
function playerEnvoy(x) {
  const P = PL(); if (P.treasury < CFG.ENVOY_COST) return false;
  P.treasury -= CFG.ENVOY_COST;
  adjOp(0, x, 12 * (1 - Math.max(0, G.op[0][x]) / 100));
  toast(`Envoy received by ${esc(G.empires[x].name)}. Relations improved.`, 'good');
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
  return true;
}
function playerBreakAlliance(x) {
  if (!allied(0, x)) return;
  setRel(0, x, 0); adjOp(0, x, -35);
  for (const o of G.empires) if (o.alive && o.id > 0 && o.id !== x) adjOp(0, o.id, -5);
  toast(`Alliance with ${esc(G.empires[x].name)} dissolved`, 'bad');
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
}
function tradeCount(eid) {
  return G.trade[eid].reduce((sum, active, id) => sum + (active && G.empires[id].alive ? 1 : 0), 0);
}
function playerTradePact(x) {
  const P = PL(), ai = G.empires[x];
  if (!ai.alive || atWar(0, x) || allied(0, x) || G.trade[0][x] || G.op[0][x] < 0 || tradeCount(0) >= 3 || tradeCount(x) >= 3) return false;
  G.trade[0][x] = G.trade[x][0] = 1;
  adjOp(0, x, 8);
  toast(`Trade pact signed with <b>${esc(ai.name)}</b> · +5% income`, 'good');
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
  return true;
}
function playerEndTrade(x) {
  if (!G.trade[0][x]) return;
  G.trade[0][x] = G.trade[x][0] = 0;
  adjOp(0, x, -8);
  toast(`Trade pact with <b>${esc(G.empires[x].name)}</b> ended`, 'info');
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
}
function offerToPlayer(a, kind) {
  const f = { id: G.nid++, from: a, kind, until: G.day + 60 };
  G.offers.push(f);
  A.sfx('notify');
  const what = kind === 'peace' ? 'a peace treaty' : kind === 'trade' ? 'a trade pact' : 'an alliance';
  toast(`<b>${esc(G.empires[a].name)}</b> proposes ${what}.`, 'info',
    { ttl: 25000, actions: [{ label: 'Accept', act: 'offer', v: f.id + ':1', cls: 'primary' }, { label: 'Decline', act: 'offer', v: f.id + ':0', cls: 'ghost' }] });
}
function respondOffer(id, accept) {
  const i = G.offers.findIndex(f => f.id === id);
  if (i < 0) { toast('That offer has expired', 'info'); return; }
  const f = G.offers[i]; G.offers.splice(i, 1);
  if (!accept) { adjOp(0, f.from, -5); return; }
  if (f.kind === 'peace') makePeace(0, f.from);
  else if (f.kind === 'trade') {
    if (tradeCount(0) < 3 && tradeCount(f.from) < 3 && !atWar(0, f.from)) {
      G.trade[0][f.from] = G.trade[f.from][0] = 1;
      toast(`Trade pact signed with ${esc(G.empires[f.from].name)} · +5% income`, 'good');
    } else toast('Trade pact could not be concluded: one side has reached its treaty limit', 'bad');
  } else { setRel(0, f.from, 1); toast(`Alliance formed with ${esc(G.empires[f.from].name)}`, 'good'); }
  R.fillDirty = R.mode === 'diplomacy' || R.fillDirty;
}
function expireOffers() { G.offers = G.offers.filter(f => f.until >= G.day && G.empires[f.from].alive); }

/* ---------------- victory ---------------- */
function goalProgress() {
  const p = PL(), c = p.c;
  switch (G.goal) {
    case 'territorial': return (c.area / WD.landArea) / .5;
    case 'economic': return (c.gdp / Math.max(1, G.worldGdp)) / .45;
    case 'military': { let tot = 0; for (const e of G.empires) if (e.alive) tot += e.c.troops; return (c.troops / Math.max(1, tot)) / .55; }
    default: return (c.area / WD.landArea) / .97;
  }
}
function checkVictory() {
  if (!PL().alive || G.won) return;
  if (goalProgress() >= 1) { G.won = true; gameOver(true); }
}

/* ---------------- save / load ---------------- */
const TA = { Int8Array, Int16Array, Int32Array, Uint8Array, Float32Array, Float64Array };
const Save = {
  key: s => 'wc_save_' + s,
  save(slot, quiet) {
    if (!G) return false;
    try {
      const data = JSON.stringify({ sig: WD.sig, time: Date.now(), name: PL().name, color: PL().color, day: G.day, diff: G.diff, G },
        (k, v) => ArrayBuffer.isView(v) ? { __t: v.constructor.name, d: Array.from(v) } : v);
      const ok = Store.set(Save.key(slot), data);
      if (!quiet) toast(Store.ok && ok ? 'Game saved' : 'Saved for this session only (browser storage unavailable)', 'good');
      return true;
    } catch (err) { if (!quiet) toast('Save failed: ' + esc(err.message), 'bad'); return false; }
  },
  meta(slot) {
    const s = Store.get(Save.key(slot)); if (!s) return null;
    try { return JSON.parse(s, (k, v) => k === 'G' ? undefined : v); } catch (e) { return null; }
  },
  load(slot) {
    const s = Store.get(Save.key(slot)); if (!s) return false;
    try {
      const o = JSON.parse(s, (k, v) => v && typeof v === 'object' && v.__t && TA[v.__t] ? new TA[v.__t](v.d) : v);
      if (o.sig !== WD.sig) { toast('This save was made with a different map version', 'bad'); return false; }
      G = o.G;
      if (!G.fact || G.fact.length !== WD.T) G.fact = new Uint8Array(WD.T);
      if (!G.colony || G.colony.length !== WD.T) G.colony = new Uint8Array(WD.T);
      if (!G.colPolicy || G.colPolicy.length !== WD.T) G.colPolicy = new Uint8Array(WD.T);
      if (!G.silo || G.silo.length !== WD.T) G.silo = new Uint8Array(WD.T);
      if (!G.missile || G.missile.length !== WD.T) G.missile = new Uint8Array(WD.T);
      if (!G.nuke || G.nuke.length !== WD.T) G.nuke = new Uint8Array(WD.T);
      if (!G.strikes) G.strikes = [];
      if (!G.trade) G.trade = G.empires.map(() => new Uint8Array(G.empires.length));
      for (const e of G.empires) {
        if (!G.trade[e.id]) G.trade[e.id] = new Uint8Array(G.empires.length);
        for (const other of G.empires) if (!G.trade[e.id][other.id]) G.trade[e.id][other.id] = 0;
        if (!e.fin) e.fin = { income: 0, trade: 0, milB: 0, resB: 0, upk: 0, net: 0 };
      }
      G.strikes = G.strikes.filter(s => s && Number.isInteger(s.dst) && Number.isInteger(s.e));
      for (const e of G.empires) if (!DOCTRINES[e.doctrine]) e.doctrine = 'balanced';
      G.speed = 1; pathCache.clear(); markFill();
      return true;
    } catch (e) { toast('Could not read save: ' + esc(e.message), 'bad'); return false; }
  },
  latest() {
    const a = this.meta('manual'), b = this.meta('auto');
    if (!a) return b ? 'auto' : null; if (!b) return 'manual';
    return a.time >= b.time ? 'manual' : 'auto';
  }
};