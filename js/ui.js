'use strict';
/* =====================================================================
   WORLD CONQUEST — ui.js
   DOM user interface, interaction flow and the main loop.
   Uses the shared `UI` state object declared in render.js.
   ===================================================================== */

/* ---------------- state machine ---------------- */
function setState(st) {
  STATE = st; document.body.dataset.st = st;
  $$('[data-show]').forEach(el => el.classList.toggle('hide', !el.dataset.show.split(' ').includes(st)));
  if (st !== 'game') { ['#tpanel', '#drawer', '#legend'].forEach(s => $(s).classList.add('hide')); }
  hideTooltip();
  if (st === 'menu') { refreshMenu(); A.music('menu'); }
  if (st === 'game') A.music('game');
  R.baseDirty = true;
}

/* ---------------- toasts ---------------- */
function toast(html, kind = 'info', opts = {}) {
  const box = $('#toasts'), el = document.createElement('div');
  el.className = 'toast ' + kind;
  const icn = kind === 'bad' ? 'alert' : kind === 'good' ? 'check' : 'flag';
  el.innerHTML = `${ic(icn, 15)}<div class="tx">${html}${opts.actions ? `<div class="ta">${opts.actions.map(a => `<button class="btn sm ${a.cls || ''}" data-act="${a.act}" data-v="${a.v}">${a.label}</button>`).join('')}</div>` : ''}</div>`;
  box.prepend(el);
  while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = 0; setTimeout(() => el.remove(), 400); }, opts.ttl || 4500);
}

/* ---------------- tooltip ---------------- */
function hideTooltip() { const t = $('#tooltip'); if (t) t.classList.add('hide'); }
const resChips = m => { const out = []; for (let k = 0; k < 6; k++) if (m >> k & 1) out.push(`<span class="chip"><i style="background:${RES[k].c}"></i>${RES[k].n}</span>`); return out.length ? `<div class="chips">${out.join('')}</div>` : ''; };
const ownerHTML = o => o < 0 ? `<span class="own"><i style="background:#59636d"></i>Unclaimed lands</span>` : `<span class="own"><i style="background:${G.empires[o].color}"></i>${esc(G.empires[o].name)}</span>`;
const statusPill = o => { if (o <= 0) return ''; const s = relStatus(0, o); return `<span class="pill" style="color:${ST_COL[s]}">${ST_NAME[s]}</span>`; };

function ttHTML(t) {
  const tr = WD.terr[t], cn = WD.cname[tr.ci], sub = `${esc(cn)} &middot; ${TERR[tr.terrain]}${tr.coastal ? ' &middot; Coastal' : ''}`;
  if (!G) return `<div class="tt-h">${esc(tr.name)}</div><div class="tt-s">${sub}</div><div class="tt-g"><span>Population</span><b>${fmt(tr.basePop)}</b><span>Land neighbours</span><b>${tr.nb.length}</b><span>Defence</span><b>&times;${TDEF[tr.terrain]}</b></div>`;
  const o = G.owner[t];
  return `<div class="tt-h">${esc(tr.name)}</div><div class="tt-s">${sub}</div>
  <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">${ownerHTML(o)}${statusPill(o)}</div>
  <div class="tt-g"><span>Population</span><b>${fmt(G.pop[t])}</b><span>Economy</span><b>$${fmt(gdpOf(t) * 1e9)}</b><span>Industry</span><b>${G.ind[t].toFixed(0)}</b>${G.fact[t] ? `<span>Factory</span><b>Tier ${roman(G.fact[t])}</b>` : ''}<span>Military</span><b>${fmtInt(G.troops[t])}</b>${o >= 0 ? `<span>Supply</span><b>${Math.round(G.supply[t] * 100)}%</b>` : ''}${G.colony[t] ? '<span>Administration</span><b>Colony</b>' : ''}${G.fort[t] ? `<span>Fortification</span><b>Lv ${G.fort[t]}</b>` : ''}</div>${resChips(G.res[t])}`;
}
function onMapHover(t, e) {
  if (STATE !== 'game' && STATE !== 'pick') { UI.hover = -1; return; }
  UI.hover = t;
  const tt = $('#tooltip');
  if (t < 0) { hideTooltip(); return; }
  tt.innerHTML = ttHTML(t); tt.classList.remove('hide');
  const w = tt.offsetWidth, h = tt.offsetHeight;
  let x = e.clientX + 18, y = e.clientY + 18;
  if (x + w > R.vw - 8) x = e.clientX - w - 14;
  if (y + h > R.vh - 8) y = e.clientY - h - 14;
  tt.style.left = x + 'px'; tt.style.top = y + 'px';
}

/* ---------------- modals ---------------- */
function showModal(html, o = {}) {
  if (STATE === 'game' && G && o.pause !== false && G.speed > 0 && !UI.resume) { UI.resume = G.speed; G.speed = 0; }
  UI.modal = o;
  const m = $('#modal');
  m.innerHTML = `<div class="mbox panel ${o.wide ? 'wide' : ''}">${html}</div>`;
  m.classList.remove('hide');
  updateTopbar();
}
function closeModal(noResume) {
  $('#modal').classList.add('hide'); UI.backTo = null; UI.modal = null;
  if (!noResume && UI.resume && G) G.speed = UI.resume;
  UI.resume = 0; updateTopbar();
}
function openSetup() {
  const d = UI.setup;
  showModal(`<div class="m-kick">New Campaign</div><h2 class="m-title">Choose your challenge</h2>
  <div class="diff-grid">${Object.entries(DIFF).map(([k, x]) => `<button class="diff ${k === d.diff ? 'on' : ''}" data-act="set-diff" data-v="${k}"><div class="diff-n">${x.name}</div><div class="diff-ai">${x.ais} rival empires</div><p>${x.desc}</p><div class="diff-bars">${[1, 2, 3, 4].map(i => `<i class="${i <= x.lvl ? 'f' : ''}"></i>`).join('')}</div></button>`).join('')}</div>
  <div class="m-sub">Victory condition</div>
  <div class="goal-grid">${GOALS.map(g => `<button class="goal-b ${g.k === d.goal ? 'on' : ''}" data-act="set-goal" data-v="${g.k}">${ic(g.ic, 18)}<div><b>${g.n}</b><span>${g.d}</span></div></button>`).join('')}</div>
  <div class="m-sub">National doctrine</div>
  <div class="doctrine-grid">${Object.entries(DOCTRINES).map(([k, x]) => `<button class="doctrine ${k === d.doctrine ? 'on' : ''}" data-act="set-doctrine" data-v="${k}"><b>${x.name}</b><span>${x.desc}</span></button>`).join('')}</div>
  <div class="m-actions"><button class="btn ghost" data-act="close-modal">Back</button><button class="btn primary" data-act="to-pick">Choose Homeland ${ic('move', 14)}</button></div>`, { wide: true, pause: false });
}
function openPause() {
  showModal(`<div class="m-kick">Campaign paused</div><h2 class="m-title">${esc(PL().name)}</h2>
  <div class="slots">
    <button class="btn primary" data-act="resume">${ic('play', 14)} Resume</button>
    <button class="btn" data-act="save">${ic('save', 14)} Save Game</button>
    <button class="btn" data-act="load-game">${ic('folder', 14)} Load Game</button>
    <button class="btn" data-act="settings">${ic('gear', 14)} Settings</button>
    <button class="btn" data-act="howto">${ic('book', 14)} How to Play</button>
    <button class="btn danger" data-act="quit">Quit to Main Menu</button>
  </div>${Store.ok ? '' : '<p class="hint">Browser storage is unavailable here, so saves last for this session only.</p>'}`);
}
function openLoad(fromGame) {
  UI.backTo = fromGame ? 'pause' : null;
  const slot = (k, label) => {
    const m = Save.meta(k);
    return `<div class="slot">${m ? emblemSVG('star', m.color || '#d1ad66', 20) : ic('folder', 20)}<div><b>${label}</b><span>${m ? `${esc(m.name)} &middot; Day ${m.day} &middot; ${DIFF[m.diff] ? DIFF[m.diff].name : ''} &middot; ${new Date(m.time).toLocaleString()}` : 'Empty slot'}</span></div><button class="btn sm" data-act="do-load" data-v="${k}" ${m ? '' : 'disabled'}>Load</button></div>`;
  };
  showModal(`<div class="m-kick">Archives</div><h2 class="m-title">Load campaign</h2><div class="slots">${slot('manual', 'Manual save')}${slot('auto', 'Autosave')}</div><div class="m-actions"><button class="btn ghost" data-act="back">Back</button></div>`);
}
function openSettings() {
  const sw = (k, n, d) => `<div class="sw" data-act="toggle" data-v="${k}"><div><span>${n}</span><small>${d}</small></div><div class="tog ${S[k] ? 'on' : ''}"></div></div>`;
  showModal(`<div class="m-kick">Settings</div><h2 class="m-title">Audio &amp; display</h2>
  <div class="srow"><label>Master volume <b>${Math.round(S.volume * 100)}%</b></label><input type="range" min="0" max="100" value="${Math.round(S.volume * 100)}" data-inp="volume" style="--p:${S.volume * 100}%"></div>
  ${sw('muted', 'Mute all audio', 'Silences music and effects')}${sw('music', 'Music', 'Generative ambient score')}${sw('sfx', 'Sound effects', 'Battles, captures, notifications')}
  ${sw('troops', 'Troop counts on map', 'Shown when zoomed in')}${sw('names', 'Map labels', 'Empire and territory names')}${sw('autosave', 'Autosave', 'Every 180 in-game days')}
  <p class="hint">${Store.ok ? 'Settings and saves are stored in this browser.' : 'Browser storage is unavailable here, so settings and saves last for this session only.'}</p>
  <div class="m-actions"><button class="btn primary" data-act="back">Done</button></div>`);
}
function openHowto() {
  showModal(`<div class="m-kick">Field manual</div><h2 class="m-title">How to play</h2><div class="howto">
  <h4>Found your empire</h4><p>Pick any territory on Earth as your homeland. Every start is viable: islands are safe but isolated, inland regions are easier to defend, and populous lands raise larger armies.</p>
  <h4>Expand</h4><p>Select one of your territories, then click a highlighted neighbour to plan an attack. Choose how many troops to commit, check the predicted outcome and launch. Unclaimed lands have native garrisons; rival empires must be at war with you to be attacked.</p>
  <h4>Cross the sea</h4><p>Build transports in coastal territories (20,000 troops each). From a coastal territory, click any overseas coastal territory to plan a naval invasion. Fleets sail real sea lanes and land with an amphibious penalty. The Move command can also ship troops between your own coasts.</p>
  <h4>Economy &amp; supply</h4><p>Population and industry produce GDP and income. Military spending speeds recruitment but slows industrial growth; research spending raises technology. Strategic resources give empire-wide bonuses. Territories far from your capital suffer reduced supply, and overseas holdings even more.</p>
  <h4>Industry &amp; colonies</h4><p>Each territory has its own economy. Invest in factories up to Tier V: each tier adds local GDP, raises its income, and appears on the map when zoomed in. Capture distant territories by sea to establish overseas colonies. Set each colony to a balanced charter, higher-tax resource extraction, or gradual integration with normal tax and troop recovery. Extraction earns more but makes colonies harder to reinforce.</p>
  <h4>Weapons &amp; deterrence</h4><p>Research to technology 1.25 to build a launch site and conventional missiles; technology 1.75 unlocks nuclear warheads. Sites and stockpiles are built in owned territories. Missile range is shown in kilometres and grows with technology. Strikes can only target an empire you are at war with; they travel for several game days and damage garrisons and infrastructure. Fortifications at level 2 or higher blunt nuclear damage. Nuclear strikes are much more destructive and carry a severe diplomatic penalty, so consider the retaliation risk.</p>
  <h4>Doctrine &amp; capitals</h4><p>Your campaign doctrine shapes every decision: Vanguard and Bastion trade attack for defence, while Commerce and Scholarship trade research for income. Capitals have 20% stronger defences; capturing one shocks its empire's morale and can swing the entire war.</p>
  <h4>Diplomacy</h4><p>Declare war, offer peace, send envoys, form alliances, and sign trade pacts. Each trade pact or alliance adds 5% to income; you can have up to three trade partners. Wars automatically end trade. Allies join defensive wars, while AI empires may offer peace or trade and form coalitions against dominant powers.</p>
  <h4>Controls</h4><p>Drag to pan, scroll or pinch to zoom, double-click to zoom in. Space pauses; keys 1–4 set speed; M cycles map modes; Esc deselects or opens the menu; right-click cancels.</p>
  <h4>Map data</h4><p>Country boundaries are from Natural Earth (public domain), served by the world-atlas package, and drawn with the Equal Earth projection. Territories are generated subdivisions of real countries, not official provinces.</p></div>
  <div class="m-actions"><button class="btn primary" data-act="back">Close</button></div>`, { wide: true });
}
function confirmWar(x) {
  const e = G.empires[x], truce = G.truce[0][x] > G.day;
  const al = G.empires.filter(c => c.alive && c.id !== x && c.id !== 0 && allied(x, c.id) && !allied(0, c.id));
  showModal(`<div class="m-kick">Declaration of war</div><h2 class="m-title">${esc(e.name)}</h2>
  <p style="color:var(--dim);line-height:1.6">Their army: <b class="mono">${fmt(e.c.troops)}</b> &middot; Yours: <b class="mono">${fmt(PL().c.troops)}</b>.${al.length ? `<br>Their allies will join: <b>${al.map(c => esc(c.name)).join(', ')}</b>.` : ''}${truce ? '<br><span class="neg">Breaking the current truce will damage your standing with every empire.</span>' : ''}</p>
  <div class="m-actions"><button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn danger" data-act="dip-war-yes" data-v="${x}">${ic('swords', 14)} Declare War</button></div>`);
}
function gameOver(win) {
  const p = PL(), c = p.c;
  G.speed = 0; UI.resume = 0; if (!win) G.over = true;
  A.sfx(win ? 'victory' : 'alarm');
  const g = GOALS.find(x => x.k === G.goal);
  const cells = [['Territories (peak)', p.stats.peak], ['Population', fmt(c.pop)], ['GDP', '$' + fmt(c.gdp * 1e9)], ['Military', fmt(c.troops)], ['Navy', p.navy + ' ships'], ['Wars', p.stats.wars], ['Battles won', p.stats.won], ['Years survived', (G.day / 365).toFixed(1)]];
  showModal(`<div class="go ${win ? 'win' : 'lose'}"><div class="m-kick">${win ? 'Victory: ' + g.n : 'Defeat'}</div>
  <h2 class="go-title">${win ? 'Empire Complete' : 'Empire Fallen'}</h2>
  <p class="go-sub">${win ? `${esc(p.name)} stands as the dominant power on Earth.` : `${esc(p.name)} has been wiped from the map.`}</p>
  <div class="go-grid">${cells.map(([l, v]) => `<div><label>${l}</label><b>${v}</b></div>`).join('')}</div>
  <div class="m-actions" style="justify-content:center">${win ? '<button class="btn ghost" data-act="continue-play">Continue Playing</button>' : ''}<button class="btn ghost" data-act="to-menu">Main Menu</button><button class="btn" data-act="play-again">Play Again</button><button class="btn primary" data-act="new-world">New World</button></div></div>`,
    { wide: true, sticky: true, pause: false });
}

/* ---------------- menu & homeland pick ---------------- */
function refreshMenu() {
  const s = Save.latest(), m = s ? Save.meta(s) : null, b = $('#btnCont');
  b.disabled = !m;
  $('#contInfo').textContent = m ? `${m.name} · Day ${m.day} · ${DIFF[m.diff] ? DIFF[m.diff].name : ''}` : 'No saved campaign';
  if (WD) $('#menuMeta').innerHTML = `${WD.T.toLocaleString()} TERRITORIES<br>${WD.NC} COUNTRIES &amp; DEPENDENCIES<br>${WD.coastal.length} COASTAL REGIONS`;
}
function startPick() {
  G = null; UI.reset(); UI.pick = -1;
  if (!UI.found.name) UI.found.name = genName();
  markFill(); setState('pick'); flyTo(WD.MW / 2, WD.MH / 2, 1); renderFound();
}
function renderFound() {
  const el = $('#found'), t = UI.pick, f = UI.found;
  if (t < 0) {
    el.innerHTML = `<div class="ph">Found your empire</div><p class="empty-note">Select any territory on the map to make it your homeland. Coastal lands can build fleets early, mountains and forests are easier to defend, and islands begin isolated but safe.</p><div class="hint">Scroll to zoom &middot; drag to pan &middot; double-click to zoom in. Small islands are marked with rings.</div>`;
    return;
  }
  const tr = WD.terr[t];
  el.innerHTML = `<div class="ph">Found your empire</div><div class="f-name">${esc(tr.name)}</div>
  <div class="f-sub">${esc(WD.cname[tr.ci])} &middot; ${TERR[tr.terrain]}${tr.coastal ? ' &middot; Coastal' : ' &middot; Landlocked'}</div>
  <div class="kvs"><div class="kv"><span>Population</span><b>${fmt(tr.basePop)}</b></div><div class="kv"><span>Neighbours</span><b>${tr.nb.length}</b></div><div class="kv"><span>Defence</span><b>&times;${TDEF[tr.terrain]}</b></div><div class="kv"><span>Area</span><b>${fmt(tr.area * WD.km2)} km&sup2;</b></div></div>
  <div class="field"><label>Empire name</label><div class="inp"><input id="empName" maxlength="40" value="${esc(f.name)}" data-inp="emp-name" spellcheck="false"><button class="btn ghost" data-act="rand-name" title="Random name">${ic('dice', 14)}</button></div></div>
  <div class="field"><label>Colour</label><div class="swatches">${PLAYER_COLORS.map(c => `<button class="swatch ${c === f.color ? 'on' : ''}" style="background:${c}" data-act="pick-color" data-v="${c}"></button>`).join('')}</div></div>
  <div class="field"><label>Emblem</label><div class="embs">${EMB_KEYS.map(k => `<button class="emb ${k === f.emblem ? 'on' : ''}" data-act="pick-emblem" data-v="${k}">${emblemSVG(k, f.color, 18)}</button>`).join('')}</div></div>
  <div class="f-preview">${emblemSVG(f.emblem, f.color, 30)}<div style="min-width:0"><b id="fpName">${esc(f.name)}</b><div class="tb-sub">${DIFF[UI.setup.diff].name} &middot; ${GOALS.find(g => g.k === UI.setup.goal).n}</div></div></div>
  <div class="tp-actions"><button class="btn primary" data-act="found">${ic('crown', 14)} Found Empire</button></div>`;
}
function startGame() {
  if (UI.pick < 0) return;
  const f = UI.found;
  newGame({ diff: UI.setup.diff, goal: UI.setup.goal, doctrine: UI.setup.doctrine, start: UI.pick, name: (f.name || '').trim() || 'My Empire', color: f.color, emblem: f.emblem });
  enterGame(true);
}
function enterGame(fresh) {
  UI.reset(); UI.drawer = null; UI.resume = 0;
  $('#modal').classList.add('hide');
  R.mode = 'political'; R.masks.clear(); markFill();
  setState('game'); buildTopbar();
  const P = PL(); if (P.capital < 0) relocateCapital(P, false);
  if (P.capital >= 0) flyToTerr(P.capital, fresh ? 3.4 : 2.5);
  renderPanel(); renderDrawer(); renderLegend(); updateDock(); updateTopbar();
  toast(fresh ? `<b>${esc(P.name)}</b> is founded. Select your territory and expand into neighbouring lands.` : 'Campaign loaded', 'good');
  A.sfx('notify');
}

/* ---------------- top bar & dock ---------------- */
function buildStaticUI() {
  $('#btnMute').innerHTML = ic('vol', 17); $('#btnMenu').innerHTML = ic('menu', 17);
  $('#zoomctl').innerHTML = `<button class="ibtn" data-act="zoom-in" title="Zoom in">${ic('plus', 16)}</button><button class="ibtn" data-act="zoom-out" title="Zoom out">${ic('minus', 16)}</button><button class="ibtn" data-act="zoom-home" title="Whole world">${ic('globe', 16)}</button>`;
  const modes = [['political', 'flag', 'Political'], ['population', 'users', 'Population'], ['economy', 'trend', 'Economy'], ['resources', 'gem', 'Resources'], ['military', 'sword', 'Military'], ['diplomacy', 'scales', 'Diplomacy']];
  $('#dock').innerHTML = [['economy', 'trend', 'Economy'], ['military', 'shield', 'Military'], ['diplomacy', 'scales', 'Diplomacy'], ['stats', 'chart', 'Statistics']]
    .map(([k, i, n]) => `<button class="dk" data-act="drawer" data-v="${k}">${ic(i, 15)}<span>${n}</span></button>`).join('')
    + `<div class="dsep"></div><div class="modes">${modes.map(([k, i, n]) => `<button class="mode" data-act="map-mode" data-v="${k}" title="${n} map">${ic(i, 16)}</button>`).join('')}</div>`;
  const g = $('#tbGoal'); g.dataset.act = 'drawer'; g.dataset.v = 'stats';
}
function buildTopbar() {
  const P = PL();
  $('#tbEmb').innerHTML = emblemSVG(P.emblem, P.color, 24);
  $('#tbName').textContent = P.name;
  $('#tbName').title = P.name;
  $('#tbStats').innerHTML = [['users', 'Population', 'sPop'], ['trend', 'GDP', 'sGdp'], ['coin', 'Treasury', 'sTre'], ['sword', 'Army', 'sArm'], ['anchor', 'Navy', 'sNav'], ['map', 'Territories', 'sTer']]
    .map(([i, l, id]) => `<div class="stat" title="${l}">${ic(i, 16)}<div><label>${l}</label><b id="${id}">-</b></div></div>`).join('');
  $('#speedCtl').innerHTML = [0, 1, 2, 4, 8].map(v => `<button data-act="speed" data-v="${v}" title="${v ? v + 'x speed' : 'Pause (Space)'}">${v ? v + 'x' : ic('pause', 12)}</button>`).join('');
}
function updateTopbar() {
  if (STATE !== 'game' || !G || !$('#sPop')) return;
  const P = PL(), c = P.c;
  $('#tbSub').textContent = `${P.capital >= 0 ? WD.terr[P.capital].name : 'No capital'} · ${DIFF[G.diff].name}`;
  $('#sPop').textContent = fmt(c.pop);
  $('#sGdp').textContent = '$' + fmt(c.gdp * 1e9);
  const n = P.fin.net;
  $('#sTre').innerHTML = `${money(P.treasury)}<em class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : ''}${money(n)}</em>`;
  $('#sArm').textContent = fmt(c.troops);
  $('#sNav').textContent = `${P.navy - P.busy}/${P.navy}`;
  $('#sTer').textContent = c.terr;
  $('#tbDate').textContent = new Date(Date.UTC(CFG.START_YEAR, 0, 1) + G.day * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const pr = Math.min(100, goalProgress() * 100), gl = GOALS.find(x => x.k === G.goal);
  $('#tbGoal').innerHTML = `${ic('crown', 15)}<div class="gbar"><i style="width:${pr}%"></i></div><span>${pr.toFixed(0)}%</span>`;
  $('#tbGoal').title = `${gl.n}: ${gl.d}`;
  $$('#speedCtl button').forEach(b => b.classList.toggle('on', +b.dataset.v === G.speed));
  $('#btnMute').innerHTML = ic(S.muted ? 'mute' : 'vol', 17);
}
function updateDock() {
  $$('#dock .dk').forEach(b => b.classList.toggle('on', b.dataset.v === UI.drawer));
  $$('#dock .mode').forEach(b => b.classList.toggle('on', b.dataset.v === R.mode));
}
function setSpeed(v) { if (!G) return; G.speed = v; if (v > 0) UI.lastSpeed = v; updateTopbar(); }

/* ---------------- legend ---------------- */
function renderLegend() {
  const el = $('#legend');
  if (STATE !== 'game' || R.mode === 'political') { el.classList.add('hide'); return; }
  el.classList.remove('hide');
  const grad = (title, rmp, lo, hi) => `<div class="ph">${title}</div><div class="lg-bar" style="background:${rampCSS(rmp)}"></div><div class="lg-l"><span>${lo}</span><span>${hi}</span></div>`;
  const chips = (title, list) => `<div class="ph">${title}</div><div class="chips">${list.map(([c, n]) => `<span class="chip"><i style="background:${c}"></i>${n}</span>`).join('')}</div>`;
  el.innerHTML = {
    population: grad('Population density', RAMP_POP, '1 / km²', '1,500+ / km²'),
    economy: grad('Economic output', RAMP_ECO, 'Low GDP', 'High GDP'),
    military: grad('Military concentration', RAMP_MIL, 'Few troops', 'Massive armies'),
    resources: chips('Strategic resources', [...RES.map(r => [r.c, r.n]), ['#22262a', 'None']]),
    diplomacy: chips('Relations to you', [[PL().color, 'You'], ...ST_NAME.map((n, i) => [ST_COL[i], n]), ['#26292e', 'Unclaimed']])
  }[R.mode] || '';
}

/* ---------------- territory panel ---------------- */
function selectTerr(t) { UI.sel = t; UI.preview = null; UI.movePv = null; UI.mode = null; UI.build = false; renderPanel(); }
function deselect() { UI.sel = -1; UI.preview = null; UI.movePv = null; UI.mode = null; UI.build = false; renderPanel(); }
function onMapRightClick() { if (STATE === 'game') deselect(); }
function onMapClick(t) {
  A.sfx('click');
  if (STATE === 'pick') { if (t >= 0) { UI.pick = t; renderFound(); } return; }
  if (STATE !== 'game' || !G) return;
  if (t < 0) { deselect(); return; }
  const o = G.owner[t];
  if (UI.mode === 'move' && UI.sel >= 0) { if (o === 0 && t !== UI.sel) { openMove(UI.sel, t); return; } UI.mode = null; }
  if (o === 0) { selectTerr(t); return; }
  const src = UI.preview ? UI.preview.src : (UI.sel >= 0 && G.owner[UI.sel] === 0 ? UI.sel : -1);
  if (src >= 0 && prepareAttack(src, t)) return;
  selectTerr(t);
}
function prepareAttack(src, dst) {
  const o = G.owner[dst];
  if (o === 0) return false;
  if (o > 0 && allied(0, o)) { toast(`${esc(G.empires[o].name)} is your ally. Break the alliance first.`, 'bad'); return true; }
  if (WD.adjSet.has(pairKey(src, dst))) { UI.preview = { src, dst, naval: false, frac: UI.lastFrac }; UI.sel = src; renderPanel(); return true; }
  if (WD.terr[src].coastal && WD.terr[dst].coastal) {
    const path = seaPath(src, dst, navalRange(PL()));
    if (path) { UI.preview = { src, dst, naval: true, path, frac: UI.lastFrac }; UI.sel = src; renderPanel(); return true; }
    toast('No sea route within naval range', 'bad');
  }
  return false;
}
function findSource(dst) {
  let best = -1, bt = 0;
  for (const n of WD.terr[dst].nb) if (G.owner[n] === 0 && G.troops[n] > bt) { bt = G.troops[n]; best = n; }
  if (best >= 0) return { src: best, naval: false };
  if (!WD.terr[dst].coastal) return null;
  const srcs = [];
  for (let t = 0; t < WD.T; t++) if (G.owner[t] === 0 && WD.terr[t].coastal) srcs.push(t);
  srcs.sort((a, b) => G.troops[b] - G.troops[a]);
  for (const s of srcs.slice(0, 6)) { const path = seaPath(s, dst, navalRange(PL())); if (path) return { src: s, naval: true, path }; }
  return null;
}
const panelHead = (t, kicker) => {
  const tr = WD.terr[t];
  return `<div class="tp-head"><div style="min-width:0">${kicker ? `<div class="ph">${kicker}</div>` : ''}<div class="tp-name">${esc(tr.name)}</div><div class="tp-sub">${esc(WD.cname[tr.ci])} &middot; ${TERR[tr.terrain]}${tr.coastal ? ' &middot; Coastal' : ''}</div></div><button class="ibtn" data-act="deselect" title="Close">${ic('x')}</button></div>`;
};
const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
function missileOptions(dst) {
  const P = PL(), out = [];
  for (let src = 0; src < WD.T; src++) {
    if (G.owner[src] !== 0 || !G.silo[src]) continue;
    const distance = territoryDistance(src, dst);
    if (G.missile[src] && P.tech >= CFG.MISSILE_TECH && distance <= missileRange(P))
      out.push({ src, kind: 'missile', distance, range: missileRange(P) });
    if (G.nuke[src] && P.tech >= CFG.NUKE_TECH && distance <= missileRange(P, true))
      out.push({ src, kind: 'nuke', distance, range: missileRange(P, true) });
  }
  return out.sort((a, b) => a.distance - b.distance || (a.kind === 'missile' ? -1 : 1));
}

function renderPanel() {
  const el = $('#tpanel');
  if (STATE !== 'game' || !G || UI.sel < 0) { el.classList.add('hide'); return; }
  el.classList.remove('hide');
  if (UI.preview) { el.innerHTML = previewHTML(); updatePreview(); return; }
  if (UI.movePv) { el.innerHTML = moveHTML(); updateMove(); return; }
  const t = UI.sel, P = PL();
  if (G.owner[t] === 0 && UI.mode === 'move') {
    el.innerHTML = panelHead(t, 'Move army') + `<p class="empty-note">Select a destination territory you own. Land routes march through your territory; distant coasts are reached by transport fleet.</p><div class="tp-actions"><button class="btn ghost" data-act="cancel-move">Cancel</button></div>`;
    return;
  }
  if (G.owner[t] === 0) {
    const tr = WD.terr[t], amt = recruitAmt(t, P), rc = amt * CFG.RECRUIT_COST, ic_ = indCost(t), fc = fortCost(t), sc = shipCostOf(P);
    const policyName = Object.keys(COLONY_POLICIES)[G.colPolicy[t]] || 'balanced';
    const policy = COLONY_POLICIES[policyName] || COLONY_POLICIES.balanced;
    const income = (6 + gdpOf(t) * .25) * P.econ * doctrineOf(P).income * (G.colony[t] ? policy.income : 1);
    const facCost = factoryCost(t), facGain = G.pop[t] * 450 / 1e9;
    el.innerHTML = panelHead(t) + `<div class="tp-own">${ownerHTML(0)}${P.capital === t ? `<span class="pill" style="color:var(--gold)">Capital</span>` : ''}</div>
    ${G.colony[t] ? `<div class="colony-card">${ic('globe', 15)}<div><b>Overseas colony · ${policy.name}</b><span>${policy.desc} · ${Math.round(G.supply[t] * 100)}% supply</span><div class="col-policy">${Object.entries(COLONY_POLICIES).map(([k, v]) => `<button class="btn sm ${k === policyName ? 'on' : ''}" data-act="colony-policy" data-v="${k}">${v.name}</button>`).join('')}</div></div></div>` : ''}
    <div class="kvs">${kv('Population', fmt(G.pop[t]))}${kv('Local income', money(income) + '/d')}${kv('Local GDP', '$' + fmt(gdpOf(t) * 1e9))}${kv('Industry', G.ind[t].toFixed(1))}${kv('Factory output', G.fact[t] ? `Tier ${roman(G.fact[t])} · +$${fmt(facGain * 1e9)}/yr` : 'No factory')}${kv('Supply', Math.round(G.supply[t] * 100) + '%')}${kv('Garrison', fmtInt(G.troops[t]))}${kv('Manpower cap', fmt(capOf(t, P)))}${kv('Fortification', 'Lv ' + G.fort[t])}${G.silo[t] ? kv('Strategic arsenal', `${G.missile[t]}/3 missiles · ${G.nuke[t]} nuclear`) : ''}${kv('Terrain defence', '&times;' + TDEF[tr.terrain])}${kv('Doctrine defence', `${Math.round((doctrineOf(P).defense - 1) * 100)}%`)}${P.capital === t ? kv('Capital bonus', '+20%') : ''}</div>
    ${resChips(G.res[t])}
    <div class="tp-actions"><button class="btn" data-act="recruit" ${P.treasury < rc ? 'disabled' : ''} title="+${fmtInt(amt)} troops for ${money(rc)}">${ic('plus', 13)}Recruit</button><button class="btn ${UI.build ? 'on' : ''}" data-act="build-toggle">${ic('factory', 13)}Build</button><button class="btn" data-act="move-mode">${ic('move', 13)}Move</button></div>
    <div class="hint" style="margin-top:6px">Recruit adds ${fmtInt(amt)} troops for ${money(rc)}.</div>
    ${UI.build ? `<div class="build-row">
      <button class="btn sm factory-upgrade" data-act="build" data-v="factory" ${P.treasury < facCost || G.fact[t] >= CFG.FACTORY_MAX ? 'disabled' : ''}><span>${ic('factory', 14)} Factory Tier ${roman(G.fact[t])} → ${roman(G.fact[t] + 1)}<small>+$${fmt(facGain * 1e9)}/yr</small></span><small>${G.fact[t] >= CFG.FACTORY_MAX ? 'MAX TIER' : money(facCost)}</small></button>
      <button class="btn sm" data-act="build" data-v="ind" ${P.treasury < ic_ || G.ind[t] >= 100 ? 'disabled' : ''}><span>Expand industry +5</span><small>${money(ic_)}</small></button>
      <button class="btn sm" data-act="build" data-v="fort" ${P.treasury < fc || G.fort[t] >= 3 ? 'disabled' : ''}><span>Fortify to Lv ${Math.min(3, G.fort[t] + 1)}</span><small>${G.fort[t] >= 3 ? 'Max' : money(fc)}</small></button>
      ${tr.coastal ? `<button class="btn sm" data-act="build" data-v="ship" ${P.treasury < sc ? 'disabled' : ''}><span>Transport ship</span><small>${money(sc)}</small></button>` : ''}
      <div class="m-sub">Strategic weapons · ${P.tech < CFG.MISSILE_TECH ? `Research ${CFG.MISSILE_TECH.toFixed(2)} to unlock` : `Range ${fmtInt(missileRange(P))} km`}</div>
      ${!G.silo[t] ? `<button class="btn sm" data-act="build" data-v="silo" ${P.tech < CFG.MISSILE_TECH || P.treasury < CFG.SILO_COST ? 'disabled' : ''}><span>Build launch site</span><small>${P.tech < CFG.MISSILE_TECH ? `Tech ${CFG.MISSILE_TECH.toFixed(2)}` : money(CFG.SILO_COST)}</small></button>` : `<button class="btn sm" data-act="build" data-v="missile" ${P.tech < CFG.MISSILE_TECH || G.missile[t] >= 3 || P.treasury < CFG.MISSILE_COST ? 'disabled' : ''}><span>Produce missile · ${G.missile[t]}/3</span><small>${money(CFG.MISSILE_COST)}</small></button>
      <button class="btn sm" data-act="build" data-v="nuke" ${P.tech < CFG.NUKE_TECH || G.nuke[t] || P.treasury < CFG.NUKE_COST ? 'disabled' : ''}><span>Produce nuclear warhead · ${G.nuke[t] ? 'Stocked' : P.tech < CFG.NUKE_TECH ? `Tech ${CFG.NUKE_TECH.toFixed(2)}` : '1 per site'}</span><small>${money(CFG.NUKE_COST)}</small></button>`}</div>` : ''}
    <div class="hint">Click a highlighted neighbour to attack. Remote naval conquests become colonies: they earn more tax but recover troops more slowly. Factory tiers increase local GDP and show on the map when zoomed in.${tr.coastal ? ' This coast can launch overseas expeditions.' : ''}</div>`;
    return;
  }
  const o = G.owner[t], tr = WD.terr[t];
  const canAtk = !(o > 0 && allied(0, o));
  const owner = o >= 0 ? G.empires[o] : null, isCapital = owner && owner.capital === t;
  const strikeOptions = o > 0 && atWar(0, o) ? missileOptions(t) : [];
  el.innerHTML = panelHead(t) + `<div class="tp-own">${ownerHTML(o)}${statusPill(o)}${isCapital ? `<span class="pill" style="color:var(--gold)">Capital</span>` : ''}</div>
  <div class="kvs">${kv('Population', fmt(G.pop[t]))}${kv('Economy', '$' + fmt(gdpOf(t) * 1e9))}${kv('Industry', G.ind[t].toFixed(0))}${kv('Factory', G.fact[t] ? `Tier ${roman(G.fact[t])}` : 'None')}${kv('Military', fmtInt(G.troops[t]))}${kv('Fortification', 'Lv ' + G.fort[t])}${owner ? kv('Strategic arsenal', G.silo[t] ? `${G.missile[t]} missiles · ${G.nuke[t]} nuclear` : 'None') : ''}${kv('Terrain defence', '&times;' + TDEF[tr.terrain])}${owner ? kv('Doctrine defence', `${Math.round((doctrineOf(owner).defense - 1) * 100)}%`) : ''}${isCapital ? kv('Capital bonus', '+20%') : ''}${G.colony[t] ? kv('Administration', 'Overseas colony') : ''}${owner ? kv('Doctrine', DOCTRINES[owner.doctrine]?.name || 'Balanced') : ''}</div>
  ${resChips(G.res[t])}
  ${strikeOptions.length ? `<div class="m-sub">Available strategic strikes · max ${fmtInt(Math.max(...strikeOptions.map(x => x.range)))} km</div><div class="build-row">${strikeOptions.map(x => `<button class="btn sm ${x.kind === 'nuke' ? 'danger' : ''}" data-act="${x.kind === 'nuke' ? 'nuke-confirm' : 'missile-strike'}" data-v="${x.src}:${x.kind}">${x.kind === 'nuke' ? 'Nuclear strike' : 'Missile strike'} from ${esc(WD.terr[x.src].name)}<small>${fmtInt(x.distance)} / ${fmtInt(x.range)} km</small></button>`).join('')}</div>` : ''}
  <div class="tp-actions">${canAtk ? `<button class="btn primary" data-act="attack-from">${ic('swords', 14)} Attack</button>` : ''}</div>
  ${isCapital && canAtk ? '<div class="hint">Capital: 20% stronger defence. Capturing it will damage the empire morale.</div>' : canAtk ? '' : '<div class="hint">This territory belongs to your ally.</div>'}`;
}
function refreshPanel() {
  if (UI.sel < 0) return;
  if (UI.preview) updatePreview();
  else if (UI.movePv) updateMove();
  else if (UI.mode !== 'move') renderPanel();
}

/* ----- attack preview ----- */
function previewForce(p) {
  const P = PL(); let force = Math.floor(Math.max(0, G.troops[p.src] - 1) * p.frac), limit = '';
  const free = P.navy - P.busy;
  if (p.naval) { const cap = free * CFG.SHIP_CAP; if (force > cap) { force = cap; limit = free ? 'Limited by available transports' : 'Build transport ships in a coastal territory'; } }
  return { force, free, ships: Math.ceil(force / CFG.SHIP_CAP), mult: attMult(P, p.src, p.naval), limit };
}
function previewHTML() {
  const p = UI.preview, s = WD.terr[p.src], d = WD.terr[p.dst], o = G.owner[p.dst];
  const isCapital = o >= 0 && G.empires[o].capital === p.dst;
  const isColonialLanding = p.naval && o < 0;
  let warn = '';
  if (o > 0 && !atWar(0, o)) {
    const al = G.empires.filter(c => c.alive && c.id !== o && c.id !== 0 && allied(o, c.id) && !allied(0, c.id));
    warn = `Launching this attack declares war on <b>${esc(G.empires[o].name)}</b>.${al.length ? ` Their allies (${al.map(c => esc(c.name)).join(', ')}) will join.` : ''}`;
  }
  if (isCapital) warn += `${warn ? ' ' : ''}Capital objective: 20% stronger defence; capture damages national morale.`;
  return `<div class="tp-head"><div style="min-width:0"><div class="ph">${isColonialLanding ? 'Colonial expedition' : p.naval ? 'Naval invasion' : 'Attack'}</div><div class="tp-name">${esc(d.name)}</div><div class="tp-sub">${ownerHTML(o)}${isCapital ? ' · CAPITAL' : ''}</div></div><button class="ibtn" data-act="cancel-preview">${ic('x')}</button></div>
  <div class="route"><div><label>From</label><b>${esc(s.name)}</b></div>${ic(p.naval ? 'ship' : 'move', 18)}<div><label>To</label><b>${esc(d.name)}</b></div></div>
  <div class="srow"><label>Commit forces <b id="pvPct"></b></label><input type="range" min="5" max="100" value="${Math.round(p.frac * 100)}" data-inp="pv-frac" style="--p:${p.frac * 100}%"></div>
  <div class="vs"><div class="side me"><label>Your forces</label><b id="pvA"></b></div><div class="vsx">VS</div><div class="side them"><label>Defenders</label><b id="pvD"></b></div></div>
  <div class="kvs" id="pvK"></div><div class="outcome" id="pvOut"></div><div class="hint" id="pvLim"></div>${warn ? `<div class="warn">${ic('swords', 14)}<div>${warn}</div></div>` : ''}
  <div class="tp-actions"><button class="btn ghost" data-act="cancel-preview">Cancel</button><button class="btn primary" id="pvGo" data-act="launch">${isColonialLanding ? 'Found Colony' : p.naval ? 'Launch Invasion' : 'Launch Attack'}</button></div>`;
}
function updatePreview() {
  const p = UI.preview; if (!p) return;
  const o = G.owner[p.dst];
  if (G.owner[p.src] !== 0 || o === 0 || (o > 0 && allied(0, o))) { UI.preview = null; renderPanel(); return; }
  const P = PL(), f = previewForce(p), d = WD.terr[p.dst], dp = defPow(p.dst), ratio = f.force * f.mult / Math.max(1, dp);
  const key = Math.round(f.force / 250) + ':' + Math.round(dp / 250);
  if (p.ck !== key) { p.ck = key; p.chance = f.force >= 50 ? winChance(f.force, f.mult, p.dst) : 0; }
  $('#pvPct').textContent = Math.round(p.frac * 100) + '%';
  $('#pvA').textContent = fmtInt(f.force);
  $('#pvD').textContent = fmtInt(Math.max(0, G.troops[p.dst]));
  let rows = kv('Terrain', `${TERR[d.terrain]} &times;${TDEF[d.terrain]}`) + kv('Supply', Math.round((p.naval ? .64 : G.supply[p.src]) * 100) + '%') + kv('Fortification', 'Lv ' + G.fort[p.dst]);
  if (o >= 0) rows += kv('Doctrine defence', `${Math.round((doctrineOf(G.empires[o]).defense - 1) * 100)}%`);
  if (o >= 0 && G.empires[o].capital === p.dst) rows += kv('Capital defence', '+20%');
  rows += kv('Power ratio', ratio.toFixed(2));
  if (p.naval) rows += kv('Transports', `${f.ships} / ${f.free}`) + kv('Voyage', Math.ceil((p.path.length - 1) / (CFG.FLEET_SPEED * (1 + P.bonus[2]))) + ' days');
  $('#pvK').innerHTML = rows;
  const ch = p.chance, [lbl, col] = ch >= .9 ? ['Decisive', 'var(--green)'] : ch >= .65 ? ['Favorable', 'var(--green)'] : ch >= .4 ? ['Uncertain', 'var(--amber)'] : ch >= .15 ? ['Unfavorable', 'var(--red)'] : ['Hopeless', 'var(--red)'];
  $('#pvOut').innerHTML = `<div class="o-l"><span class="o-n" style="color:${col}">${lbl}</span><span class="o-p">&asymp; ${Math.round(ch * 100)}% victory</span></div><div class="obar"><i style="width:${ch * 100}%;background:${col}"></i></div>`;
  $('#pvLim').textContent = f.limit;
  $('#pvGo').disabled = f.force < (p.naval ? 500 : 50);
}
function launchPreview() {
  const p = UI.preview; if (!p) return;
  const P = PL(), f = previewForce(p), o = G.owner[p.dst];
  if (o > 0 && !atWar(0, o)) declareWar(0, o);
  const ok = p.naval ? launchFleet(P, p.src, p.dst, f.force, p.path) : launchAttack(P, p.src, p.dst, f.force);
  if (ok) { UI.lastFrac = p.frac; UI.preview = null; if (p.naval) toast(`Fleet departs for <b>${esc(WD.terr[p.dst].name)}</b>`, 'info'); renderPanel(); }
  else toast('Not enough forces or transports for this operation', 'bad');
}

/* ----- move army ----- */
function openMove(from, to) {
  const steps = landPath(0, from, to);
  if (steps >= 0) UI.movePv = { from, to, naval: false, steps, frac: .8 };
  else if (WD.terr[from].coastal && WD.terr[to].coastal) {
    const path = seaPath(from, to, navalRange(PL()));
    if (!path) { toast('No sea route within naval range', 'bad'); return; }
    UI.movePv = { from, to, naval: true, path, frac: .8 };
  } else { toast('No land or sea route between these territories', 'bad'); return; }
  UI.mode = null; renderPanel();
}
function moveCalc(m) {
  const P = PL(); let amt = Math.floor(Math.max(0, G.troops[m.from] - 1) * m.frac);
  const free = P.navy - P.busy;
  if (m.naval) amt = Math.min(amt, free * CFG.SHIP_CAP);
  const days = m.naval ? Math.ceil((m.path.length - 1) / (CFG.FLEET_SPEED * (1 + P.bonus[2]))) : Math.max(1, Math.ceil(m.steps * .7));
  return { amt, free, days };
}
function moveHTML() {
  const m = UI.movePv, a = WD.terr[m.from], b = WD.terr[m.to];
  return `<div class="tp-head"><div style="min-width:0"><div class="ph">${m.naval ? 'Sea transfer' : 'Move army'}</div><div class="tp-name">${esc(b.name)}</div></div><button class="ibtn" data-act="cancel-move">${ic('x')}</button></div>
  <div class="route"><div><label>From</label><b>${esc(a.name)}</b></div>${ic(m.naval ? 'ship' : 'move', 18)}<div><label>To</label><b>${esc(b.name)}</b></div></div>
  <div class="srow"><label>Troops to move <b id="mvPct"></b></label><input type="range" min="5" max="100" value="${Math.round(m.frac * 100)}" data-inp="mv-frac" style="--p:${m.frac * 100}%"></div>
  <div class="kvs" id="mvK"></div>
  <div class="tp-actions"><button class="btn ghost" data-act="cancel-move">Cancel</button><button class="btn primary" id="mvGo" data-act="confirm-move">Confirm Move</button></div>`;
}
function updateMove() {
  const m = UI.movePv; if (!m) return;
  if (G.owner[m.from] !== 0 || G.owner[m.to] !== 0) { UI.movePv = null; renderPanel(); return; }
  const c = moveCalc(m);
  $('#mvPct').textContent = Math.round(m.frac * 100) + '%';
  $('#mvK').innerHTML = kv('Troops', fmtInt(c.amt)) + kv('Arrival', c.days + (c.days === 1 ? ' day' : ' days')) + kv('Route', m.naval ? 'Sea' : m.steps + ' regions') + (m.naval ? kv('Transports', `${Math.ceil(c.amt / CFG.SHIP_CAP)} / ${c.free}`) : '');
  $('#mvGo').disabled = c.amt < (m.naval ? 500 : 50);
}
function confirmMove() {
  const m = UI.movePv; if (!m) return;
  const P = PL(), c = moveCalc(m);
  let ok = false;
  if (m.naval) ok = launchFleet(P, m.from, m.to, c.amt, m.path);
  else if (c.amt >= 50) { G.troops[m.from] -= c.amt; G.moves.push({ id: G.nid++, e: 0, from: m.from, to: m.to, amount: c.amt, arrive: G.day + c.days }); ok = true; }
  if (ok) { UI.movePv = null; UI.sel = m.to; renderPanel(); } else toast('Not enough troops or transports', 'bad');
}

/* ---------------- drawers ---------------- */
function renderDrawer() {
  const el = $('#drawer'); updateDock();
  if (STATE !== 'game' || !G || !UI.drawer) { el.classList.add('hide'); return; }
  el.classList.remove('hide');
  const head = (i, n) => `<div class="dr-head"><div class="ph" style="display:flex;gap:8px;align-items:center">${ic(i, 15)}${n}</div><button class="ibtn" data-act="close-drawer">${ic('x')}</button></div>`;
  const P = PL(), c = P.c;
  if (UI.drawer === 'economy') {
    const f = P.fin;
    el.innerHTML = head('trend', 'Economy') + `<div class="bigstat"><div><label>GDP / year</label><b>$${fmt(c.gdp * 1e9)}</b></div><div><label>Income / day</label><b>${money(f.income)}</b></div><div><label>Treasury</label><b class="${P.treasury < 0 ? 'neg' : ''}">${money(P.treasury)}</b></div></div>
    ${kv('Trade income', '+' + money(f.trade || 0) + '/d')}${kv('Military budget', '-' + money(f.milB) + '/d')}${kv('Research budget', '-' + money(f.resB) + '/d')}${kv('Troop & fleet upkeep', '-' + money(f.upk) + '/d')}${kv('Net balance', `<span class="${f.net >= 0 ? 'pos' : 'neg'}">${f.net >= 0 ? '+' : ''}${money(f.net)}/d</span>`)}
      ${kv('National doctrine', DOCTRINES[P.doctrine]?.name || 'Balanced')}<p class="hint">${DOCTRINES[P.doctrine]?.desc || 'No special modifiers.'}</p>
      <div class="srow"><label>Military spending <b>${Math.round(P.mil * 100)}%</b></label><input type="range" min="0" max="60" value="${Math.round(P.mil * 100)}" data-inp="mil" style="--p:${P.mil / .6 * 100}%"><p>Raises manpower caps and recruitment speed; slows industrial growth.</p></div>
    <div class="srow"><label>Research spending <b>${Math.round(P.research * 100)}%</b></label><input type="range" min="0" max="40" value="${Math.round(P.research * 100)}" data-inp="research" style="--p:${P.research / .4 * 100}%"><p>Technology level <b class="mono">${P.tech.toFixed(3)}</b> multiplies attack and defence.</p></div>
    <div class="m-sub">Strategic resources</div>
    <table class="tbl">${RES.map((r, k) => `<tr><td><span class="chip"><i style="background:${r.c}"></i>${r.n}</span></td><td class="n">${c.res[k]}</td><td class="n pos">+${Math.round(P.bonus[k] * 100)}%</td><td style="color:var(--mute);font-size:11px">${RES_FX[k][2]}</td></tr>`).join('')}</table>`;
  } else if (UI.drawer === 'military') {
    let sup = 0; for (let t = 0; t < WD.T; t++) if (G.owner[t] === 0) sup += G.supply[t];
    const ops = [];
    const row = (t, i, txt, val, col) => `<div class="op" data-act="focus" data-v="${t}"><span style="display:flex;gap:7px;align-items:center;${col ? 'color:' + col : ''}">${ic(i, 13)}${txt}</span><small>${val}</small></div>`;
    for (const b of G.battles) {
      if (b.e === 0) ops.push(row(b.dst, 'swords', `${b.naval ? 'Landing at' : 'Assault on'} ${esc(WD.terr[b.dst].name)}`, `${fmt(b.force)} vs ${fmt(Math.max(0, G.troops[b.dst]))}`));
      else if (G.owner[b.dst] === 0) ops.push(row(b.dst, 'shield', `Defending ${esc(WD.terr[b.dst].name)}`, `${fmt(Math.max(0, G.troops[b.dst]))} vs ${fmt(b.force)}`, '#f0a093'));
    }
    for (const f of G.fleets) if (f.e === 0) ops.push(row(f.dst, 'ship', `Fleet to ${esc(WD.terr[f.dst].name)}`, `${fmt(f.force)} &middot; ${Math.ceil((f.path.length - 1 - f.pos) / (CFG.FLEET_SPEED * (1 + P.bonus[2])))}d`));
    for (const m of G.moves) if (m.e === 0 && !m.ai) ops.push(row(m.to, 'move', `Marching to ${esc(WD.terr[m.to].name)}`, `${fmt(m.amount)} &middot; ${Math.max(0, m.arrive - G.day)}d`));
    for (const s of G.strikes) if (s.e === 0 || G.owner[s.dst] === 0) ops.push(row(s.dst, 'swords', `${s.kind === 'nuke' ? 'Nuclear strike' : 'Missile'} ${s.e === 0 ? 'to' : 'incoming at'} ${esc(WD.terr[s.dst].name)}`, `${Math.max(0, s.arrive - G.day)}d`, s.e === 0 ? '' : '#f0a093'));
    let sites = 0, missiles = 0, warheads = 0;
    for (let t = 0; t < WD.T; t++) if (G.owner[t] === 0) { sites += G.silo[t]; missiles += G.missile[t]; warheads += G.nuke[t]; }
    el.innerHTML = head('shield', 'Military') + `<div class="bigstat"><div><label>Army</label><b>${fmt(c.troops)}</b></div><div><label>Transports</label><b>${P.navy - P.busy}/${P.navy}</b></div><div><label>Morale</label><b>${Math.round(P.morale * 100)}%</b></div></div>
    ${kv('Technology', P.tech.toFixed(3))}${kv('Average supply', Math.round(sup / Math.max(1, c.terr) * 100) + '%')}${kv('Military spending', Math.round(P.mil * 100) + '%')}${kv('Naval range', navalRange(P) * CFG.CELL * Math.round(WD.km2 ** .5) + ' km')}${kv('Battles won / lost', `${P.stats.won} / ${P.stats.lost}`)}
    <div class="tp-actions"><button class="btn" data-act="build-ship" ${c.coastal && P.treasury >= shipCostOf(P) ? '' : 'disabled'}>${ic('ship', 14)} Build transport <small>${money(shipCostOf(P))}</small></button></div>
    <div class="m-sub">Strategic weapons</div>${kv('Launch sites', sites)}${kv('Conventional missiles', missiles + ' / ' + sites * 3)}${kv('Nuclear warheads', warheads + ' / ' + sites)}${kv('Missile range', P.tech >= CFG.MISSILE_TECH ? fmtInt(missileRange(P)) + ' km' : `Unlock at tech ${CFG.MISSILE_TECH.toFixed(2)}`)}${kv('Nuclear range', P.tech >= CFG.NUKE_TECH ? fmtInt(missileRange(P, true)) + ' km' : `Unlock at tech ${CFG.NUKE_TECH.toFixed(2)}`)}
    <div class="m-sub">Active operations</div>${ops.length ? ops.join('') : '<p class="hint">No operations under way. Select a territory to plan an attack.</p>'}`;
  } else if (UI.drawer === 'diplomacy') {
    const bd = empireBorders(), mineB = bd[0], ai = G.empires.filter(e => e.alive && !e.player);
    ai.sort((a, b) => (atWar(0, b.id) - atWar(0, a.id)) || (mineB.has(b.id) - mineB.has(a.id)) || (strength(b) - strength(a)));
    el.innerHTML = head('scales', 'Diplomacy') + `<p class="hint" style="margin:0 0 6px">Trade pacts and alliances each add 5% income; you may sign up to three trade pacts. Envoys improve relations. Allies join defensive wars, and attacks against a trade partner end the pact.</p>` + ai.map(e => {
      const s = relStatus(0, e.id), op = G.op[0][e.id], truce = G.truce[0][e.id] > G.day;
      const trade = !!G.trade[0][e.id], canTrade = !trade && s !== ST.WAR && s !== ST.ALLIED && op >= 0 && tradeCount(0) < 3 && tradeCount(e.id) < 3;
      let acts;
      if (s === ST.WAR) acts = `<button class="btn sm" data-act="dip-peace" data-v="${e.id}">Offer Peace</button>`;
      else if (s === ST.ALLIED) acts = `<button class="btn sm danger" data-act="dip-break" data-v="${e.id}">Break Alliance</button><button class="btn sm" data-act="dip-envoy" data-v="${e.id}" ${P.treasury < CFG.ENVOY_COST ? 'disabled' : ''}>Envoy <small>${money(CFG.ENVOY_COST)}</small></button>`;
      else acts = `<button class="btn sm danger" data-act="dip-war" data-v="${e.id}">Declare War</button><button class="btn sm" data-act="dip-ally" data-v="${e.id}">Propose Alliance</button><button class="btn sm" data-act="dip-envoy" data-v="${e.id}" ${P.treasury < CFG.ENVOY_COST ? 'disabled' : ''}>Envoy <small>${money(CFG.ENVOY_COST)}</small></button>`;
      if (trade) acts += `<button class="btn sm" data-act="dip-trade-end" data-v="${e.id}">End Trade Pact</button>`;
      else if (s !== ST.WAR && s !== ST.ALLIED) acts += `<button class="btn sm" data-act="dip-trade" data-v="${e.id}" ${canTrade ? '' : 'disabled'}>Trade Pact · +5% income</button>`;
      const agreements = `${s === ST.ALLIED ? ' · alliance trade' : ''}${trade ? ' · trade pact' : ''}`;
      return `<div class="dip"><div class="dip-top">${emblemSVG(e.emblem, e.color, 26)}<div class="nm"><b>${esc(e.name)}</b><span>${DOCTRINES[e.doctrine]?.name || 'Balanced'} · ${e.c.terr} terr · ${fmt(e.c.troops)} troops${mineB.has(e.id) ? ' · border' : ''}${agreements}${truce ? ' · truce ' + (G.truce[0][e.id] - G.day) + 'd' : ''} · opinion ${Math.round(op)}</span><div class="opbar"><i style="left:${op < 0 ? 50 + op / 2 : 50}%;width:${Math.abs(op) / 2}%;background:${op < 0 ? 'var(--red)' : 'var(--green)'}"></i></div></div><span class="pill" style="color:${ST_COL[s]}">${ST_NAME[s]}</span></div><div class="dip-act">${acts}</div></div>`;
    }).join('');
  } else if (UI.drawer === 'stats') {
    const tabs = [['terr', 'Territory'], ['pop', 'Population'], ['gdp', 'GDP'], ['mil', 'Military'], ['navy', 'Navy'], ['res', 'Resources']];
    const val = { terr: e => e.c.area, pop: e => e.c.pop, gdp: e => e.c.gdp, mil: e => e.c.troops, navy: e => e.navy, res: e => e.c.res.reduce((a, b) => a + b, 0) }[UI.statTab];
    const show = { terr: e => `${e.c.terr} &middot; ${(e.c.area / WD.landArea * 100).toFixed(1)}%`, pop: e => fmt(e.c.pop), gdp: e => '$' + fmt(e.c.gdp * 1e9), mil: e => fmt(e.c.troops), navy: e => e.navy + ' ships', res: e => val(e) }[UI.statTab];
    const list = G.empires.filter(e => e.alive).sort((a, b) => val(b) - val(a)), top = val(list[0]) || 1;
    const rank = list.findIndex(e => e.player) + 1;
    const rows = list.slice(0, 12); if (rank > 12) rows.push(P);
    const g = GOALS.find(x => x.k === G.goal), pr = Math.min(100, goalProgress() * 100);
    el.innerHTML = head('chart', 'World statistics') + `<div class="bigstat"><div><label>Year</label><b>${CFG.START_YEAR + Math.floor(G.day / 365)}</b></div><div><label>Empires left</label><b>${list.length}/${G.empires.length}</b></div><div><label>Your rank</label><b>#${rank}</b></div></div>
    <div class="kv"><span>${ic('crown', 13)}</span><b style="font-family:var(--ff);font-weight:600">${g.n}: ${pr.toFixed(1)}%</b></div><div class="sbar" style="margin-bottom:12px"><i style="width:${pr}%;background:var(--gold)"></i></div>
    <div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${k === UI.statTab ? 'on' : ''}" data-act="stat-tab" data-v="${k}">${n}</button>`).join('')}</div>
    <table class="tbl">${rows.map(e => `<tr class="${e.player ? 'me' : ''}"><td class="rk">${list.indexOf(e) + 1}</td><td><span class="own"><i style="background:${e.color}"></i>${esc(e.name)}</span><div class="sbar"><i style="width:${val(e) / top * 100}%;background:${e.color}"></i></div></td><td class="n">${show(e)}</td></tr>`).join('')}</table>`;
  }
}

/* ---------------- actions (event delegation) ---------------- */
const ACT = {
  'new-game': () => openSetup(),
  'continue': () => { const s = Save.latest(); if (s && Save.load(s)) enterGame(false); },
  'load-menu': () => openLoad(false),
  'settings': () => { UI.backTo = STATE === 'game' ? 'pause' : null; openSettings(); },
  'howto': () => { UI.backTo = STATE === 'game' ? 'pause' : null; openHowto(); },
  'close-modal': () => closeModal(),
  'back': () => { if (UI.backTo === 'pause' && STATE === 'game') openPause(); else closeModal(); },
  'set-diff': v => { UI.setup.diff = v; openSetup(); },
  'set-goal': v => { UI.setup.goal = v; openSetup(); },
  'set-doctrine': v => { if (DOCTRINES[v]) { UI.setup.doctrine = v; openSetup(); } },
  'to-pick': () => { closeModal(true); startPick(); },
  'pick-back': () => { setState('menu'); openSetup(); },
  'rand-name': () => { UI.found.name = genName(); renderFound(); },
  'pick-color': v => { UI.found.color = v; renderFound(); },
  'pick-emblem': v => { UI.found.emblem = v; renderFound(); },
  'found': () => startGame(),
  'speed': v => setSpeed(+v),
  'mute': () => { S.muted = !S.muted; saveSettings(); A.apply(); updateTopbar(); },
  'pause-menu': () => openPause(),
  'resume': () => closeModal(),
  'save': () => { Save.save('manual'); openPause(); },
  'load-game': () => openLoad(true),
  'do-load': v => { if (Save.load(v)) { closeModal(true); enterGame(false); } },
  'quit': () => { Save.save('auto', true); closeModal(true); G = null; UI.reset(); markFill(); setState('menu'); },
  'to-menu': () => { closeModal(true); G = null; UI.reset(); markFill(); setState('menu'); },
  'continue-play': () => { closeModal(true); setSpeed(1); },
  'play-again': () => { closeModal(true); startPick(); },
  'new-world': () => { closeModal(true); G = null; markFill(); setState('menu'); openSetup(); },
  'drawer': v => { UI.drawer = UI.drawer === v ? null : v; renderDrawer(); },
  'close-drawer': () => { UI.drawer = null; renderDrawer(); },
  'map-mode': v => { setMapMode(v); renderLegend(); updateDock(); },
  'zoom-in': () => zoomAt(R.vw / 2, R.vh / 2, 1.6),
  'zoom-out': () => zoomAt(R.vw / 2, R.vh / 2, 1 / 1.6),
  'zoom-home': () => flyTo(WD.MW / 2, WD.MH / 2, 1),
  'deselect': () => deselect(),
  'recruit': () => { if (!actRecruit(UI.sel)) toast('Not enough funds', 'bad'); renderPanel(); },
  'build-toggle': () => { UI.build = !UI.build; renderPanel(); },
  'build': v => { if (!actBuild(UI.sel, v)) toast('Not enough funds', 'bad'); renderPanel(); },
  'colony-policy': v => { if (!setColonyPolicy(UI.sel, v)) toast('Colony policy could not be changed', 'bad'); renderPanel(); },
  'build-ship': () => {
    let best = -1, bt = -1;
    for (let t = 0; t < WD.T; t++) if (G.owner[t] === 0 && WD.terr[t].coastal && G.troops[t] > bt) { bt = G.troops[t]; best = t; }
    if (best < 0 || !actBuild(best, 'ship')) toast('Cannot build a transport right now', 'bad');
    renderDrawer();
  },
  'move-mode': () => { UI.mode = 'move'; renderPanel(); },
  'cancel-move': () => { UI.mode = null; UI.movePv = null; renderPanel(); },
  'confirm-move': () => confirmMove(),
  'attack-from': () => {
    const t = UI.sel, f = findSource(t);
    if (!f) { toast('No bordering territory or sea route can reach this land', 'bad'); return; }
    UI.preview = { src: f.src, dst: t, naval: f.naval, path: f.path, frac: UI.lastFrac };
    renderPanel();
  },
  'cancel-preview': () => { UI.preview = null; renderPanel(); },
  'launch': () => launchPreview(),
  'focus': v => flyToTerr(+v),
  'dip-war': v => confirmWar(+v),
  'dip-war-yes': v => { declareWar(0, +v); closeModal(); renderDrawer(); },
  'dip-peace': v => { playerOfferPeace(+v); renderDrawer(); },
  'dip-ally': v => { playerProposeAlliance(+v); renderDrawer(); },
  'dip-envoy': v => { if (!playerEnvoy(+v)) toast('Not enough funds', 'bad'); renderDrawer(); },
  'dip-break': v => { playerBreakAlliance(+v); renderDrawer(); },
  'dip-trade': v => { if (!playerTradePact(+v)) toast('Trade pact unavailable: improve relations or free a treaty slot', 'bad'); renderDrawer(); },
  'dip-trade-end': v => { playerEndTrade(+v); renderDrawer(); },
  'missile-strike': v => {
    const [src, kind] = v.split(':');
    if (!launchStrategicStrike(PL(), +src, UI.sel, kind)) toast('Missile strike is no longer available or the target is out of range', 'bad');
    renderPanel();
  },
  'nuke-confirm': v => {
    const [src] = v.split(':');
    const dst = UI.sel, distance = territoryDistance(+src, dst);
    showModal(`<div class="m-kick">Strategic weapons authorization</div><h2 class="m-title">Confirm nuclear strike</h2>
      <p class="hint">Launch from <b>${esc(WD.terr[+src].name)}</b> against <b>${esc(WD.terr[dst].name)}</b>?</p>
      <div class="kvs">${kv('Range', `${fmtInt(distance)} / ${fmtInt(missileRange(PL(), true))} km`)}${kv('Travel time', `${Math.max(1, Math.ceil(distance / 8000))} days`)}${kv('Warhead effect', 'Severe garrison and infrastructure damage')}${kv('Diplomatic cost', 'Global opinion penalty')}</div>
      <p class="warn">This is an irreversible in-game action and requires an active war.</p>
      <div class="m-actions"><button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn danger" data-act="nuke-fire" data-v="${src}:nuke">Authorize strike</button></div>`);
  },
  'nuke-fire': v => {
    const [src, kind] = v.split(':');
    const target = UI.sel;
    if (launchStrategicStrike(PL(), +src, target, kind)) { closeModal(); renderPanel(); }
    else { closeModal(); toast('Nuclear strike is no longer available or the target is out of range', 'bad'); }
  },
  'stat-tab': v => { UI.statTab = v; renderDrawer(); },
  'offer': (v, el) => { const [i, a] = v.split(':'); if (G) respondOffer(+i, a === '1'); const t = el.closest('.toast'); if (t) t.remove(); renderDrawer(); },
  'toggle': v => { S[v] = !S[v]; saveSettings(); A.apply(); R.baseDirty = true; if (v === 'music' && S.music && A.mode) { const m = A.mode; A.mode = null; A.music(m); } openSettings(); }
};
document.addEventListener('click', e => {
  if (e.target.id === 'modal' && !(UI.modal && UI.modal.sticky)) { ACT.back(); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const f = ACT[el.dataset.act]; if (!f) return;
  A.init(); A.sfx('click');
  f(el.dataset.v, el);
});
document.addEventListener('input', e => {
  const el = e.target, k = el.dataset && el.dataset.inp; if (!k) return;
  const v = +el.value;
  if (el.type === 'range') el.style.setProperty('--p', ((v - el.min) / (el.max - el.min) * 100) + '%');
  if (k === 'pv-frac' && UI.preview) { UI.preview.frac = v / 100; updatePreview(); }
  else if (k === 'mv-frac' && UI.movePv) { UI.movePv.frac = v / 100; updateMove(); }
  else if (k === 'mil' && G) { PL().mil = v / 100; el.previousElementSibling.querySelector('b').textContent = v + '%'; }
  else if (k === 'research' && G) { PL().research = v / 100; el.previousElementSibling.querySelector('b').textContent = v + '%'; }
  else if (k === 'volume') { S.volume = v / 100; saveSettings(); A.apply(); el.previousElementSibling.querySelector('b').textContent = v + '%'; }
  else if (k === 'emp-name') { UI.found.name = el.value; const n = $('#fpName'); if (n) n.textContent = el.value; }
});
// prevent periodic re-render while the user is dragging a slider or pressing a panel button
document.addEventListener('pointerdown', e => { A.init(); if (e.target.closest('.lockable')) UI.lock = true; });
document.addEventListener('pointerup', () => setTimeout(() => { UI.lock = false; }, 250));
document.addEventListener('keydown', e => {
  A.init();
  if (e.target.tagName === 'INPUT') { if (e.key === 'Enter' && STATE === 'pick') startGame(); return; }
  const modalOpen = !$('#modal').classList.contains('hide');
  if (e.key === 'Escape') {
    if (modalOpen) { if (!(UI.modal && UI.modal.sticky)) ACT.back(); return; }
    if (STATE === 'game') {
      if (UI.preview || UI.movePv || UI.mode || UI.sel >= 0) deselect();
      else if (UI.drawer) { UI.drawer = null; renderDrawer(); }
      else openPause();
    } else if (STATE === 'pick') ACT['pick-back']();
    return;
  }
  if (STATE !== 'game' || !G || modalOpen) return;
  if (e.code === 'Space') { e.preventDefault(); setSpeed(G.speed ? 0 : (UI.lastSpeed || 1)); }
  else if (e.key >= '1' && e.key <= '4') setSpeed([1, 2, 4, 8][+e.key - 1]);
  else if (e.key === '+' || e.key === '=') zoomAt(R.vw / 2, R.vh / 2, 1.5);
  else if (e.key === '-') zoomAt(R.vw / 2, R.vh / 2, 1 / 1.5);
  else if (e.key === 'm' || e.key === 'M') {
    const ms = ['political', 'population', 'economy', 'resources', 'military', 'diplomacy'];
    setMapMode(ms[(ms.indexOf(R.mode) + 1) % ms.length]); renderLegend(); updateDock();
  }
});

/* ---------------- main loop ---------------- */
let lastT = performance.now(), acc = 0;
function uiTick(now) {
  if (STATE !== 'game' || !G) return;
  if (now - UI.t1 > 250) { UI.t1 = now; updateTopbar(); }
  if (now - UI.t2 > 700) { UI.t2 = now; if (!UI.lock) { refreshPanel(); if (UI.drawer) renderDrawer(); } }
}
function loop(now) {
  const dt = Math.min(.1, (now - lastT) / 1000); lastT = now;
  try {
    if (STATE === 'game' && G && !G.over && G.speed > 0) {
      acc += dt * 1000;
      const dm = CFG.DAY_MS / G.speed; let n = 0;
      try {
        while (acc >= dm && n < 8 && G && !G.over && G.speed > 0) { simDay(); acc -= dm; n++; }
      } catch (err) {
        console.error(err);
        G.speed = 0; acc = 0;
        toast(`Simulation paused after an unexpected error: ${esc(err.message || 'Unknown error')}`, 'bad', { ttl: 12000 });
        updateTopbar();
      }
      if (n >= 8) acc = 0;
    } else acc = 0;
    renderFrame(now, dt);
    uiTick(now);
  } catch (err) { console.error(err); }
  requestAnimationFrame(loop);
}

/* ---------------- boot ---------------- */
(async function boot() {
  const prog = (p, m) => { $('#ldFill').style.width = (p * 100) + '%'; $('#ldMsg').textContent = m; };
  try {
    if (!window.d3 || !window.topojson) throw new Error('Could not load the d3 / topojson libraries from cdnjs.');
    if (typeof d3.geoEqualEarth !== 'function') throw new Error('This d3 build lacks the Equal Earth projection.');
    const topo = await loadTopo(prog);
    WD = await buildWorld(topo, prog);
  } catch (err) {
    $('#ldMsg').innerHTML = `<div class="ld-err">${esc(err.message)}<br>Check your connection, or place <b>countries-50m.json</b> (from the world-atlas package) next to index.html.</div><button class="btn" style="margin-top:14px" onclick="location.reload()">Retry</button>`;
    return;
  }
  initRender(); buildStaticUI(); compose(); setState('menu');
  requestAnimationFrame(loop);
})();