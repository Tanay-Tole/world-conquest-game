'use strict';
/* =====================================================================
   WORLD CONQUEST — render.js
   Camera, layered canvas renderer, map modes, hit testing, map input.
   Layers:
     fillCv  – world-sized raster (one pixel per world unit) of territory
               colours + border shading; recomposed only when needed.
     base    – screen canvas: ocean, graticule, raster, vector coasts and
               borders, island markers, empire labels. Re-rendered only on
               camera change or recomposition.
     over    – screen canvas redrawn every frame: hover/selection masks,
               battles, fleets, capitals, troop labels.
   ===================================================================== */

/** Shared UI state (also used by ui.js). */
const UI = {
  sel: -1, hover: -1, preview: null, movePv: null, mode: null, build: false, drawer: null, lock: false,
  pick: -1, setup: { diff: 'normal', goal: 'conquest', doctrine: 'vanguard' }, found: { name: '', color: PLAYER_COLORS[0], emblem: 'star' },
  statTab: 'terr', resume: 0, modal: null, backTo: null, lastFrac: .7, t1: 0, t2: 0,
  reset() { this.sel = -1; this.hover = -1; this.preview = null; this.movePv = null; this.mode = null; this.build = false; }
};

const R = {
  base: null, bctx: null, over: null, octx: null, dpr: 1, vw: 0, vh: 0,
  fillCv: null, fctx: null, fimg: null, f32: null,
  lut: null, lutT: null, lutB: null, lutC: null,
  mode: 'political', baseDirty: true, fillDirty: true, lastCompose: 0, lastBase: 0,
  masks: new Map(), labels: [], labelsDirty: true, flashes: [], oceanGrad: null
};
const cam = { x: 0, y: 0, s: 1, ts: 1, s0: 1, ax: 0, ay: 0, wx: 0, wy: 0, anim: false, fly: null, ready: false };

function initRender() {
  R.base = $('#base'); R.over = $('#over');
  R.bctx = R.base.getContext('2d'); R.octx = R.over.getContext('2d');
  R.fillCv = document.createElement('canvas'); R.fillCv.width = WD.MW; R.fillCv.height = WD.MH;
  R.fctx = R.fillCv.getContext('2d');
  R.fimg = R.fctx.createImageData(WD.MW, WD.MH);
  R.f32 = new Uint32Array(R.fimg.data.buffer);
  const T = WD.T;
  R.lut = new Uint32Array(T); R.lutT = new Uint32Array(T); R.lutB = new Uint32Array(T); R.lutC = new Uint32Array(T);
  const g = R.bctx.createRadialGradient(WD.MW / 2, WD.MH / 2, 0, WD.MW / 2, WD.MH / 2, WD.MW * .58);
  g.addColorStop(0, '#11253a'); g.addColorStop(.55, '#0b1a2a'); g.addColorStop(1, '#07111c');
  R.oceanGrad = g;
  resize();
  window.addEventListener('resize', resize);
  bindMapInput();
}

function resize() {
  R.dpr = Math.min(window.devicePixelRatio || 1, 2);
  R.vw = window.innerWidth; R.vh = window.innerHeight;
  for (const c of [R.base, R.over]) { c.width = Math.round(R.vw * R.dpr); c.height = Math.round(R.vh * R.dpr); }
  const z = cam.ready ? cam.s / cam.s0 : 1;
  cam.s0 = Math.min(R.vw / WD.MW, R.vh / WD.MH) * .98;
  if (!cam.ready) { fitCamera(); cam.ready = true; }
  else { cam.s = cam.ts = cam.s0 * z; clampCam(); }
  R.baseDirty = true;
}

/* ---------------- camera ---------------- */
function fitCamera() {
  cam.s = cam.ts = cam.s0; cam.anim = false; cam.fly = null;
  cam.x = (R.vw - WD.MW * cam.s) / 2; cam.y = (R.vh - WD.MH * cam.s) / 2;
  R.baseDirty = true;
}
function clampCam() {
  const mw = WD.MW * cam.s, mh = WD.MH * cam.s;
  cam.x = mw <= R.vw ? (R.vw - mw) / 2 : clamp(cam.x, R.vw - mw - R.vw * .3, R.vw * .3);
  cam.y = mh <= R.vh ? (R.vh - mh) / 2 : clamp(cam.y, R.vh - mh - R.vh * .3, R.vh * .3);
  if (cam.anim) { cam.wx = (cam.ax - cam.x) / cam.s; cam.wy = (cam.ay - cam.y) / cam.s; }
}
function zoomAt(sx, sy, f) {
  cam.fly = null;
  const ns = clamp(cam.ts * f, cam.s0 * .9, cam.s0 * 40);
  cam.wx = (sx - cam.x) / cam.s; cam.wy = (sy - cam.y) / cam.s;
  cam.ax = sx; cam.ay = sy; cam.ts = ns; cam.anim = true;
}
function flyTo(wx, wy, z) {
  const ts = clamp(cam.s0 * z, cam.s0 * .9, cam.s0 * 40);
  cam.fly = { t: 0, d: 1, s0: cam.s, s1: ts, cx0: (R.vw / 2 - cam.x) / cam.s, cy0: (R.vh / 2 - cam.y) / cam.s, cx1: wx, cy1: wy };
  cam.anim = false;
}
function flyToTerr(t, z) { const tr = WD.terr[t]; flyTo(tr.ax + .5, tr.ay + .5, z || Math.max(cam.s / cam.s0, 3)); }
function updateCamera(dt) {
  if (cam.fly) {
    const f = cam.fly; f.t += dt;
    const k = Math.min(1, f.t / f.d), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    cam.s = cam.ts = Math.exp(lerp(Math.log(f.s0), Math.log(f.s1), e));
    cam.x = R.vw / 2 - lerp(f.cx0, f.cx1, e) * cam.s; cam.y = R.vh / 2 - lerp(f.cy0, f.cy1, e) * cam.s;
    clampCam(); R.baseDirty = true;
    if (k >= 1) cam.fly = null;
    return;
  }
  if (!cam.anim) return;
  const k = 1 - Math.exp(-dt * 16);
  cam.s += (cam.ts - cam.s) * k;
  if (Math.abs(cam.ts - cam.s) < cam.ts * .001) { cam.s = cam.ts; cam.anim = false; }
  cam.x = cam.ax - cam.wx * cam.s; cam.y = cam.ay - cam.wy * cam.s;
  clampCam(); R.baseDirty = true;
}
/** Slow cinematic drift behind the main menu. */
function menuDrift(now) {
  const t = now / 1000, s = cam.s0 * 1.4;
  const cx = WD.MW * .5 + Math.sin(t * .035) * WD.MW * .14, cy = WD.MH * .44 + Math.sin(t * .027) * WD.MH * .07;
  cam.s = cam.ts = s; cam.x = R.vw * .62 - cx * s; cam.y = R.vh * .5 - cy * s;
  if (now - R.lastBase > 33) R.baseDirty = true;
}
const w2s = (x, y) => [x * cam.s + cam.x, y * cam.s + cam.y];

/* ---------------- colouring ---------------- */
function tColor(t) {
  const tr = WD.terr[t], j = 1 + (tr.h - .5) * .12, o = G ? G.owner[t] : -1;
  const mode = G ? R.mode : 'political';
  switch (mode) {
    case 'population': return ramp(RAMP_POP, Math.log10(G.pop[t] / (tr.area * WD.km2) + 1) / 3.2);
    case 'economy': return ramp(RAMP_ECO, Math.log10(gdpOf(t) + 1) / 3);
    case 'military': return ramp(RAMP_MIL, Math.log10(G.troops[t] + 1) / 6);
    case 'resources': {
      const r = G.res[t]; if (!r) return [34, 38, 42];
      for (const k of [5, 2, 4, 1, 3, 0]) if (r >> k & 1) { const m = .55 + .15 * popc(r); return hex2rgb(RES[k].c).map(v => v * m); }
      return [34, 38, 42];
    }
    case 'diplomacy': {
      if (o < 0) return [38, 42, 46];
      if (o === 0) return G.empires[0].rgb;
      return hex2rgb(ST_COL[relStatus(0, o)]).map(v => v * .85);
    }
    default: {
      const c = o < 0 ? TCOL[tr.terrain] : G.empires[o].rgb;
      return [c[0] * j, c[1] * j, c[2] * j];
    }
  }
}
function buildLUT() {
  const pol = !G || R.mode === 'political';
  for (let t = 0; t < WD.T; t++) {
    const c = tColor(t), r = c[0], g = c[1], b = c[2];
    R.lut[t] = pack(r | 0, g | 0, b | 0);
    R.lutT[t] = pack((r * .8) | 0, (g * .8) | 0, (b * .8) | 0);
    R.lutC[t] = pack((r * .9) | 0, (g * .9) | 0, (b * .9) | 0);
    if (G && pol && G.owner[t] === 0) R.lutB[t] = pack((r + (255 - r) * .6) | 0, (g + (255 - g) * .6) | 0, (b + (255 - b) * .6) | 0);
    else R.lutB[t] = pack((r * .42) | 0, (g * .42) | 0, (b * .42) | 0);
  }
}
/** Recompose the territory raster (single pass over all pixels). */
function compose() {
  buildLUT();
  const MW = WD.MW, MH = WD.MH, tm = WD.tmap, own = G ? G.owner : null, d = R.f32;
  const lut = R.lut, lb = R.lutB, lt = R.lutT, lc = R.lutC;
  let i = 0;
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++, i++) {
      const t = tm[i];
      if (t < 0) { d[i] = 0; continue; }
      const tr = x < MW - 1 ? tm[i + 1] : -2, td = y < MH - 1 ? tm[i + MW] : -2, tl = x > 0 ? tm[i - 1] : -2, tu = y > 0 ? tm[i - MW] : -2;
      let c = lut[t];
      if (own) {
        const o = own[t];
        if ((tr >= 0 && own[tr] !== o) || (td >= 0 && own[td] !== o) || (tl >= 0 && own[tl] !== o) || (tu >= 0 && own[tu] !== o)) { d[i] = lb[t]; continue; }
      }
      if ((tr >= 0 && tr !== t) || (td >= 0 && td !== t)) c = lt[t];
      else if (tr === -1 || td === -1 || tl === -1 || tu === -1) c = lc[t];
      d[i] = c;
    }
  }
  R.fctx.putImageData(R.fimg, 0, 0);
  if (G && R.labelsDirty) computeLabels();
  R.fillDirty = false; R.baseDirty = true; R.lastCompose = performance.now();
}
const markFill = () => { R.fillDirty = true; R.labelsDirty = true; };
function setMapMode(m) { R.mode = m; R.fillDirty = true; }

/** Empire name labels at the area-weighted centre of each empire's largest contiguous block. */
function computeLabels() {
  R.labels = []; R.labelsDirty = false;
  if (!G) return;
  const T = WD.T, own = G.owner, seen = new Uint8Array(T);
  for (const e of G.empires) {
    if (!e.alive) continue;
    let best = null;
    for (let t = 0; t < T; t++) {
      if (own[t] !== e.id || seen[t]) continue;
      const q = [t]; seen[t] = 1; let Ar = 0, sx = 0, sy = 0;
      for (let i = 0; i < q.length; i++) {
        const u = q[i], tr = WD.terr[u];
        Ar += tr.area; sx += (tr.ax + .5) * tr.area; sy += (tr.ay + .5) * tr.area;
        for (const n of tr.nb) if (!seen[n] && own[n] === e.id) { seen[n] = 1; q.push(n); }
      }
      if (!best || Ar > best.A) best = { A: Ar, x: sx / Ar, y: sy / Ar };
    }
    if (best && best.A >= 120) R.labels.push({ e, x: best.x, y: best.y, A: best.A, size: clamp(Math.sqrt(best.A) * .24, 3, 44) });
  }
}

/* ---------------- base layer ---------------- */
function renderBase() {
  const c = R.bctx, dpr = R.dpr, s = cam.s, z = cam.s / cam.s0, P = WD.P;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#05080d'; c.fillRect(0, 0, R.base.width, R.base.height);
  c.setTransform(dpr * s, 0, 0, dpr * s, dpr * cam.x, dpr * cam.y);
  c.fillStyle = R.oceanGrad; c.fill(P.sphere);
  c.lineWidth = 1 / s; c.strokeStyle = 'rgba(120,165,210,.07)'; c.stroke(P.grat);
  const hi = z >= 2, coast = hi ? P.coastHi : P.coastLo, bord = hi ? P.bordHi : P.bordLo;
  c.strokeStyle = 'rgba(70,140,200,.10)'; c.lineWidth = 6 / s; c.stroke(coast);
  if (hi) {
    c.save(); c.fillStyle = '#262b27'; c.fill(P.landHi); c.clip(P.landHi);
    c.imageSmoothingEnabled = false; c.drawImage(R.fillCv, 0, 0); c.restore();
  } else {
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(R.fillCv, 0, 0);
  }
  c.lineWidth = (hi ? 1 : .7) / s; c.strokeStyle = 'rgba(190,215,235,.28)'; c.stroke(coast);
  c.lineWidth = .6 / s; c.strokeStyle = 'rgba(230,230,220,.13)'; c.stroke(bord);
  c.lineWidth = 1.2 / s; c.strokeStyle = 'rgba(150,180,210,.22)'; c.stroke(P.sphere);
  // island markers keep tiny playable islands visible when zoomed out
  if (z < 5) {
    c.lineWidth = 1.3 / s;
    for (const t of WD.smallList) {
      const tr = WD.terr[t], o = G ? G.owner[t] : -1;
      c.strokeStyle = o >= 0 ? G.empires[o].color : 'rgba(200,212,222,.55)';
      c.beginPath(); c.arc(tr.ax + .5, tr.ay + .5, 3.2 / s, 0, 6.2832); c.stroke();
    }
  }
  if (G && R.mode === 'political' && S.names) drawEmpireLabels(c, s);
  R.baseDirty = false; R.lastBase = performance.now();
}
function drawEmpireLabels(c, s) {
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const L of R.labels) {
    let fs = L.size;
    const px = fs * s; if (px < 9) continue;
    const alpha = px > 70 ? Math.max(0, 1 - (px - 70) / 50) : 1; if (alpha <= 0) continue;
    const txt = L.e.name.toUpperCase();
    c.font = `700 ${fs}px Cinzel, Georgia, serif`;
    try { c.letterSpacing = (fs * .18) + 'px'; } catch (e) { /* unsupported */ }
    const w = c.measureText(txt).width, maxW = Math.sqrt(L.A) * 1.7;
    if (w > maxW) { fs *= maxW / w; c.font = `700 ${fs}px Cinzel, Georgia, serif`; if (fs * s < 8) continue; }
    c.globalAlpha = alpha;
    c.lineWidth = fs * .14; c.strokeStyle = 'rgba(0,0,0,.45)'; c.strokeText(txt, L.x, L.y);
    c.fillStyle = 'rgba(255,248,230,.66)'; c.fillText(txt, L.x, L.y);
  }
  c.globalAlpha = 1;
  try { c.letterSpacing = '0px'; } catch (e) { /* unsupported */ }
}

/* ---------------- per-territory masks (highlight sprites) ---------------- */
function mask(t, rgb, key) {
  const k = t + '|' + key; let m = R.masks.get(k); if (m) return m;
  const tr = WD.terr[t], w = tr.x1 - tr.x0 + 1, h = tr.y1 - tr.y0 + 1;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d'), im = cx.createImageData(w, h), d = new Uint32Array(im.data.buffer);
  const fillC = pack(rgb[0], rgb[1], rgb[2], 80), edgeC = pack(rgb[0], rgb[1], rgb[2], 255);
  const { tmap, MW, tPixStart, tPix } = WD;
  for (let j = tPixStart[t]; j < tPixStart[t + 1]; j++) {
    const i = tPix[j], x = i % MW, y = (i - x) / MW;
    const edge = x === 0 || tmap[i - 1] !== t || x === MW - 1 || tmap[i + 1] !== t || tmap[i - MW] !== t || tmap[i + MW] !== t;
    d[(y - tr.y0) * w + (x - tr.x0)] = edge ? edgeC : fillC;
  }
  cx.putImageData(im, 0, 0);
  m = { cv, x: tr.x0, y: tr.y0 };
  if (R.masks.size > 500) R.masks.clear();
  R.masks.set(k, m);
  return m;
}
function flash(t) { R.flashes.push({ t, until: performance.now() + 750 }); }

/* ---------------- overlay ---------------- */
function pill(c, x, y, text, col) {
  c.font = '600 10px "JetBrains Mono", monospace';
  const w = c.measureText(text).width + 10;
  c.fillStyle = 'rgba(7,11,17,.88)'; c.strokeStyle = col; c.lineWidth = 1;
  c.beginPath(); if (c.roundRect) c.roundRect(x - w / 2, y - 8, w, 16, 2); else c.rect(x - w / 2, y - 8, w, 16);
  c.fill(); c.stroke();
  c.fillStyle = '#f2f5f8'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, x, y + .5);
}
function arrowS(c, x1, y1, x2, y2, col, w, now, dashed = true) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
  if (L < 4) return [x2, y2];
  const nx = -dy / L, ny = dx / L, bend = Math.min(40, L * .18);
  const qx = (x1 + x2) / 2 + nx * bend, qy = (y1 + y2) / 2 + ny * bend;
  c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo(qx, qy, x2, y2);
  c.setLineDash([]); c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = w + 2.5; c.stroke();
  if (dashed) { c.setLineDash([9, 6]); c.lineDashOffset = -now / 35; }
  c.strokeStyle = col; c.lineWidth = w; c.stroke(); c.setLineDash([]);
  const a = Math.atan2(y2 - qy, x2 - qx), hs = 5 + w * 1.6;
  c.fillStyle = col; c.beginPath(); c.moveTo(x2, y2);
  c.lineTo(x2 - hs * Math.cos(a - .45), y2 - hs * Math.sin(a - .45));
  c.lineTo(x2 - hs * Math.cos(a + .45), y2 - hs * Math.sin(a + .45));
  c.closePath(); c.fill(); c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 1; c.stroke();
  return [(x1 + 2 * qx + x2) / 4, (y1 + 2 * qy + y2) / 4];
}
function star(c, x, y, r, fill) {
  c.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  c.closePath(); c.fillStyle = fill; c.fill(); c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = 1.2; c.stroke();
}
const cellXY = cell => { const GW = WD.grid.GW, x = cell % GW; return [x * CFG.CELL + CFG.CELL / 2, (cell - x) / GW * CFG.CELL + CFG.CELL / 2]; };
/** Draw a sea path (array of cells) from index `from`, breaking at antimeridian wraps. */
function drawSeaPath(c, path, from, col, now) {
  c.beginPath(); let prev = null;
  for (let i = Math.max(0, Math.floor(from)); i < path.length; i++) {
    const [wx, wy] = cellXY(path[i]), [sx, sy] = w2s(wx, wy);
    if (!prev || Math.abs(sx - prev[0]) > WD.MW * cam.s * .4) c.moveTo(sx, sy); else c.lineTo(sx, sy);
    prev = [sx, sy];
  }
  c.setLineDash([2, 5]); c.lineDashOffset = -now / 60; c.strokeStyle = col; c.lineWidth = 1.6; c.stroke(); c.setLineDash([]);
}
function drawShip(c, sx, sy, ang, col) {
  c.save(); c.translate(sx, sy); c.rotate(ang);
  c.beginPath(); c.moveTo(-8, -3.5); c.lineTo(6, -3.5); c.lineTo(10, 0); c.lineTo(6, 3.5); c.lineTo(-8, 3.5); c.closePath();
  c.fillStyle = col; c.fill(); c.strokeStyle = 'rgba(0,0,0,.8)'; c.lineWidth = 1.2; c.stroke();
  c.beginPath(); c.moveTo(-1, 0); c.lineTo(4, 0); c.strokeStyle = 'rgba(255,255,255,.7)'; c.stroke();
  c.restore();
}

function drawOverlay(now) {
  const c = R.octx, dpr = R.dpr, s = cam.s, z = s / cam.s0;
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, R.over.width, R.over.height);
  /* ---- world-space highlight sprites ---- */
  c.setTransform(dpr * s, 0, 0, dpr * s, dpr * cam.x, dpr * cam.y);
  c.imageSmoothingEnabled = z < 2;
  const draw = (m, a) => { c.globalAlpha = a; c.drawImage(m.cv, m.x, m.y); };
  R.flashes = R.flashes.filter(f => f.until > now);
  for (const f of R.flashes) draw(mask(f.t, [255, 255, 255], 'w'), (f.until - now) / 750 * .9);
  if (STATE === 'pick' && UI.pick >= 0) draw(mask(UI.pick, hex2rgb(UI.found.color), 'p' + UI.found.color), .75 + .25 * Math.sin(now / 250));
  if (STATE === 'game' && G) {
    if (UI.sel >= 0 && G.owner[UI.sel] === 0 && !UI.preview && !UI.movePv && UI.mode !== 'move') {
      for (const n of WD.terr[UI.sel].nb) { const o = G.owner[n]; if (o !== 0 && (o < 0 || G.rel[0][o] !== 1)) draw(mask(n, [255, 120, 90], 'tgt'), .55); }
    }
    if (UI.preview) draw(mask(UI.preview.dst, [255, 90, 70], 'dst'), .6 + .3 * Math.sin(now / 180));
    if (UI.movePv) draw(mask(UI.movePv.to, [120, 210, 255], 'mv'), .6 + .3 * Math.sin(now / 180));
    if (UI.sel >= 0) draw(mask(UI.sel, [240, 212, 140], 'sel'), .7 + .3 * Math.sin(now / 260));
  }
  if (UI.hover >= 0 && UI.hover !== UI.sel) draw(mask(UI.hover, [255, 255, 255], 'h'), .45);
  c.globalAlpha = 1;

  /* ---- screen-space elements ---- */
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = R.vw, vh = R.vh, onScr = (x, y, m = 40) => x > -m && y > -m && x < vw + m && y < vh + m;
  // hover ring for tiny islands
  if (UI.hover >= 0 && WD.terr[UI.hover].area <= 12) {
    const tr = WD.terr[UI.hover], [x, y] = w2s(tr.ax + .5, tr.ay + .5);
    c.beginPath(); c.arc(x, y, 9, 0, 6.2832); c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5; c.stroke();
  }
  if (STATE === 'game' && G) {
    const E = G.empires;
    // player troop movements
    for (const m of G.moves) {
      if (m.e !== 0 || m.ai) continue;
      const a = WD.terr[m.from], b = WD.terr[m.to];
      const [x1, y1] = w2s(a.ax + .5, a.ay + .5), [x2, y2] = w2s(b.ax + .5, b.ay + .5);
      arrowS(c, x1, y1, x2, y2, 'rgba(140,210,255,.9)', 1.6, now);
    }
    // battles
    for (const b of G.battles) {
      const d = WD.terr[b.dst];
      let x1, y1;
      if (b.src >= 0) { const sTr = WD.terr[b.src];[x1, y1] = w2s(sTr.ax + .5, sTr.ay + .5); }
      else { const p = d.port >= 0 ? d.port : d.ay * WD.MW + d.ax, px = p % WD.MW;[x1, y1] = w2s(px + .5, (p - px) / WD.MW + .5); }
      const [x2, y2] = w2s(d.ax + .5, d.ay + .5);
      if (!onScr(x1, y1, 200) && !onScr(x2, y2, 200)) continue;
      const col = E[b.e].color, vsMe = G.owner[b.dst] === 0;
      const mid = arrowS(c, x1, y1, x2, y2, col, 1.4 + Math.log10(b.force + 10) * .55, now);
      if (vsMe) { c.beginPath(); c.arc(x2, y2, 10 + 4 * Math.sin(now / 150), 0, 6.2832); c.strokeStyle = 'rgba(214,90,74,.9)'; c.lineWidth = 2; c.stroke(); }
      if (z >= 1.3 || b.e === 0 || vsMe) pill(c, mid[0], mid[1], fmt(b.force), col);
    }
    // fleets
    for (const f of G.fleets) {
      const col = E[f.e].color, i = Math.min(f.path.length - 1, Math.floor(f.pos)), j = Math.min(f.path.length - 1, i + 1);
      const [ax_, ay_] = cellXY(f.path[i]), [bx_, by_] = cellXY(f.path[j]);
      const fr = f.pos - i, wx = Math.abs(bx_ - ax_) > WD.MW / 2 ? ax_ : lerp(ax_, bx_, fr), wy = lerp(ay_, by_, fr);
      const [sx, sy] = w2s(wx, wy);
      if (f.e === 0 || G.owner[f.dst] === 0) drawSeaPath(c, f.path, f.pos, col, now);
      if (!onScr(sx, sy)) continue;
      drawShip(c, sx, sy, Math.atan2(by_ - ay_, Math.abs(bx_ - ax_) > WD.MW / 2 ? 0 : bx_ - ax_), col);
      if (z >= 1.3 || f.e === 0) pill(c, sx, sy - 15, fmt(f.force), col);
    }
    // previews
    if (UI.preview) {
      const p = UI.preview, a = WD.terr[p.src], b = WD.terr[p.dst];
      if (p.naval && p.path) drawSeaPath(c, p.path, 0, '#f0d595', now);
      else { const [x1, y1] = w2s(a.ax + .5, a.ay + .5), [x2, y2] = w2s(b.ax + .5, b.ay + .5); arrowS(c, x1, y1, x2, y2, '#f0d595', 2.2, now); }
    }
    if (UI.movePv) {
      const p = UI.movePv, a = WD.terr[p.from], b = WD.terr[p.to];
      if (p.naval && p.path) drawSeaPath(c, p.path, 0, '#8cd2ff', now);
      else { const [x1, y1] = w2s(a.ax + .5, a.ay + .5), [x2, y2] = w2s(b.ax + .5, b.ay + .5); arrowS(c, x1, y1, x2, y2, '#8cd2ff', 2, now); }
    }
    // capitals
    for (const e of E) {
      if (!e.alive || e.capital < 0) continue;
      const tr = WD.terr[e.capital], [x, y] = w2s(tr.ax + .5, tr.ay + .5);
      if (onScr(x, y)) star(c, x, y, e.player ? 7 : 4.5, e.player ? '#f0d595' : e.color);
    }
  }
  // territory labels (troops in game, names when zoomed)
  const showTroops = STATE === 'game' && G && S.troops && z >= 1.6, showNames = S.names && z >= (STATE === 'pick' ? 2.4 : 3.2);
  const showMapMarkers = STATE === 'game' && G && z >= 2.2;
  if (showTroops || showNames || showMapMarkers) {
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    for (const tr of WD.terr) {
      const sz = Math.sqrt(tr.area) * s; if (sz < 24) continue;
      const [x, y] = w2s(tr.ax + .5, tr.ay + .5); if (!onScr(x, y)) continue;
      let ty = y;
      if (showNames && sz >= 70) {
        c.font = '600 9.5px Inter, sans-serif';
        const nm = tr.name.toUpperCase();
        c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = 3; c.strokeText(nm, x, y - 8);
        c.fillStyle = 'rgba(235,228,210,.82)'; c.fillText(nm, x, y - 8); ty = y + 5;
      }
      if (showTroops) {
        c.font = '600 10.5px "JetBrains Mono", monospace';
        const v = fmt(G.troops[tr.id]);
        c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = 3; c.strokeText(v, x, ty);
        c.fillStyle = G.owner[tr.id] === 0 ? '#fff4d6' : 'rgba(255,255,255,.86)'; c.fillText(v, x, ty);
      }
      if (showMapMarkers && G.owner[tr.id] >= 0 && G.fact[tr.id] > 0) {
        const fy = showNames ? y - 19 : y - 8;
        c.fillStyle = 'rgba(7,11,17,.9)'; c.fillRect(x - 10, fy - 7, 22, 15);
        c.strokeStyle = 'rgba(209,173,102,.85)'; c.lineWidth = 1; c.strokeRect(x - 10, fy - 7, 22, 15);
        c.fillStyle = '#d1ad66'; c.beginPath(); c.moveTo(x - 7, fy + 5); c.lineTo(x - 7, fy); c.lineTo(x - 3, fy + 2); c.lineTo(x - 3, fy); c.lineTo(x + 1, fy + 2); c.lineTo(x + 1, fy - 3); c.lineTo(x + 3, fy - 3); c.lineTo(x + 3, fy + 5); c.closePath(); c.fill();
        c.fillStyle = '#f0d595'; c.font = '600 8px "JetBrains Mono", monospace'; c.textAlign = 'center';
        c.fillText(roman(G.fact[tr.id]), x + 8, fy + 2);
      }
      if (showMapMarkers && G.owner[tr.id] >= 0 && G.colony[tr.id]) {
        c.fillStyle = 'rgba(7,11,17,.9)'; c.fillRect(x - 4, y + 7, 10, 11);
        c.strokeStyle = 'rgba(63,179,168,.9)'; c.lineWidth = 1; c.strokeRect(x - 4, y + 7, 10, 11);
        c.fillStyle = '#78d0c6'; c.font = '600 8px "JetBrains Mono", monospace'; c.textAlign = 'center'; c.fillText('C', x + 1, y + 15);
      }
      if (showMapMarkers && G.owner[tr.id] >= 0 && G.silo[tr.id]) {
        c.fillStyle = 'rgba(7,11,17,.92)'; c.fillRect(x + 7, y + 7, 18, 13);
        c.strokeStyle = '#e28d67'; c.lineWidth = 1; c.strokeRect(x + 7, y + 7, 18, 13);
        c.fillStyle = '#ffd0a8'; c.font = '600 8px "JetBrains Mono", monospace'; c.textAlign = 'center';
        c.fillText(G.nuke[tr.id] ? 'N' : 'M' + G.missile[tr.id], x + 16, y + 14);
      }
    }
  }
  if (showMapMarkers) for (const strike of G.strikes) {
    const tr = WD.terr[strike.dst], [x, y] = w2s(tr.ax + .5, tr.ay + .5);
    if (!onScr(x, y)) continue;
    c.beginPath(); c.arc(x, y, 6 + Math.sin(now / 100) * 2, 0, Math.PI * 2);
    c.strokeStyle = strike.kind === 'nuke' ? 'rgba(255,90,70,.9)' : 'rgba(255,190,100,.85)';
    c.lineWidth = 2; c.stroke();
  }
}

/* ---------------- hit testing ---------------- */
function hit(sx, sy) {
  const wx = (sx - cam.x) / cam.s, wy = (sy - cam.y) / cam.s, x = Math.floor(wx), y = Math.floor(wy);
  if (x >= 0 && y >= 0 && x < WD.MW && y < WD.MH) { const t = WD.tmap[y * WD.MW + x]; if (t >= 0) return t; }
  // fall back to nearby island markers (spatial bucket lookup)
  const r = 9 / cam.s, B = WD.SB;
  const bx0 = Math.floor((wx - r) / B), bx1 = Math.floor((wx + r) / B), by0 = Math.floor((wy - r) / B), by1 = Math.floor((wy + r) / B);
  let best = -1, bd = r * r;
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    const l = WD.sidx.get(by * 10000 + bx); if (!l) continue;
    for (const t of l) { const tr = WD.terr[t], dx = tr.ax + .5 - wx, dy = tr.ay + .5 - wy, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = t; } }
  }
  return best;
}

/* ---------------- map input (mouse, wheel, touch pinch) ---------------- */
function bindMapInput() {
  const el = R.over, ptrs = new Map();
  let start = null, moved = false, pinch = null;
  el.addEventListener('pointerdown', e => {
    A.init();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cam.fly = null;
    if (ptrs.size === 1) { start = { x: e.clientX, y: e.clientY, b: e.button }; moved = false; }
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; moved = true; }
  });
  el.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse') onMapHover(hit(e.clientX, e.clientY), e); return; }
    const p = ptrs.get(e.pointerId), dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) { moved = true; el.classList.add('drag'); hideTooltip(); }
      if (moved) { cam.x += dx; cam.y += dy; cam.anim = false; clampCam(); R.baseDirty = true; }
    } else if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      cam.x += mx - pinch.mx; cam.y += my - pinch.my;
      const wx = (mx - cam.x) / cam.s, wy = (my - cam.y) / cam.s, ns = clamp(cam.s * d / pinch.d, cam.s0 * .9, cam.s0 * 40);
      cam.s = cam.ts = ns; cam.x = mx - wx * ns; cam.y = my - wy * ns; cam.anim = false;
      pinch = { d, mx, my }; clampCam(); R.baseDirty = true;
    }
  });
  const up = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size === 0) {
      if (!moved && start && e.type === 'pointerup') {
        const t = hit(e.clientX, e.clientY);
        if (start.b === 2) onMapRightClick(t); else onMapClick(t, e);
      }
      el.classList.remove('drag'); pinch = null; start = null;
    } else if (ptrs.size === 1) pinch = null;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !ptrs.size) { UI.hover = -1; hideTooltip(); } });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015));
    zoomAt(e.clientX, e.clientY, f);
  }, { passive: false });
  el.addEventListener('dblclick', e => zoomAt(e.clientX, e.clientY, 2.2));
  el.addEventListener('contextmenu', e => e.preventDefault());
}

/** Called every animation frame by the main loop (ui.js). */
function renderFrame(now, dt) {
  updateCamera(dt);
  if (STATE === 'menu' && !cam.fly) menuDrift(now);
  const live = G && STATE === 'game' && R.mode !== 'political' && R.mode !== 'diplomacy';
  if ((R.fillDirty && now - R.lastCompose > 180) || (live && now - R.lastCompose > 1200)) compose();
  if (R.baseDirty) renderBase();
  drawOverlay(now);
}