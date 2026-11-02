// Main menu + loading screen behaviour (markup in index.html, look in style.css):
//  - fills the game name / subtitle from brand.js
//  - view switching: home (title + nav) → skirmish setup / settings, Esc or Back returns
//  - the animated backdrop (backdrop.js) runs only while the menu or the loading screen is visible
//  - skirmish detail panel mirrors the selected map card (big preview + objectives)
//  - loading screen field notes
// main.js keeps owning the actual launch logic (#startBtn, #campaignBtn, #versusBtn, #quality, #mapPick).
import { applyBrand } from './brand.js';
import { Backdrop } from './backdrop.js';

const $ = id => document.getElementById(id);
applyBrand();

// ---------------------------------------------------------------- views
const menu = $('menu');
const CRUMB = { home: '', skirmish: 'Skirmish', settings: 'Settings & controls' };
export function showView(v, focus = true) {
  if (!menu || !CRUMB.hasOwnProperty(v)) return;
  menu.dataset.view = v;
  const c = $('menuCrumb'); if (c) c.textContent = CRUMB[v];
  const sec = menu.querySelector(`.mv[data-v="${v}"]`);
  for (const s of menu.querySelectorAll('.mv')) s.inert = s !== sec;
  if (focus) requestAnimationFrame(() => (v === 'home' ? $('skirmishBtn') : sec?.querySelector(v === 'skirmish' ? '#startBtn' : 'select'))?.focus({ preventScroll: true }));
}
if (menu) {
  $('skirmishBtn')?.addEventListener('click', () => showView('skirmish'));
  $('settingsBtn')?.addEventListener('click', () => showView('settings'));
  for (const b of menu.querySelectorAll('[data-back]')) b.addEventListener('click', () => showView('home'));
  menu.querySelector('.mt-home')?.addEventListener('click', () => showView('home'));
  addEventListener('keydown', e => {
    if (menu.classList.contains('hidden')) return;
    if (e.key === 'Escape' && menu.dataset.view !== 'home') { e.preventDefault(); showView('home'); }
  });
  showView(new URLSearchParams(location.search).get('menu') || 'home', false);   // ?menu=skirmish opens straight into a view (screenshots)
}

// ---------------------------------------------------------------- graphics preset persists between visits
const q = $('quality');
if (q) {
  try { const v = localStorage.getItem('smo_quality'); if (v && [...q.options].some(o => o.value === v)) q.value = v; } catch { }
  q.addEventListener('change', () => { try { localStorage.setItem('smo_quality', q.value); } catch { } });
}

// ---------------------------------------------------------------- skirmish detail: mirror the selected map card
const pick = $('mapPick'), big = $('mapBig');
let lastSel = null;
function syncMap() {
  const card = pick?.querySelector('.mapcard.sel'); if (!card) return;
  const src = card.querySelector('canvas');
  if (big && src && (card !== lastSel || !big._drawn)) {
    const x = big.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.clearRect(0, 0, big.width, big.height); x.drawImage(src, 0, 0, big.width, big.height); big._drawn = true;
    big.parentElement.classList.remove('swap'); void big.offsetWidth; big.parentElement.classList.add('swap');
  }
  const objs = $('mapObjs'), mo = card.querySelector('.mc-obj');
  if (objs && mo && objs._src !== mo.innerHTML) { objs._src = mo.innerHTML; objs.innerHTML = mo.innerHTML; }
  lastSel = card;
}
if (pick) new MutationObserver(syncMap).observe(pick, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

// ---------------------------------------------------------------- backdrop: live only while menu / loading are up
const bgc = $('menuBg'), loading = $('loading');
const bg = bgc ? new Backdrop(bgc) : null; window.__backdrop = bg;   // test hook
function syncBg() {
  if (!bg) return;
  const m = menu && !menu.classList.contains('hidden'), l = loading && !loading.classList.contains('hidden');
  bgc.classList.toggle('on', m || l);
  if (m || l) bg.start(l ? 'loading' : 'menu'); else bg.stop();
  if (l) tips.start(); else tips.stop();
}

// ---------------------------------------------------------------- loading screen field notes
const TIPS = [
  'Every objective you hold drains enemy tickets; every man and vehicle you lose costs your own. The side that runs dry breaks.',
  'Squads that lose their nerve will break and run. Pull them back behind cover and they will rally.',
  'Pinned infantry cannot advance. Suppress the enemy back with a second squad, smoke, or the mortar.',
  'Ammunition is limited: send squads back to their carrier with B to resupply.',
  'Garrisoned buildings and trenches protect the men inside — until the walls come down.',
  'Right-drag on the ground to set out a formation line facing the drag direction.',
  'ATGM teams need to halt and set up before they can fire. Keep them back from the line of contact.',
  'FPV teams carry three drones. Right-click a spotted vehicle to choose the target.',
  'Smoke (V) blocks line of sight both ways — use it to cross open ground.',
  'Armour without infantry is vulnerable in towns. Keep squads close to the tanks.',
  'Wounded must be pulled back: a casualty left in the open costs you the men who go to get him.',
  'Space pauses the battle. You can still give orders while paused.',
];
const tips = {
  i: Math.floor(Math.random() * TIPS.length), iv: 0,
  show() { const el = $('loadTip'); if (!el) return; el.classList.remove('in'); void el.offsetWidth; el.textContent = TIPS[this.i++ % TIPS.length]; el.classList.add('in'); },
  start() { if (this.iv) return; this.show(); this.iv = setInterval(() => this.show(), 7000); },
  stop() { clearInterval(this.iv); this.iv = 0; },
};

if (bg) {
  const mo = new MutationObserver(syncBg);
  if (menu) mo.observe(menu, { attributes: true, attributeFilter: ['class'] });
  if (loading) mo.observe(loading, { attributes: true, attributeFilter: ['class'] });
  // first frame once fonts/layout settle; skipped entirely for direct-to-battle URLs that hide the menu immediately
  requestAnimationFrame(syncBg);
}
