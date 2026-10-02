'use strict';
/* =====================================================================
   WORLD CONQUEST — core.js
   Shared utilities, configuration, icons, persistent storage and audio.
   All files are classic scripts sharing one global scope (load order
   matters: core → world → render → game → ai → ui).
   ===================================================================== */

/* ---------- global state handles ---------- */
let WD = null;          // static world data (geometry, territories) — built once
let G = null;           // dynamic game state — serialisable
let STATE = 'loading';  // loading | menu | pick | game
const PL = () => G.empires[0];

/* ---------- utilities ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const tick = () => new Promise(r => setTimeout(r, 16));
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function vnoise(seed) {
  const h = (x, y) => { let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n) + '';
}
const fmtInt = n => Math.round(n).toLocaleString('en-US');
const money = m => (m < 0 ? '-' : '') + '$' + fmt(Math.abs(m) * 1e6); // m is in $ millions
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function hsl2rgb(h, s, l) { h /= 360; const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; }
const rgb2hex = ([r, g, b]) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function rgbHue([r, g, b]) { r /= 255; g /= 255; b /= 255; const M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m; if (!d) return 0; let h = M === r ? ((g - b) / d) % 6 : M === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; }
// pack RGBA into a little-endian Uint32 pixel (ImageData order)
const pack = (r, g, b, a = 255) => ((a << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;
const popc = m => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
const roman = n => ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'][n] || String(n);
const pairKey = (a, b) => a < b ? a * 65536 + b : b * 65536 + a;

/** Minimal binary min-heap (keys = priority, values = ints). */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(v, k) { const K = this.k, V = this.v; let i = K.length; K.push(k); V.push(v); while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; } K[i] = k; V[i] = v; }
  pop() {
    const K = this.k, V = this.v, top = V[0], lk = K.pop(), lv = V.pop(), n = K.length;
    if (n) { let i = 0; for (;;) { let l = 2 * i + 1; if (l >= n) break; const r = l + 1; if (r < n && K[r] < K[l]) l = r; if (K[l] >= lk) break; K[i] = K[l]; V[i] = V[l]; i = l; } K[i] = lk; V[i] = lv; }
    return top;
  }
}

/* ---------- configuration ---------- */
const CFG = {
  MW: 2000,            // raster width of the Equal Earth world grid (world units)
  TARGET: 600,         // target pixels per land territory when subdividing countries
  SMALL: 40,           // landmasses smaller than this become island territories
  CELL: 4,             // sea-lane grid cell size (pixels)
  DAY_MS: 250,         // real milliseconds per game day at 1x
  SHIP_CAP: 20000,     // troops carried per transport
  SHIP_COST: 150,      // $M per transport
  RECRUIT_COST: 0.003, // $M per recruited soldier
  FLEET_SPEED: 3.5,    // sea cells per day
  NAVAL_RANGE: 260,    // max voyage length in sea cells
  ENVOY_COST: 80,      // $M
  SILO_COST: 1600,     // $M
  MISSILE_COST: 550,   // $M
  NUKE_COST: 2600,     // $M
  MISSILE_TECH: 1.25,
  NUKE_TECH: 1.75,
  FACTORY_MAX: 5,
  START_YEAR: 2026
};
const TERR = ['Plains', 'Forest', 'Jungle', 'Desert', 'Mountains', 'Tundra', 'Ice'];
const TDEF = [1, 1.2, 1.3, 1.1, 1.6, 1.15, 1.3];   // defensive multiplier per terrain
const TCOL = [[60, 67, 52], [45, 60, 47], [38, 61, 45], [94, 82, 60], [76, 72, 67], [80, 88, 96], [118, 128, 138]];
const RES = [
  { k: 'food', n: 'Food', c: '#8fbf5a' }, { k: 'steel', n: 'Steel', c: '#8ea2b8' }, { k: 'oil', n: 'Oil', c: '#d8a13a' },
  { k: 'coal', n: 'Coal', c: '#a39183' }, { k: 'alu', n: 'Aluminium', c: '#c7d3dd' }, { k: 'rare', n: 'Rare materials', c: '#b07be0' }
];
// [key, max bonus, effect description]
const RES_FX = [['food', .4, 'population growth'], ['steel', .25, 'recruitment speed'], ['oil', .15, 'attack power & fleet speed'], ['coal', .5, 'industrial growth'], ['alu', .3, 'cheaper transports'], ['rare', .6, 'research speed']];
const ST = { NEUTRAL: 0, FRIENDLY: 1, ALLIED: 2, HOSTILE: 3, WAR: 4 };
const ST_NAME = ['Neutral', 'Friendly', 'Allied', 'Hostile', 'At War'];
const ST_COL = ['#8a96a3', '#6fbf8a', '#3fb3a8', '#e0a33f', '#d65a4a'];
const DIFF = {
  easy:   { name: 'Easy',   lvl: 1, ais: 14, think: 24, attacks: 1, minAdv: 1.6,  mistakes: .4,  naval: .04, econ: .85, consol: .5,  over: [1.2, 2.6],  warRatio: 1.6,  maxWars: 1, peace: 1.4, desc: 'Rivals expand slowly, misjudge battles and rarely take to the sea.' },
  normal: { name: 'Normal', lvl: 2, ais: 20, think: 12, attacks: 2, minAdv: 1.3,  mistakes: .15, naval: .12, econ: 1,   consol: .85, over: [1.5, 2.2],  warRatio: 1.35, maxWars: 2, peace: 1,   desc: 'Balanced rivals that expand steadily and defend their borders.' },
  hard:   { name: 'Hard',   lvl: 3, ais: 26, think: 7,  attacks: 3, minAdv: 1.15, mistakes: .06, naval: .22, econ: 1.1, consol: 1,   over: [1.45, 1.9], warRatio: 1.2,  maxWars: 3, peace: .85, desc: 'Aggressive empires with efficient economies and naval invasions.' },
  brutal: { name: 'Brutal', lvl: 4, ais: 32, think: 4,  attacks: 5, minAdv: 1.05, mistakes: .02, naval: .32, econ: 1.2, consol: 1,   over: [1.35, 1.7], warRatio: 1.1,  maxWars: 4, peace: .7,  desc: 'Relentless rivals that coordinate fronts and form coalitions against you.' }
};
const DOCTRINES = {
  vanguard: { name: 'Vanguard', attack: 1.12, defense: .94, income: 1, research: 1, desc: 'Hit harder in battle, but leave your own borders less protected.' },
  bastion: { name: 'Bastion', attack: .94, defense: 1.12, income: 1, research: 1, desc: 'Hold territory with stronger defenses, at the cost of offensive power.' },
  commerce: { name: 'Commerce', attack: 1, defense: 1, income: 1.12, research: .9, desc: 'Grow your treasury faster, but fall behind in technological research.' },
  scholarship: { name: 'Scholarship', attack: 1, defense: 1, income: .92, research: 1.2, desc: 'Race ahead in technology, but accept a smaller stream of income.' }
};
const doctrineOf = e => DOCTRINES[e.doctrine] || { attack: 1, defense: 1, income: 1, research: 1 };
const COLONY_POLICIES = {
  balanced: { name: 'Balanced charter', income: 1.2, recovery: .7, desc: '+20% tax · −30% troop recovery' },
  extraction: { name: 'Resource extraction', income: 1.45, recovery: .55, desc: '+45% tax · −45% troop recovery' },
  integration: { name: 'Gradual integration', income: 1, recovery: 1, desc: 'Standard tax · normal troop recovery' }
};
const GOALS = [
  { k: 'conquest', n: 'World Conquest', d: 'Control 97% of all land', ic: 'globe' },
  { k: 'territorial', n: 'Territorial Dominance', d: "Control half of the world's land", ic: 'map' },
  { k: 'economic', n: 'Economic Dominance', d: 'Produce 45% of world GDP', ic: 'trend' },
  { k: 'military', n: 'Military Dominance', d: 'Command 55% of all troops', ic: 'sword' }
];
const RAMP_POP = [[20, 24, 40], [48, 40, 96], [33, 110, 140], [70, 170, 120], [230, 210, 90]];
const RAMP_ECO = [[24, 22, 18], [70, 56, 30], [150, 110, 40], [220, 170, 70], [255, 230, 150]];
const RAMP_MIL = [[22, 20, 24], [80, 24, 30], [170, 40, 36], [230, 110, 50], [255, 210, 120]];
function ramp(R_, v) {
  v = clamp(v, 0, 1) * (R_.length - 1);
  const i = Math.min(R_.length - 2, Math.floor(v)), f = v - i, a = R_[i], b = R_[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const rampCSS = R_ => `linear-gradient(90deg,${R_.map(c => rgb2hex(c)).join(',')})`;

/* ---------- SVG icon set (no emoji) ---------- */
const ICONS = {
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  trend: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6',
  coin: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6',
  sword: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2',
  swords: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2',
  anchor: 'M12 22V8M5 12H2a10 10 0 0 0 20 0h-3M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  map: 'M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  vol: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  mute: 'M11 5L6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6',
  menu: 'M3 6h18M3 12h18M3 18h18',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z',
  chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16V7',
  scales: 'M12 3v18M5 21h14M3 7h18M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  dice: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
  x: 'M18 6L6 18M6 6l12 12',
  crown: 'M2 18h20M3 8l4 5 5-8 5 8 4-5-2 10H5z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  factory: 'M2 20h20M4 20V9l5 3V9l5 3V9l5 3v8M18 5v4',
  move: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  home: 'M3 11l9-8 9 8M5 9v12h14V9',
  ship: 'M2 20c2 1 4 1 6 0s4-1 6 0 4 1 6 0M4 17l-1-5h18l-2 5M12 12V4M12 4l5 4h-5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  flask: 'M9 3h6M10 3v6L4 20h16L14 9V3',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6L9 17l-5-5',
  flag: 'M4 22V4M4 4h13l-2 4 2 4H4',
  gem: 'M6 3h12l4 6-10 12L2 9zM2 9h20M12 21L8 9l4-6 4 6z',
  star: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z'
};
const ic = (n, s = 16, sw = 1.8) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[n] || ''}"/></svg>`;

/* ---------- empire emblems ---------- */
const EMBLEMS = {
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
  crown: '<path d="M4 17h16l1-9-5 4-4-7-4 7-5-4z"/>',
  tower: '<path d="M7 20V10H5V5h2.5v2H10V5h4v2h2.5V5H19v5h-2v10z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2"/>',
  peak: '<path d="M2 19l7-12 4 6 2-3 7 9z"/>',
  wave: '<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
};
const EMB_KEYS = Object.keys(EMBLEMS);
const emblemSVG = (e, color, size = 26) =>
  `<svg width="${size}" height="${Math.round(size * 1.2)}" viewBox="0 0 24 29"><path d="M2 1h20v18l-10 9-10-9z" fill="${color}" stroke="rgba(255,255,255,.35)"/><g transform="translate(3.6 2.4) scale(.7)" fill="rgba(255,255,255,.92)" color="rgba(255,255,255,.92)">${EMBLEMS[e] || EMBLEMS.star}</g></svg>`;
const PLAYER_COLORS = ['#d4a24c', '#3f8fd8', '#c8483f', '#3fae7a', '#8f5fd0', '#e07b39', '#2fb3b3', '#d05a96', '#9aa83a', '#5b6fd6', '#b5763a', '#e0d0a0'];

/* ---------- procedural empire names ---------- */
const SYL = ['ar', 'bel', 'cor', 'dra', 'el', 'fa', 'gal', 'hel', 'is', 'jor', 'kar', 'lun', 'mor', 'nor', 'or', 'pal', 'quin', 'ros', 'sar', 'tal', 'ur', 'val', 'wen', 'xa', 'yor', 'zan', 'ost', 'eth', 'ion', 'ava', 'ber', 'cas', 'del', 'fen', 'gor', 'ith', 'kel', 'lor', 'mar', 'nek', 'rin', 'sev', 'tor', 'ul', 'ves', 'zor', 'aen', 'bra', 'cy', 'dun', 'ka', 'ly', 'mi', 'sa', 'te', 'vo'];
const END = ['ia', 'on', 'ar', 'is', 'ea', 'or', 'um', 'and', 'heim', 'stan', 'ora', 'eth', 'ium', 'os', 'ane', 'ova'];
const FORM = ['Kingdom of {N}', '{N} Empire', 'Republic of {N}', '{N} Dominion', 'Union of {N}', '{N} Federation', 'Sultanate of {N}', '{N} Hegemony', 'Grand Duchy of {N}', '{N} Confederacy', 'Commonwealth of {N}', '{N} Imperium', 'Free State of {N}', '{N} League'];
function genName(r = Math.random) {
  const p = () => SYL[(r() * SYL.length) | 0];
  let n = p() + p(); if (r() < .6) n += END[(r() * END.length) | 0];
  n = n[0].toUpperCase() + n.slice(1);
  return FORM[(r() * FORM.length) | 0].replace('{N}', n);
}

/* ---------- storage (localStorage with in-memory fallback) ---------- */
const Store = (() => {
  let ok = false; const mem = {};
  try { const k = '__wc_test'; localStorage.setItem(k, '1'); localStorage.removeItem(k); ok = true; } catch (e) { ok = false; }
  return {
    ok,
    get(k) { try { return ok ? localStorage.getItem(k) : (k in mem ? mem[k] : null); } catch (e) { return k in mem ? mem[k] : null; } },
    set(k, v) { try { if (ok) localStorage.setItem(k, v); else mem[k] = v; return true; } catch (e) { mem[k] = v; return false; } },
    del(k) { try { if (ok) localStorage.removeItem(k); else delete mem[k]; } catch (e) { /* ignore */ } }
  };
})();

/* ---------- settings ---------- */
const S = Object.assign({ volume: .7, music: true, sfx: true, muted: false, troops: true, names: true, autosave: true },
  (() => { try { return JSON.parse(Store.get('wc_settings') || '{}'); } catch (e) { return {}; } })());
const saveSettings = () => Store.set('wc_settings', JSON.stringify(S));

/* ---------- audio: synthesized SFX + generative ambient music ---------- */
const A = {
  ctx: null, master: null, sfxG: null, musG: null, mode: null, mt: 0, nbuf: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      this.ctx = new C();
      this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
      this.sfxG = this.ctx.createGain(); this.sfxG.connect(this.master);
      this.musG = this.ctx.createGain(); this.musG.connect(this.master);
      const len = this.ctx.sampleRate * .6; this.nbuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.nbuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.apply();
      if (this.mode) { const m = this.mode; this.mode = null; this.music(m); }
    } catch (e) { this.ctx = null; }
  },
  apply() {
    if (!this.ctx) return;
    this.master.gain.value = S.muted ? 0 : S.volume;
    this.sfxG.gain.value = S.sfx ? 1 : 0;
    this.musG.gain.value = S.music ? .32 : 0;
  },
  tone(f, d, type = 'sine', v = .2, when = 0, slide = 0) {
    const c = this.ctx, t = c.currentTime + when, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g); g.connect(this.sfxG); o.start(t); o.stop(t + d + .05);
  },
  noise(d, v, f) {
    const c = this.ctx, t = c.currentTime, s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.nbuf; bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = .8;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    s.connect(bp); bp.connect(g); g.connect(this.sfxG); s.start(t); s.stop(t + d);
  },
  sfx(n) {
    if (!this.ctx || !S.sfx || S.muted) return;
    try {
      switch (n) {
        case 'click': this.tone(1500, .035, 'square', .025); break;
        case 'capture': this.tone(523, .12, 'triangle', .1); this.tone(784, .2, 'triangle', .1, .08); break;
        case 'battle': this.noise(.35, .22, 420); this.tone(110, .3, 'sawtooth', .05, 0, 60); break;
        case 'notify': this.tone(880, .15, 'sine', .08); this.tone(1320, .25, 'sine', .06, .1); break;
        case 'alarm': this.tone(220, .4, 'sawtooth', .06, 0, 180); this.tone(196, .5, 'sawtooth', .05, .2, 150); break;
        case 'build': this.tone(300, .08, 'square', .04); this.tone(450, .1, 'square', .04, .06); break;
        case 'victory': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, .5, 'triangle', .08, i * .14)); break;
      }
    } catch (e) { /* audio is optional */ }
  },
  pad(f, t, d, v, type = 'triangle') {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
    o.type = type; o.frequency.value = f; o.detune.value = (Math.random() - .5) * 8;
    lp.type = 'lowpass'; lp.frequency.value = 900;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 1.8); g.gain.linearRampToValueAtTime(v * .8, t + d - 2); g.gain.linearRampToValueAtTime(0, t + d);
    o.connect(lp); lp.connect(g); g.connect(this.musG); o.start(t); o.stop(t + d + .1);
  },
  music(mode) {
    if (this.mode === mode) return;
    this.mode = mode; clearInterval(this.mt);
    if (!this.ctx) return;
    const prog = mode === 'menu'
      ? [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]]
      : [[50, 53, 57, 62], [46, 50, 53, 58], [41, 45, 48, 53], [48, 52, 55, 60]];
    let i = 0;
    const hz = n => 440 * Math.pow(2, (n - 69) / 12);
    const play = () => {
      if (!S.music || S.muted || !this.ctx) return;
      const ch = prog[i++ % prog.length], t = this.ctx.currentTime + .05;
      ch.forEach((n, k) => this.pad(hz(n), t + k * .08, 6.5, k === 0 ? .05 : .032));
      this.pad(hz(ch[0] - 12), t, 6.5, .055, 'sine');
    };
    play(); this.mt = setInterval(play, 6000);
  }
};