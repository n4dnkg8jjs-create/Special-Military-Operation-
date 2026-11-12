// Main menu + loading screen behaviour (markup in index.html, look in style.css):
//  - fills the game name / subtitle from brand.js
//  - view switching: home (title + nav) → skirmish setup / settings, Esc or Back returns
//  - the animated backdrop (backdrop.js) runs only while the menu or the loading screen is visible
//  - skirmish detail panel mirrors the selected map card (big preview + objectives)
//  - loading screen field notes
//  - the intro (title reveal, once per session) and the menu ambience (menuAudio.js)
// main.js keeps owning the actual launch logic (#startBtn, #campaignBtn, #versusBtn, #quality, #mapPick).
import { applyBrand } from './brand.js';
import { Backdrop } from './backdrop.js';
import { MenuScene } from './menuScene.js';
import { startMenuAudio, stopMenuAudio, menuAudioEnabled, setMenuAudio } from './menuAudio.js';

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
// FPV drone view auto-open (ui/droneFeed.js reads the same key; its window has the same toggle)
const fa = $('fpvAuto');
if (fa) {
  try { fa.checked = localStorage.getItem('smo_fpvfeed_open') === '1'; } catch { }
  fa.addEventListener('change', () => { try { localStorage.setItem('smo_fpvfeed_open', fa.checked ? '1' : '0'); } catch { } });
}

// ---------------------------------------------------------------- menu ambience (menuAudio.js): from the first click / key
// press while the menu is up (autoplay rules), faded out as soon as the menu is hidden (a battle / campaign / versus loads)
const ma = $('menuAudio');
if (ma) { ma.checked = menuAudioEnabled(); ma.addEventListener('change', () => { setMenuAudio(ma.checked); if (ma.checked) startMenuAudio(); }); }
if (menu) {
  const menuUp = () => !menu.classList.contains('hidden');
  const kick = () => { if (menuUp()) startMenuAudio(); };
  addEventListener('pointerdown', kick, true); addEventListener('keydown', kick, true); addEventListener('touchend', kick, true);
  // try at once as well: browsers that allow sound without a gesture (a returning visitor in Chrome, Firefox / Safari with
  // autoplay allowed for the site) play from the first frame; the others hold it until the first click / key / tap
  kick();
  new MutationObserver(() => { if (!menuUp()) stopMenuAudio(); }).observe(menu, { attributes: true, attributeFilter: ['class'] });
}

// ---------------------------------------------------------------- intro (once per session, home view only): dark screen,
// the title revealed large in the centre, a hold, then it glides to its place at the left while the backdrop pushes in
// and the entries slide in. Web Animations on transform / opacity / filter only. Any key or click skips it.
// Not under automation (headless screenshots of the menu) unless ?intro is given.
const INTRO = (() => {
  const Q = new URLSearchParams(location.search);
  if (!menu || !menu.querySelector('.mv-home .title') || menu.dataset.view !== 'home') return false;
  if (Q.has('intro')) return true;
  if (['autostart', 'cbattle', 'ctest', 'vsbattle', 'vsreplay', 'campaign', 'versus', 'join'].some(k => Q.has(k))) return false;
  if (navigator.webdriver || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try { if (sessionStorage.getItem('smo_intro')) return false; sessionStorage.setItem('smo_intro', '1'); } catch { }
  return true;
})();
if (INTRO) {
  const t = menu.querySelector('.mv-home .title'), veil = document.createElement('div'); veil.className = 'menu-veil';
  menu.insertBefore(veil, menu.querySelector('.menu-top')); menu.classList.add('intro');   // dark + title / entries held back (style.css) until the animation runs
  const run = () => {
    const r = t.getBoundingClientRect();
    const s = Math.min(1.45, innerWidth * 0.78 / Math.max(1, r.width)), dx = innerWidth / 2 - (r.left + r.width / 2), dy = innerHeight / 2 - (r.top + r.height / 2);
    const T = `translate(${dx}px,${dy}px) scale(${s})`, D = 5200, hold = 0.56, A = [];
    t.style.transformOrigin = '50% 50%'; t.style.willChange = 'transform, opacity';
    A.push(t.animate([
      // (transform + opacity only: these run on the compositor. The animated blur() repainted the title every frame on the
      // main thread, which is busy loading the game's modules just then - the reveal stuttered)
      { transform: `translate(${dx}px,${dy}px) scale(${s * 1.05})`, opacity: 0, offset: 0, easing: 'cubic-bezier(.2,.7,.2,1)' },
      { transform: T, opacity: 1, offset: 0.32, easing: 'linear' },
      { transform: T, opacity: 1, offset: hold, easing: 'cubic-bezier(.65,0,.25,1)' },
      { transform: 'none', opacity: 1, offset: 1 }], { duration: D, fill: 'both' }));   // (easing per keyframe: an overall easing would warp the hold)
    A.push(veil.animate([{ opacity: 1 }, { opacity: 1, offset: hold - 0.04, easing: 'ease-in-out' }, { opacity: 0 }], { duration: D, fill: 'both' }));
    const bgc = $('menuBg'); if (bgc) A.push(bgc.animate([{ transform: 'scale(1.08)' }, { transform: 'scale(1.08)', offset: hold - 0.04, easing: 'cubic-bezier(.3,0,.2,1)' }, { transform: 'none' }], { duration: D + 600, fill: 'both' }));
    const late = [...menu.querySelectorAll('.mainnav .nav-item'), menu.querySelector('.menu-foot')].filter(Boolean);
    late.forEach((el, i) => A.push(el.animate([{ opacity: 0, transform: 'translateX(-1.2rem)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: D * hold + 700 + i * 90, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both' })));
    let done = false;
    const end = () => { if (done) return; done = true; removeEventListener('keydown', skip, true); removeEventListener('pointerdown', skip, true); menu.classList.remove('intro'); for (const a of A) a.cancel(); veil.remove(); t.style.transformOrigin = ''; t.style.willChange = ''; };
    const skip = e => { e.preventDefault(); e.stopPropagation(); end(); };
    addEventListener('keydown', skip, true); addEventListener('pointerdown', skip, true);
    Promise.all(A.map(a => a.finished)).then(end, () => { });
    window.__intro = { skip: end };   // test hook
  };
  requestAnimationFrame(() => (document.fonts?.ready || Promise.resolve()).then(run));
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
// the 3-D layer over it (menuScene.js: the convoy as models, two soldiers in the foreground) - the menu only, not the loading screen
/* (owner, Nov 2026: "make the main menu go back to the 2D version" - the painted backdrop is the menu again; the 3-D scene
   (menuScene.js) is kept, only built when asked for with ?menu3d) */
const bg3 = bg && new URLSearchParams(location.search).has('menu3d') ? new MenuScene(bg) : null;
function syncBg() {
  if (!bg) return;
  const m = menu && !menu.classList.contains('hidden'), l = loading && !loading.classList.contains('hidden');
  bgc.classList.toggle('on', m || l);
  if (m || l) bg.start(l ? 'loading' : 'menu'); else bg.stop();
  // (not during the intro: the layer does not take part in the push-in, and parsing its models would make the title stutter)
  if (bg3) { if (m && !l && !menu.classList.contains('intro')) bg3.start(); else if (!m || l) bg3.stop(); }
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
  'FPV teams carry ten drones. Right-click a spotted vehicle to choose the target.',
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
