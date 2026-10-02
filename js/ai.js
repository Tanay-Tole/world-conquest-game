'use strict';
/* =====================================================================
   WORLD CONQUEST — ai.js
   Modular AI controller. Each AI empire "thinks" every DIFF.think days:
     observe → threat assessment → consolidation → opportunity scoring
     → land attacks → naval invasions → economy
   Diplomacy runs monthly for all AIs. Difficulty changes decision
   quality, reaction speed, aggression, economic efficiency and naval
   use. It never directly multiplies army strength.
   ===================================================================== */

/* ---------------- ThreatAssessment / ExpansionSystem / MilitaryAI ---------------- */
function aiThink(e) {
  const D = DIFF[G.diff], T = WD.T, id = e.id, own = G.owner, tro = G.troops, hardish = G.diff === 'hard' || G.diff === 'brutal';
  const mine = [];
  for (let t = 0; t < T; t++) if (own[t] === id) mine.push(t);
  if (!mine.length) return;

  // observe & assess threats on each border territory
  const thr = new Map(), border = [];
  for (const t of mine) {
    let th = 0, b = false;
    for (const n of WD.terr[t].nb) {
      const o = own[n]; if (o === id) continue;
      b = true;
      if (o >= 0 && atWar(id, o)) th += tro[n] * G.empires[o].tech;
    }
    thr.set(t, th); if (b) border.push(t);
  }
  let wars = 0;
  for (const o of G.empires) if (o.alive && o.id !== id && atWar(id, o.id)) wars++;

  // EconomyAI policy
  if (G.diff !== 'easy') { e.mil = wars ? .42 : .26; e.research = e.treasury > 800 ? .14 : .07; }

  // consolidation: interior troops flow toward the frontier along a distance gradient
  if (Math.random() < D.consol && border.length && border.length < mine.length) {
    const fd = new Map(), q = [];
    for (const t of border) { fd.set(t, 0); q.push(t); }
    for (let i = 0; i < q.length; i++) {
      const t = q[i], d = fd.get(t);
      for (const n of WD.terr[t].nb) if (own[n] === id && !fd.has(n)) { fd.set(n, d + 1); q.push(n); }
    }
    for (const t of mine) {
      const d = fd.get(t); if (!d) continue;
      const amt = (tro[t] - minGar(t)) * .85; if (amt < 800) continue;
      let best = -1, bs = -1e18;
      for (const n of WD.terr[t].nb) {
        if (own[n] !== id) continue;
        const dn = fd.get(n); if (dn === undefined || dn >= d) continue;
        const sc = hardish ? (thr.get(n) || 0) + Math.random() : Math.random();
        if (sc > bs) { bs = sc; best = n; }
      }
      if (best >= 0) { tro[t] -= amt; G.moves.push({ id: G.nid++, e: id, from: t, to: best, amount: amt, arrive: G.day + 1, ai: 1 }); }
    }
  }

  // opportunity scoring for land attacks
  const cands = [];
  for (const s of border) {
    const reserve = (thr.get(s) || 0) * (G.diff === 'easy' ? .3 : .65);
    const avail = tro[s] - reserve - minGar(s) * .5;
    if (avail < 600) continue;
    const mult = attMult(e, s, false);
    for (const n of WD.terr[s].nb) {
      const o = own[n];
      if (o === id || (o >= 0 && !atWar(id, o))) continue;
      const dp = defPow(n), ratio = avail * mult / Math.max(dp, 1);
      const need = D.minAdv * (1 + (Math.random() - .5) * 2 * D.mistakes);
      if (ratio < need) continue;
      let val = Math.sqrt(G.pop[n]) / 60 + G.ind[n] * .4 + G.fact[n] * 15 + popc(G.res[n]) * 12 + (o >= 0 ? 15 : 0)
        + (o >= 0 && G.empires[o].capital === n ? 30 : 0);
      if (o === 0 && hardish) val *= 1.35;                         // reacting to the player
      const sc = val * Math.min(ratio, 3) / (1 + dp / 60000) * (1 + Math.random() * D.mistakes * 4);
      cands.push({ s, n, dp, mult, avail, sc });
    }
  }
  cands.sort((a, b) => b.sc - a.sc);
  const usedS = new Set(), usedN = new Set();
  let launched = 0;
  for (const c of cands) {
    if (launched >= D.attacks) break;
    if (usedS.has(c.s) || usedN.has(c.n)) continue;            // spread across fronts
    let force;
    if (G.diff === 'easy') force = c.avail * (.45 + Math.random() * .5);
    else {
      force = Math.min(c.avail, c.dp / c.mult * (D.over[0] + Math.random() * (D.over[1] - D.over[0])));
      if (force * c.mult < c.dp * 1.02) continue;
    }
    if (launchAttack(e, c.s, c.n, force)) { launched++; usedS.add(c.s); usedN.add(c.n); }
  }

  // NavalAI
  if (e.navy - e.busy > 0 && (launched === 0 || Math.random() < D.naval)) aiNaval(e, mine);
  aiStrategicWeapons(e, mine);
  aiEconomy(e, mine, border, thr, wars);
}

function aiStrategicWeapons(e, mine) {
  if (e.tech < CFG.MISSILE_TECH) return;
  const launchSites = mine.filter(t => G.silo[t] > 0);
  if (launchSites.length) {
    let best = null, bs = -1;
    for (const src of launchSites) {
      const nuclear = G.nuke[src] > 0 && e.tech >= CFG.NUKE_TECH;
      if (!G.missile[src] && !nuclear) continue;
      const range = missileRange(e, nuclear);
      for (let dst = 0; dst < WD.T; dst++) {
        const owner = G.owner[dst];
        if (owner < 0 || owner === e.id || !atWar(e.id, owner)) continue;
        const distance = territoryDistance(src, dst);
        if (distance > range) continue;
        const enemy = G.empires[owner], capital = enemy.capital === dst;
        const useNuclear = nuclear && (capital || e.morale < .78 || strength(e) < strength(enemy) * .7);
        if (useNuclear && !nuclear) continue;
        if (!useNuclear && !G.missile[src]) continue;
        const score = (capital ? 100 : 0) + G.fact[dst] * 10 + G.fort[dst] * 4 + G.troops[dst] / 3000 - distance / 1200;
        if (score > bs) { bs = score; best = { src, dst, kind: useNuclear ? 'nuke' : 'missile' }; }
      }
    }
    if (best) launchStrategicStrike(e, best.src, best.dst, best.kind);
  }
}

/* ---------------- NavalAI ---------------- */
function aiNaval(e, mine) {
  const D = DIFF[G.diff], free = e.navy - e.busy, id = e.id, range = navalRange(e);
  const srcs = mine.filter(t => WD.terr[t].coastal && G.troops[t] > 3000).sort((a, b) => G.troops[b] - G.troops[a]).slice(0, 3);
  for (const s of srcs) {
    const S_ = WD.terr[s], mult = attMult(e, s, true), avail = Math.min(G.troops[s] * .75, free * CFG.SHIP_CAP);
    let best = -1, bs = 0;
    for (const n of WD.coastal) {
      const o = G.owner[n];
      if (o === id || (o >= 0 && !atWar(id, o))) continue;
      if (WD.adjSet.has(pairKey(s, n))) continue;            // land neighbours are attacked by land
      const N_ = WD.terr[n]; let dx = Math.abs(N_.ax - S_.ax); dx = Math.min(dx, WD.MW - dx);
      const d = Math.hypot(dx, N_.ay - S_.ay);
      if (d < 4 || d > range * CFG.CELL * .8) continue;
      const dp = defPow(n);
      if (avail * mult < dp * D.minAdv * 1.2) continue;
      const val = (Math.sqrt(G.pop[n]) / 60 + G.ind[n] * .4 + G.fact[n] * 15 + popc(G.res[n]) * 12 + (o < 0 ? 10 : 20)
        + (o >= 0 && G.empires[o].capital === n ? 30 : 0)) / (1 + d / 300) / (1 + dp / 60000);
      if (val > bs) { bs = val; best = n; }
    }
    if (best < 0) continue;
    const path = seaPath(s, best, range);
    if (!path) continue;
    const dp = defPow(best), force = Math.min(avail, dp / mult * (D.over[0] + .4));
    if (launchFleet(e, s, best, force, path)) return;
  }
}

/* ---------------- EconomyAI ---------------- */
function aiEconomy(e, mine, border, thr, wars) {
  const shipCost = shipCostOf(e);
  for (const t of mine) if (G.colony[t]) G.colPolicy[t] = e.treasury < 250 ? 1 : 0;
  const capital = e.capital;
  if (e.tech >= CFG.MISSILE_TECH && capital >= 0 && !G.silo[capital] && e.treasury > CFG.SILO_COST * 1.8) {
    e.treasury -= CFG.SILO_COST; G.silo[capital] = 1; return;
  }
  if (e.tech >= CFG.MISSILE_TECH) {
    const base = mine.find(t => G.silo[t] && G.missile[t] < 3);
    if (base !== undefined && e.treasury > CFG.MISSILE_COST * 2.5) {
      e.treasury -= CFG.MISSILE_COST; G.missile[base]++; return;
    }
  }
  if (e.tech >= CFG.NUKE_TECH) {
    const base = mine.find(t => G.silo[t] && !G.nuke[t]);
    if (base !== undefined && e.treasury > CFG.NUKE_COST * 3) {
      e.treasury -= CFG.NUKE_COST; G.nuke[base]++; return;
    }
  }
  const want = e.c.coastal ? Math.ceil(1 + (e.c.coastal / Math.max(1, e.c.terr)) * 5 * e.ai.naval * (G.diff === 'easy' ? .5 : 1) + e.c.terr / 25) : 0;
  if (e.navy < want && e.treasury > shipCost * 1.5) { e.treasury -= shipCost; e.navy++; return; }
  if (wars && e.treasury > 250 && border.length) {
    let bt = border[0], bv = -1;
    for (const t of border) { const v = thr.get(t) || 0; if (v > bv) { bv = v; bt = t; } }
    const amt = Math.round(capOf(bt, e) * .12), cost = amt * CFG.RECRUIT_COST;
    if (e.treasury > cost * 1.5) { e.treasury -= cost; G.troops[bt] += amt; return; }
  }
  if (e.treasury > 350) {
    let bt = -1, bv = 0;
    for (const t of mine) {
      if (G.fact[t] >= CFG.FACTORY_MAX) continue;
      const value = G.pop[t] / (1 + G.fact[t]);
      if (value > bv) { bv = value; bt = t; }
    }
    if (bt >= 0) {
      const cost = factoryCost(bt);
      if (e.treasury > Math.max(500, cost * 1.6)) { e.treasury -= cost; G.fact[bt]++; return; }
    }
  }
  if (e.treasury > 300) {
    let bt = -1, bv = 0;
    for (const t of mine) { if (G.ind[t] >= 95) continue; const v = G.pop[t] * (100 - G.ind[t]); if (v > bv) { bv = v; bt = t; } }
    if (bt >= 0) { const cost = indCost(bt); if (e.treasury > cost * 1.6) { e.treasury -= cost; G.ind[bt] = Math.min(100, G.ind[bt] + 5); } }
  }
}

/* ---------------- DiplomacyAI ---------------- */
function empireBorders() {
  const sets = G.empires.map(() => new Set());
  for (let t = 0; t < WD.T; t++) {
    const o = G.owner[t]; if (o < 0) continue;
    for (const u of WD.terr[t].nb) { const p = G.owner[u]; if (p >= 0 && p !== o) sets[o].add(p); }
  }
  return sets;
}
function aiDiplomacy() {
  const E = G.empires, D = DIFF[G.diff], bd = empireBorders(), str = E.map(strength);
  const P = E[0], pShare = P.alive ? P.c.area / WD.landArea : 0, hardish = G.diff === 'hard' || G.diff === 'brutal';
  // opinion drift: borders breed friction, a growing player breeds suspicion, shared enemies breed friendship
  for (let a = 0; a < E.length; a++) for (let b = a + 1; b < E.length; b++) {
    if (!E[a].alive || !E[b].alive) continue;
    let d = -G.op[a][b] * .03;
    if (bd[a].has(b)) d -= 1.2;
    if (atWar(a, b)) d -= 2;
    if (a === 0 && pShare > .15) d -= pShare * 6;
    for (const c of E) if (c.alive && c.id !== a && c.id !== b && atWar(a, c.id) && atWar(b, c.id)) { d += 4; break; }
    adjOp(a, b, d);
  }
  for (const e of E) {
    if (!e.alive || e.player) continue;
    const a = e.id, wars = E.filter(o => o.alive && o.id !== a && atWar(a, o.id));
    // seek peace when losing or exhausted
    for (const o of wars) {
      const dur = G.day - G.warStart[a][o.id], r = str[a] / Math.max(1, str[o.id]);
      if (dur > 90 && (r < .7 || (dur > 720 && Math.random() < .25))) {
        if (o.player) { if (!G.offers.some(f => f.from === a)) offerToPlayer(a, 'peace'); }
        else if (str[o.id] / Math.max(1, str[a]) < 1.5 || Math.random() < .3) makePeace(a, o.id);
      }
    }
    // declare war on a weaker neighbour
    if (wars.length < D.maxWars && Math.random() < e.ai.aggr * .55) {
      let best = -1, br = 0;
      for (const b of bd[a]) {
        if (!E[b].alive || atWar(a, b) || allied(a, b) || G.truce[a][b] > G.day) continue;
        let r = str[a] / Math.max(1, str[b]);
        if (G.op[a][b] < -35) r *= 1.25;
        if (b === 0 && pShare > .2 && hardish) r *= 1.3;
        if (r > br) { br = r; best = b; }
      }
      if (best >= 0 && br > D.warRatio) declareWar(a, best);
    }
    // coalition against an overwhelming neighbour
    if (G.diff !== 'easy') {
      const nAllies = E.filter(o => o.alive && allied(a, o.id)).length;
      if (nAllies < 2) for (const b of bd[a]) {
        if (str[b] <= str[a] * 1.8) continue;
        for (const c of E) {
          if (!c.alive || c.player || c.id === a || c.id === b || G.rel[a][c.id] !== 0) continue;
          if (bd[c.id].has(b) && G.op[a][c.id] > -20) {
            setRel(a, c.id, 1); adjOp(a, c.id, 20);
            if (b === 0) toast(`<b>${esc(e.name)}</b> and <b>${esc(c.name)}</b> have allied against you`, 'bad');
            break;
          }
        }
        break;
      }
    }
    if (!atWar(a, 0) && !allied(a, 0) && !G.trade[a][0] && G.op[a][0] > 32 &&
        tradeCount(a) < 3 && tradeCount(0) < 3 && !G.offers.some(f => f.from === a && f.kind === 'trade')) {
      if (Math.random() < .3) {
        if (P.alive) offerToPlayer(a, 'trade');
      }
    }
  }
  if (R.mode === 'diplomacy') R.fillDirty = true;
}