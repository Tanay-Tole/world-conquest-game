'use strict';
/* =====================================================================
   WORLD CONQUEST — world.js
   Map data pipeline:
     1. Load Natural Earth country polygons (world-atlas TopoJSON).
     2. Project with Equal Earth onto a fixed raster grid (CFG.MW wide).
     3. Rasterise countries, resolve anti-aliased edges, force tiny islands
        to survive as at least one pixel.
     4. Split each country into landmasses (connected components), group
        small islands into archipelagos, subdivide large landmasses into
        compact territories with a noise-weighted multi-source Dijkstra.
     5. Derive adjacency, coastlines, ports, terrain, population, names.
     6. Build a coarse sea-lane grid (with antimeridian wrap) for fleets.
     7. Build vector Path2D layers (high + low detail) for crisp rendering.
   Geometry is deterministic (fixed seeds) so saves map to the same IDs.
   ===================================================================== */

const DATA_URLS = [
  './countries-50m.json',
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
  'https://unpkg.com/world-atlas@2.0.2/countries-50m.json'
];

async function loadTopo(prog) {
  for (let i = 0; i < DATA_URLS.length; i++) {
    try {
      prog(.04 + i * .03, 'Downloading Natural Earth boundaries');
      const r = await fetch(DATA_URLS[i]);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.objects && j.objects.countries) return j;
    } catch (e) { /* try next source */ }
  }
  throw new Error('Could not download the world map data (countries-50m.json).');
}

const SHORT_NAMES = {
  'United States of America': 'United States', 'Dem. Rep. Congo': 'DR Congo', 'Central African Rep.': 'Central Africa',
  'Bosnia and Herz.': 'Bosnia', 'Dominican Rep.': 'Dominican Republic', 'Eq. Guinea': 'Equatorial Guinea', 'S. Sudan': 'South Sudan',
  'Falkland Is.': 'Falklands', 'Fr. S. Antarctic Lands': 'French Southern Lands', 'N. Cyprus': 'Northern Cyprus', 'W. Sahara': 'Western Sahara',
  'Turks and Caicos Is.': 'Turks & Caicos', 'U.S. Virgin Is.': 'US Virgin Islands', 'British Virgin Is.': 'British Virgin Islands',
  'Heard I. and McDonald Is.': 'Heard Island', 'S. Geo. and the Is.': 'South Georgia', 'Br. Indian Ocean Ter.': 'Chagos',
  'Fr. Polynesia': 'French Polynesia', 'N. Mariana Is.': 'Northern Marianas', 'St. Pierre and Miquelon': 'St. Pierre',
  'Wallis and Futuna Is.': 'Wallis & Futuna', 'Antigua and Barb.': 'Antigua', 'St. Vin. and Gren.': 'St. Vincent',
  'São Tomé and Principe': 'São Tomé', 'Ashmore and Cartier Is.': 'Ashmore Reef', 'Indian Ocean Ter.': 'Christmas Island',
  'Siachen Glacier': 'Siachen', 'eSwatini': 'Eswatini', 'Solomon Is.': 'Solomon Islands', 'Marshall Is.': 'Marshall Islands',
  'Faeroe Is.': 'Faroe Islands', 'Cayman Is.': 'Cayman Islands', 'Cook Is.': 'Cook Islands', 'Pitcairn Is.': 'Pitcairn',
  'St. Kitts and Nevis': 'St. Kitts', 'Trinidad and Tobago': 'Trinidad'
};
const cleanName = n => SHORT_NAMES[n] || n.replace(/ Is\.$/, ' Islands').replace(/ Rep\.$/, ' Republic');

const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1], DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
const DIRS = [['Northwest', 'North', 'Northeast'], ['West', 'Central', 'East'], ['Southwest', 'South', 'Southeast']];

/* ---------- geography heuristics (lon/lat boxes: [lon0, lon1, lat0, lat1]) ---------- */
const inBox = (lon, lat, b) => lon >= b[0] && lon <= b[1] && lat >= b[2] && lat <= b[3];
const DESERTS = [[-17, 35, 15, 31], [35, 60, 15, 32], [60, 70, 25, 30], [115, 140, -31, -19], [90, 115, 38, 46], [-72, -68, -28, -17], [12, 20, -28, -18], [52, 68, 36, 42], [-118, -108, 30, 38]];
const MOUNTAINS = [[70, 100, 27, 38], [-78, -64, -38, 4], [-122, -106, 37, 52], [5, 16, 44, 48], [40, 48, 40, 44], [36, 42, 6, 14], [100, 106, 22, 30]];

function terrainOf(lon, lat, cn, rng) {
  if (cn === 'Antarctica' || lat < -60) return 6;
  if (cn === 'Greenland' || lat > 66) return 5;
  if (MOUNTAINS.some(b => inBox(lon, lat, b)) && rng() < .7) return 4;
  if (DESERTS.some(b => inBox(lon, lat, b))) return rng() < .85 ? 3 : 0;
  if (Math.abs(lat) < 11) return rng() < .75 ? 2 : 0;
  if (lat > 52) return rng() < .75 ? 1 : 0;
  const r = rng();
  return r < .1 ? 4 : r < .26 ? 1 : 0;
}

/** Raw population density (people / km²) before world normalisation. */
function densityOf(lon, lat, ter, rng) {
  let d = [55, 22, 28, 3, 14, .6, 0][ter];
  const B = (a, b, c, e, m) => { if (lon >= a && lon <= b && lat >= c && lat <= e) d *= m; };
  B(68, 92, 8, 32, 5); B(100, 123, 20, 41, 4); B(126, 142, 31, 43, 3.5); B(95, 125, -10, 20, 2.2);
  B(-10, 40, 36, 58, 1.8); B(-18, 15, 4, 14, 1.8); B(28, 45, -5, 12, 1.6); B(25, 35, 22, 32, 4);
  B(-100, -70, 25, 45, 1.5); B(-50, -34, -25, -5, 1.6); B(-105, -95, 15, 22, 2.5);
  B(40, 180, 50, 75, .25); B(-170, -55, 50, 85, .15); B(113, 154, -39, -10, .12);
  if (ter === 2 && inBox(lon, lat, [-80, -35, -20, 5])) d *= .25;
  return d * (.6 + rng() * .8);
}

/* resources: boxes per resource index (food handled by terrain) */
const RBOX = [[],
  [[113, 125, -26, -18], [-50, -40, -22, -14], [105, 125, 30, 45], [80, 88, 18, 25], [30, 62, 50, 62], [15, 24, 64, 69], [-95, -85, 45, 49]],
  [[35, 60, 12, 38], [60, 85, 52, 70], [-100, -88, 26, 34], [-73, -60, 1, 12], [3, 10, 3, 7], [-2, 10, 55, 62], [47, 70, 40, 53], [-120, -108, 50, 60], [10, 25, 25, 33]],
  [[100, 122, 30, 45], [78, 90, 18, 26], [-90, -78, 35, 42], [-110, -103, 40, 46], [140, 153, -34, -20], [80, 100, 50, 58], [14, 24, 49, 53], [25, 32, -30, -24]],
  [[128, 142, -17, -10], [-15, -9, 9, 13], [-60, -48, -10, 0], [-78, -76, 17, 19], [80, 86, 18, 24], [105, 112, 22, 28]],
  [[100, 115, 35, 45], [22, 30, -12, -4], [-72, -65, -25, -18], [25, 32, -27, -24], [40, 50, -25, -12]]];
const RBASE = [0, .07, .05, .06, .04, .025];
const FOODP = [.55, .25, .3, .03, .08, .02, 0];

/** Per-game resource roll (geographically biased). Returns bitmask. */
function genRes(tr, rng) {
  let m = 0;
  if (rng() < FOODP[tr.terrain]) m |= 1;
  for (let k = 1; k < 6; k++) {
    const p = RBOX[k].some(b => inBox(tr.lon, tr.lat, b)) ? .55 : RBASE[k];
    if (rng() < p) m |= 1 << k;
  }
  return m;
}
/** Per-game industry roll (0–100). */
function genInd(tr, rng) {
  let v = 12 + rng() * 26;
  const L = tr.lon, B = tr.lat, In = (a, c, d, e) => L >= a && L <= c && B >= d && B <= e;
  if (In(-11, 40, 36, 62)) v += 22;
  if (In(-125, -65, 25, 50)) v += 24;
  if (In(100, 123, 20, 42)) v += 16;
  if (In(126, 146, 30, 46)) v += 28;
  if (In(113, 154, -39, -25)) v += 16;
  if (tr.terrain >= 5) v *= .5;
  return clamp(v, 4, 90);
}

/* ===================================================================== */
async function buildWorld(topo, prog) {
  const MW = CFG.MW;
  prog(.18, 'Projecting to Equal Earth'); await tick();
  const feats = topojson.feature(topo, topo.objects.countries).features.filter(f => f.geometry);
  const NC = feats.length;
  const cname = feats.map(f => cleanName((f.properties && f.properties.name) || 'Unknown Land'));
  const proj = d3.geoEqualEarth().fitWidth(MW, { type: 'Sphere' });
  const gs = d3.geoPath(proj);
  const sb = gs.bounds({ type: 'Sphere' });
  const MH = Math.ceil(sb[1][1]) + 1, N = MW * MH;

  /* --- per-row horizontal extent of the projected sphere --- */
  const rowL = new Int16Array(MH), rowR = new Int16Array(MH).fill(-1);
  let sphereN = 0;
  for (let y = 0; y < MH; y++) {
    const inv = proj.invert([MW / 2, y + .5]);
    if (!inv || !isFinite(inv[1]) || Math.abs(inv[1]) > 90) continue;
    const back = proj([0, inv[1]]);
    if (!back || Math.abs(back[1] - (y + .5)) > .75) continue;
    const l = proj([-179.999, inv[1]])[0], r = proj([179.999, inv[1]])[0];
    rowL[y] = Math.max(0, Math.ceil(l - .5)); rowR[y] = Math.min(MW - 1, Math.floor(r - .5));
    if (rowR[y] >= rowL[y]) sphereN += rowR[y] - rowL[y] + 1;
  }

  /* --- rasterise countries with an index colour + checksum channel --- */
  prog(.28, 'Rasterising coastlines and borders'); await tick();
  const cv = document.createElement('canvas'); cv.width = MW; cv.height = MH;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const gc = d3.geoPath(proj, cx);
  const chk = id => (id * 73 + 41) & 255;
  feats.forEach((f, i) => { const id = i + 1; cx.fillStyle = `rgb(${id & 255},${id >> 8},${chk(id)})`; cx.beginPath(); gc(f); cx.fill(); });
  const px = cx.getImageData(0, 0, MW, MH).data;
  // cmap: -2 outside sphere, -1 ocean, -3 ambiguous (anti-aliased blend), >=0 country index
  const cmap = new Int16Array(N);
  for (let y = 0; y < MH; y++) {
    const L = rowL[y], Rr = rowR[y];
    for (let x = 0; x < MW; x++) {
      const i = y * MW + x;
      if (x < L || x > Rr) { cmap[i] = -2; continue; }
      const a = px[i * 4 + 3];
      if (a < 128) { cmap[i] = -1; continue; }
      const id = px[i * 4] | (px[i * 4 + 1] << 8);
      cmap[i] = (id > 0 && id <= NC && px[i * 4 + 2] === chk(id)) ? id - 1 : -3;
    }
  }
  // resolve blended edge pixels from neighbours
  for (let pass = 0; pass < 8; pass++) {
    let left = 0;
    for (let i = 0; i < N; i++) {
      if (cmap[i] !== -3) continue;
      const x = i % MW; let v = -3;
      if (x > 0 && cmap[i - 1] >= 0) v = cmap[i - 1];
      else if (x < MW - 1 && cmap[i + 1] >= 0) v = cmap[i + 1];
      else if (i >= MW && cmap[i - MW] >= 0) v = cmap[i - MW];
      else if (i + MW < N && cmap[i + MW] >= 0) v = cmap[i + MW];
      if (v >= 0) cmap[i] = v; else left++;
    }
    if (!left) break;
  }
  for (let i = 0; i < N; i++) if (cmap[i] === -3) cmap[i] = -1;
  // island visibility: every polygon keeps at least its centroid pixel
  feats.forEach((f, fi) => {
    const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const c = gs.centroid({ type: 'Polygon', coordinates: poly });
      if (!isFinite(c[0]) || !isFinite(c[1])) continue;
      const x = c[0] | 0, y = c[1] | 0;
      if (x < 0 || y < 0 || x >= MW || y >= MH) continue;
      const i = y * MW + x;
      if (cmap[i] === -1) cmap[i] = fi;
    }
  });

  /* --- organic border cost field --- */
  const nz = vnoise(7), nz2 = vnoise(13), cost = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (cmap[i] >= 0) {
    const x = i % MW, y = (i - x) / MW;
    const v = nz(x * .05, y * .05) * .7 + nz2(x * .16, y * .16) * .3;
    cost[i] = 1 + Math.min(3, (v * 4) | 0);
  }

  /* --- connected landmasses per country (8-connectivity) --- */
  prog(.42, 'Charting landmasses'); await tick();
  const comp = new Int32Array(N).fill(-1), stack = new Int32Array(N), comps = [];
  for (let i = 0; i < N; i++) {
    const ci = cmap[i]; if (ci < 0 || comp[i] >= 0) continue;
    const c = comps.length; let sp = 0; stack[sp++] = i; comp[i] = c;
    let size = 0, sx = 0, sy = 0;
    while (sp > 0) {
      const p = stack[--sp], x = p % MW, y = (p - x) / MW; size++; sx += x; sy += y;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k], ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
        const q = ny * MW + nx;
        if (comp[q] < 0 && cmap[q] === ci) { comp[q] = c; stack[sp++] = q; }
      }
    }
    comps.push({ ci, size, cx: sx / size, cy: sy / size });
  }
  const C = comps.length;
  const cStart = new Int32Array(C + 1);
  for (let i = 0; i < N; i++) { const c = comp[i]; if (c >= 0) cStart[c + 1]++; }
  for (let c = 0; c < C; c++) cStart[c + 1] += cStart[c];
  const cFill = cStart.slice(0, C), cPix = new Int32Array(cStart[C]);
  for (let i = 0; i < N; i++) { const c = comp[i]; if (c >= 0) cPix[cFill[c]++] = i; }
  const byC = Array.from({ length: NC }, () => []);
  comps.forEach((c, k) => byC[c.ci].push(k));

  /* --- subdivide into territories --- */
  prog(.55, 'Partitioning territories'); await tick();
  const tmap = new Int32Array(N);
  for (let i = 0; i < N; i++) tmap[i] = cmap[i] < 0 ? cmap[i] : -9;
  const dist = new Int32Array(N), rng = mulberry32(1337), bk = [[], [], [], [], [], [], [], []];
  const tc = []; let T = 0;

  // multi-source Dijkstra (bucket queue) restricted to one landmass
  const flood = (cid, pix, seeds, labels) => {
    for (let j = 0; j < pix.length; j++) dist[pix[j]] = 1e9;
    let cnt = 0;
    seeds.forEach((s, k) => { dist[s] = 0; tmap[s] = labels[k]; bk[0].push(s); cnt++; });
    let d = 0;
    while (cnt > 0) {
      const b = bk[d & 7];
      while (b.length) {
        const p = b.pop(); cnt--;
        if (dist[p] < d) continue;
        const x = p % MW, y = (p - x) / MW, lab = tmap[p];
        for (let k = 0; k < 8; k++) {
          const nx = x + DX8[k], ny = y + DY8[k];
          if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
          const q = ny * MW + nx;
          if (comp[q] !== cid) continue;
          const nd = d + cost[q];
          if (nd < dist[q]) { dist[q] = nd; tmap[q] = lab; bk[nd & 7].push(q); cnt++; }
        }
      }
      d++;
    }
  };
  const pickSeeds = (pix, k) => {
    const Sn = Math.min(pix.length, 800), sm = new Int32Array(Sn);
    for (let j = 0; j < Sn; j++) sm[j] = pix[(rng() * pix.length) | 0];
    const seeds = [sm[0]], md = new Float64Array(Sn).fill(1e18);
    for (let it = 1; it < k; it++) {
      const s = seeds[it - 1], sx = s % MW, sy = (s - sx) / MW;
      let best = -1, bi = 0;
      for (let j = 0; j < Sn; j++) {
        const p = sm[j], x = p % MW, y = (p - x) / MW, dd = (x - sx) ** 2 + (y - sy) ** 2;
        if (dd < md[j]) md[j] = dd;
        if (md[j] > best) { best = md[j]; bi = j; }
      }
      seeds.push(sm[bi]);
    }
    return [...new Set(seeds)];
  };
  // one Lloyd relaxation step: move each seed to the pixel nearest its region mean
  const relax = (pix, base, k) => {
    const sx = new Float64Array(k), sy = new Float64Array(k), n = new Float64Array(k);
    for (let j = 0; j < pix.length; j++) { const p = pix[j], r = tmap[p] - base, x = p % MW; sx[r] += x; sy[r] += (p - x) / MW; n[r]++; }
    const best = new Float64Array(k).fill(1e18), seeds = new Int32Array(k).fill(-1);
    for (let j = 0; j < pix.length; j++) {
      const p = pix[j], r = tmap[p] - base; if (!n[r]) continue;
      const x = p % MW, y = (p - x) / MW, dd = (x - sx[r] / n[r]) ** 2 + (y - sy[r] / n[r]) ** 2;
      if (dd < best[r]) { best[r] = dd; seeds[r] = p; }
    }
    return Array.from(seeds).filter(s => s >= 0);
  };

  for (let ci = 0; ci < NC; ci++) {
    const list = byC[ci]; if (!list.length) continue;
    const factor = cname[ci] === 'Antarctica' ? 6 : cname[ci] === 'Greenland' ? 2 : 1;
    const big = list.filter(c => comps[c].size >= CFG.SMALL), small = list.filter(c => comps[c].size < CFG.SMALL);
    for (const cid of big) {
      const pix = cPix.subarray(cStart[cid], cStart[cid + 1]);
      const k = Math.max(1, Math.round(comps[cid].size / (CFG.TARGET * factor)));
      if (k === 1) { for (let j = 0; j < pix.length; j++) tmap[pix[j]] = T; tc.push({ ci, comp: cid, small: false }); T++; continue; }
      let seeds = pickSeeds(pix, k);
      flood(cid, pix, seeds, seeds.map((_, j) => T + j));
      seeds = relax(pix, T, seeds.length);
      flood(cid, pix, seeds, seeds.map((_, j) => T + j));
      for (let j = 0; j < seeds.length; j++) tc.push({ ci, comp: cid, small: false });
      T += seeds.length;
    }
    // group nearby tiny islands into archipelago territories (union-find)
    const par = small.map((_, j) => j), find = j => par[j] === j ? j : (par[j] = find(par[j]));
    for (let a = 0; a < small.length; a++) for (let b = a + 1; b < small.length; b++) {
      const A_ = comps[small[a]], B_ = comps[small[b]];
      if (Math.hypot(A_.cx - B_.cx, A_.cy - B_.cy) < 28) par[find(a)] = find(b);
    }
    const groups = new Map();
    small.forEach((c, j) => { const r = find(j); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
    for (const g of groups.values()) {
      for (const cid of g) for (let j = cStart[cid]; j < cStart[cid + 1]; j++) tmap[cPix[j]] = T;
      tc.push({ ci, comp: g[0], small: true }); T++;
    }
  }
  for (let i = 0; i < N; i++) if (tmap[i] === -9) tmap[i] = -1;

  /* --- territory statistics, anchors, adjacency, coasts, ports --- */
  prog(.68, 'Computing borders and coastlines'); await tick();
  const terr = [];
  for (let t = 0; t < T; t++) terr.push({ id: t, ci: tc[t].ci, comp: tc[t].comp, small: tc[t].small, area: 0, sx: 0, sy: 0, x0: MW, y0: MH, x1: 0, y1: 0, cx: 0, cy: 0, ax: 0, ay: 0, ad: 1e18, coastal: false, port: -1, pcell: -1, nb: [] });
  for (let i = 0; i < N; i++) {
    const t = tmap[i]; if (t < 0) continue;
    const x = i % MW, y = (i - x) / MW, r = terr[t];
    r.area++; r.sx += x; r.sy += y;
    if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
  }
  for (const r of terr) { r.cx = r.sx / Math.max(1, r.area); r.cy = r.sy / Math.max(1, r.area); }
  const adjSet = new Set(), portBest = new Float64Array(T).fill(1e18);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const i = y * MW + x, t = tmap[i]; if (t < 0) continue;
    const r = terr[t], dd = (x - r.cx) ** 2 + (y - r.cy) ** 2;
    if (dd < r.ad) { r.ad = dd; r.ax = x; r.ay = y; }   // anchor = own pixel nearest centroid
    const nbs = [x < MW - 1 ? i + 1 : -1, y < MH - 1 ? i + MW : -1, x > 0 ? i - 1 : -1, y > 0 ? i - MW : -1];
    for (const q of nbs) {
      if (q < 0) continue;
      const u = tmap[q];
      if (u >= 0 && u !== t) adjSet.add(pairKey(t, u));
      else if (u === -1) { r.coastal = true; if (dd < portBest[t]) { portBest[t] = dd; r.port = q; } }
    }
  }
  for (const k of adjSet) { const a = Math.floor(k / 65536), b = k % 65536; terr[a].nb.push(b); terr[b].nb.push(a); }
  // pixel lists per territory (counting sort)
  const tPixStart = new Int32Array(T + 1);
  for (let i = 0; i < N; i++) { const t = tmap[i]; if (t >= 0) tPixStart[t + 1]++; }
  for (let t = 0; t < T; t++) tPixStart[t + 1] += tPixStart[t];
  const tf = tPixStart.slice(0, T), tPix = new Int32Array(tPixStart[T]);
  for (let i = 0; i < N; i++) { const t = tmap[i]; if (t >= 0) tPix[tf[t]++] = i; }

  /* --- geography: lon/lat, terrain, population --- */
  prog(.78, 'Surveying terrain and population'); await tick();
  const km2 = 510.1e6 / Math.max(1, sphereN);
  const grng = mulberry32(4242);
  let rawTotal = 0;
  for (const r of terr) {
    const ll = proj.invert([r.ax + .5, r.ay + .5]) || [0, 0];
    r.lon = ll[0]; r.lat = ll[1]; r.h = grng();
    r.terrain = terrainOf(r.lon, r.lat, cname[r.ci], grng);
    r.basePop = r.area * km2 * densityOf(r.lon, r.lat, r.terrain, grng);
    rawTotal += r.basePop;
  }
  const popScale = 8.1e9 / Math.max(1, rawTotal);
  for (const r of terr) r.basePop = r.terrain === 6 ? 1500 : Math.max(5000, r.basePop * popScale);

  /* --- names: direction within the country's core landmass --- */
  const byCT = Array.from({ length: NC }, () => []);
  terr.forEach(r => byCT[r.ci].push(r));
  for (let ci = 0; ci < NC; ci++) {
    const L = byCT[ci]; if (!L.length) continue;
    const cn = cname[ci];
    if (L.length === 1) { L[0].name = cn; continue; }
    let main = -1, ms = 0;
    for (const k of byC[ci]) if (comps[k].size > ms) { ms = comps[k].size; main = k; }
    const mc = comps[main];
    const inCore = r => { const c = comps[r.comp]; return Math.hypot(c.cx - mc.cx, c.cy - mc.cy) < 380; };
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const r of L) if (inCore(r)) { x0 = Math.min(x0, r.ax); x1 = Math.max(x1, r.ax); y0 = Math.min(y0, r.ay); y1 = Math.max(y1, r.ay); }
    const isl = /Islands?$/.test(cn) ? cn : cn + ' Islands';
    const used = {};
    for (const r of L) {
      let nm;
      if (!inCore(r)) nm = 'Overseas ' + cn;
      else {
        const u = x1 > x0 ? (r.ax - x0) / (x1 - x0) : .5, v = y1 > y0 ? (r.ay - y0) / (y1 - y0) : .5;
        const d = DIRS[v < .34 ? 0 : v < .67 ? 1 : 2][u < .34 ? 0 : u < .67 ? 1 : 2];
        nm = r.small ? (d === 'Central' ? isl : d + ' ' + isl) : (d + ' ' + cn);
      }
      used[nm] = (used[nm] || 0) + 1;
      r.name = used[nm] > 1 ? nm + ' ' + roman(used[nm]) : nm;
    }
  }

  /* --- sea-lane grid with antimeridian wrap --- */
  prog(.86, 'Charting sea lanes'); await tick();
  const CS = CFG.CELL, GW = Math.ceil(MW / CS), GH = Math.ceil(MH / CS), water = new Uint8Array(GW * GH);
  for (let i = 0; i < N; i++) if (tmap[i] === -1) { const x = i % MW, y = (i - x) / MW; water[((y / CS) | 0) * GW + ((x / CS) | 0)] = 1; }
  const wL = new Int32Array(GH).fill(-1), wR = new Int32Array(GH).fill(-1);
  for (let gy = 0; gy < GH; gy++) {
    let f = -1, l = -1;
    for (let gx = 0; gx < GW; gx++) if (water[gy * GW + gx]) { if (f < 0) f = gx; l = gx; }
    const y = Math.min(MH - 1, gy * CS + 2);
    if (f >= 0 && rowR[y] >= rowL[y] && f * CS <= rowL[y] + CS * 2 && (l + 1) * CS - 1 >= rowR[y] - CS * 2) { wL[gy] = f; wR[gy] = l; }
  }
  const coastal = [];
  for (const r of terr) if (r.coastal && r.port >= 0) {
    const x = r.port % MW, y = (r.port - x) / MW;
    r.pcell = ((y / CS) | 0) * GW + ((x / CS) | 0);
    coastal.push(r.id);
  }

  /* --- spatial index of small (island) territories for hit testing --- */
  const SB = 24, sidx = new Map(), smallList = [];
  for (const r of terr) if (r.area <= 12) {
    smallList.push(r.id);
    const key = Math.floor(r.ay / SB) * 10000 + Math.floor(r.ax / SB);
    if (!sidx.has(key)) sidx.set(key, []);
    sidx.get(key).push(r.id);
  }

  /* --- vector layers (high detail + simplified low detail) --- */
  prog(.93, 'Inking the map'); await tick();
  const P2 = s => new Path2D(s || '');
  const P = {
    sphere: P2(gs({ type: 'Sphere' })),
    grat: P2(gs(d3.geoGraticule10())),
    landHi: P2(gs({ type: 'FeatureCollection', features: feats })),
    bordHi: P2(gs(topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b))),
    coastHi: P2(gs(topojson.mesh(topo, topo.objects.countries, (a, b) => a === b)))
  };
  try {
    const pre = topojson.presimplify(topo);
    const lo = topojson.simplify(pre, topojson.quantile(pre, .5));
    P.bordLo = P2(gs(topojson.mesh(lo, lo.objects.countries, (a, b) => a !== b)));
    P.coastLo = P2(gs(topojson.mesh(lo, lo.objects.countries, (a, b) => a === b)));
  } catch (e) { P.bordLo = P.bordHi; P.coastLo = P.coastHi; }

  let landArea = 0; for (const r of terr) landArea += r.area;
  prog(1, 'World ready'); await tick();
  return {
    MW, MH, N, NC, proj, tmap, T, terr, tPixStart, tPix, rowL, rowR, km2, landArea, coastal, smallList, sidx, SB, adjSet, cname,
    grid: { GW, GH, water, wL, wR }, P, sig: `${T}:${landArea}:${MW}`
  };
}