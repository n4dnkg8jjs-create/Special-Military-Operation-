// Versus campaign (2 players, peer-to-peer, no server): lobby with invite / reply codes, then both commanders share
// one operation's sector map. The host is authoritative; battles run in a full-screen iframe so each battle gets a
// fresh game page while the connection lives on in this page.
import { Peer } from './peer.js';
import { Versus, mirrorCampaign, other } from '../campaign/versus.js';
import { CampaignUI, injectCss } from '../campaign/ui.js';

const h = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } if (html) e.innerHTML = html; return e; };
const MAX_GROUP = 9;

export async function openVersus() {
  const { CAMPAIGNS } = await import('../campaign/index.js');
  injectCss(); lobbyCss();
  document.getElementById('menu')?.classList.add('hidden');
  let root = document.getElementById('campaign'); if (!root) { root = h('div', { id: 'campaign' }); document.body.appendChild(root); }
  root.classList.remove('hidden'); root.innerHTML = '';
  const box = h('div', { class: 'cp-choose vs-lobby' }, `<div class="kicker">VERSUS CAMPAIGN · 2 PLAYERS</div><h1>Commander vs commander</h1>
    <p class="brief">One player hosts and picks the operation and his side; the other takes the opposing brigade. You connect directly — no server: the host sends an invite code (message, e-mail, anything), the other player answers with a reply code. Works on the same Wi-Fi without internet, and over the internet on most home connections.</p>`);
  const cols = h('div', { class: 'vs-cols' });
  // ---- host
  const host = h('div', { class: 'vs-col' }, `<h3>Host</h3>
    <label>Operation <select class="vs-op">${Object.values(CAMPAIGNS).map(d => `<option value="${d.id}">${d.title} (${d.region || ''})</option>`).join('')}</select></label>
    <label>Your side <select class="vs-side"><option value="UA">Ukraine</option><option value="RU">Russia</option></select></label>
    <button class="big vs-mk">CREATE INVITE CODE</button><div class="vs-step vs-h2 hidden"><div class="vs-l">1. Send this invite code to the other player</div><textarea readonly class="vs-code"></textarea><button class="vs-copy">Copy</button>
    <div class="vs-l">2. Paste their reply code</div><textarea class="vs-reply" placeholder="reply code"></textarea><button class="big vs-acc">CONNECT</button></div>`);
  // ---- join
  const join = h('div', { class: 'vs-col' }, `<h3>Join</h3><div class="vs-l">1. Paste the host's invite code</div><textarea class="vs-inv" placeholder="invite code"></textarea><button class="big vs-join">GENERATE REPLY</button>
    <div class="vs-step vs-j2 hidden"><div class="vs-l">2. Send this reply code back to the host</div><textarea readonly class="vs-rcode"></textarea><button class="vs-copy2">Copy</button><div class="vs-l vs-wait">Waiting for the host to connect…</div></div>`);
  cols.append(host, join); box.append(cols);
  const status = h('div', { class: 'vs-status' }); box.append(status);
  box.append(h('button', { class: 'cp-back', onclick: () => { location.href = location.pathname; } }, 'Back'));
  root.append(box);
  const say = m => { status.textContent = m; };
  const copy = ta => { ta.select(); navigator.clipboard?.writeText(ta.value).catch(() => document.execCommand('copy')); say('Copied.'); };
  let peer = null;
  host.querySelector('.vs-mk').onclick = async () => {
    peer?.close(); peer = new Peer('host'); say('Creating invite…');
    const code = await peer.invite(); host.querySelector('.vs-code').value = code; host.querySelector('.vs-h2').classList.remove('hidden'); say('Invite ready.');
    peer.on('open', () => hostSession(root, peer, CAMPAIGNS, host.querySelector('.vs-op').value, host.querySelector('.vs-side').value));
    peer.on('close', () => say('Connection lost.'));
  };
  host.querySelector('.vs-copy').onclick = () => copy(host.querySelector('.vs-code'));
  host.querySelector('.vs-acc').onclick = async () => { try { await peer.accept(host.querySelector('.vs-reply').value); say('Connecting…'); } catch (e) { say('That reply code is not valid: ' + e.message); } };
  join.querySelector('.vs-join').onclick = async () => {
    peer?.close(); peer = new Peer('guest'); say('Reading invite…');
    try { const r = await peer.join(join.querySelector('.vs-inv').value); join.querySelector('.vs-rcode').value = r; join.querySelector('.vs-j2').classList.remove('hidden'); say('Reply ready.'); } catch (e) { say('That invite code is not valid: ' + e.message); return; }
    peer.on('open', () => guestSession(root, peer, CAMPAIGNS));
    peer.on('close', () => say('Connection lost.'));
  };
  join.querySelector('.vs-copy2').onclick = () => copy(join.querySelector('.vs-rcode'));
  window.__done = true;
}

// battle traffic is routed to a per-battle proxy so a finished battle's handlers die with its iframe
function battleChannel(peer) {
  const bp = { handlers: {}, last: {}, on(t, f) { (this.handlers[t] ||= []).push(f); if (t === 'manifest' && this.last.manifest) f(this.last.manifest); return this; }, off() {}, send: (t, d) => peer.send(t, d), sendSnap: (t, d) => peer.sendSnap(t, d), open: true };
  return bp;
}
function routeBattle(peer, holder) { peer.on('*', m => { const bp = holder.bp; if (bp && m.t === 'manifest') bp.last.manifest = m.d; if (bp) for (const f of bp.handlers[m.t] || []) try { f(m.d); } catch (e) { console.error(e); } }); }
function battleFrame(holder, opts, onReturn) {
  holder.bp = battleChannel(holder.peer);
  window.__vs = { peer: holder.bp, opts, done: onReturn };
  const f = h('iframe', { src: `${location.pathname}?vsbattle=1`, class: 'vs-frame', allow: 'autoplay; fullscreen' });
  document.body.appendChild(f); holder.frame = f; return f;
}
function closeFrame(holder) { holder.frame?.remove(); holder.frame = null; holder.bp = null; window.__vs = null; }
function pickDefenders(C) { return C.ready().slice().sort((a, b) => (b.men + (b.veh && !b.veh.lost ? 6 : 0)) - (a.men + (a.veh && !a.veh.lost ? 6 : 0))).slice(0, MAX_GROUP).map(u => u.uid); }

function hostSession(root, peer, CAMPAIGNS, opId, faction) {
  const V = new Versus(CAMPAIGNS, opId, faction), guest = V.guest, H = { peer };
  routeBattle(peer, H);
  let ui = null;
  const render = () => { ui = new CampaignUI(root, V.side[faction], null, adapter); ui.render(); };
  const send = () => { peer.send('vstate', V.state(guest)); render(); };
  const adapter = {
    readyLabel: () => (V.ready[faction] ? 'WAITING…' : 'END TURN'),
    status: () => `Versus: you are ${faction === 'UA' ? 'Ukraine' : 'Russia'} · opponent ${V.ready[guest] ? 'has ended the turn' : 'is planning'}`,
    endTurn: () => { V.ready[faction] = true; render(); resolve(); },
    plan: p => { V.plan(faction, p); },
    myPlan: () => V.plans[faction] || null,
    action: () => peer.send('vstate', V.state(guest)),
  };
  peer.on('vaction', ({ name, arg }) => { try { V.side[guest][name](arg); } catch (e) { console.warn(e); } send(); });
  peer.on('vplan', p => { V.plan(guest, p); });
  peer.on('vready', () => { V.ready[guest] = true; send(); resolve(); });
  async function resolve() {
    if (!V.ready[faction] || !V.ready[guest] || H.busy) return; H.busy = true;
    for (const b of V.battles()) await fight(b);
    V.endTurn(); H.busy = false; send();
  }
  function fight(b) {
    return new Promise(res => {
      const hostAtt = b.attacker === faction, HC = V.side[faction], GC = V.side[guest];
      const hostUnits = hostAtt ? b.uids : pickDefenders(HC), guestUnits = hostAtt ? pickDefenders(GC) : b.uids;
      if (!hostUnits.length || !guestUnits.length) {   // nobody to oppose: the attacker walks in
        const empty = { sector: b.sector, units: [], enemyKia: 0, enemyVehLost: 0, objectivesHeld: 0 };
        V.applyBattle(b, { ...empty, win: !!(hostAtt ? hostUnits.length : guestUnits.length) }, { ...empty }); return res();
      }
      const setup = HC.battleSetup(b.sector, hostUnits, hostAtt ? 'attack' : 'defend');
      setup.enemy = []; const ov = new URLSearchParams(location.search).get('vsmap'); if (ov) setup.map = ov;   // test hook
      const opts = { side: faction, map: setup.map, campaign: setup, net: { role: 'host', enemyForce: GC.force.filter(u => guestUnits.includes(u.uid)), enemyMods: GC.mods() } };
      peer.send('vbattle', { side: guest, map: setup.map, sectorName: setup.sectorName, mode: hostAtt ? 'defend' : 'attack' });
      battleFrame(H, opts, (rHost, rGuest) => {
        closeFrame(H); peer.send('vbattleEnd', {});
        V.applyBattle(b, hostAtt ? rHost : rGuest, hostAtt ? rGuest : rHost); res();
      });
    });
  }
  send();
}

function guestSession(root, peer, CAMPAIGNS) {
  const G = { peer }; if (window.__vsRecord) window.__guestPeer = peer; let st = null, myPlan = null;
  routeBattle(peer, G);
  const render = () => { if (!st || G.frame) return; const C = mirrorCampaign(CAMPAIGNS, st); new CampaignUI(root, C, null, adapter).render(); };
  const adapter = {
    readyLabel: () => (G.ready ? 'WAITING…' : 'END TURN'),
    status: () => `Versus: you are ${st.faction === 'UA' ? 'Ukraine' : 'Russia'} · host ${st.oppReady ? 'has ended the turn' : 'is planning'}`,
    endTurn: () => { G.ready = true; peer.send('vready', 1); render(); },
    plan: p => { myPlan = p; peer.send('vplan', p); },
    myPlan: () => myPlan,
    action: (name, arg) => peer.send('vaction', { name, arg }),
  };
  peer.on('vstate', s => { if (st && s.turn !== st.turn) { G.ready = false; myPlan = null; } st = s; render(); });
  if (window.__vsRecord) peer.on('*', m => { if (['manifest', 'snap', 'ev'].includes(m.t)) (window.__rec ||= []).push(m); });   // test hook: record the battle stream instead of playing it
  peer.on('vbattle', b => { if (window.__vsRecord) { window.__inBattle = b; return; } battleFrame(G, { side: b.side, map: b.map, campaign: { sectorName: b.sectorName, mode: b.mode, force: [], enemy: [] }, net: { role: 'client' } }, () => {}); });
  peer.on('vbattleEnd', () => { closeFrame(G); render(); });
}

function lobbyCss() {
  if (document.getElementById('vs-css')) return;
  document.head.appendChild(Object.assign(document.createElement('style'), { id: 'vs-css', textContent: `
.vs-lobby{max-width:980px}.vs-cols{display:flex;gap:18px;margin:18px 0}.vs-col{flex:1;background:#24271f;border:1px solid #3a3d33;border-radius:4px;padding:14px}
.vs-col h3{margin:0 0 10px}.vs-col label{display:block;margin:6px 0;font-size:13px;color:#bdb8a5}.vs-col select{margin-left:6px;background:#1d1f1a;color:#e6e2d3;border:1px solid #4a4d42;padding:4px}
.vs-col textarea{width:100%;height:70px;background:#1a1c17;color:#d7d2c0;border:1px solid #4a4d42;font-family:ui-monospace,monospace;font-size:11px;margin:4px 0}
.vs-col button{background:#33362d;border:1px solid #4a4d42;color:#e6e2d3;padding:6px 10px;border-radius:3px;cursor:pointer;margin:4px 4px 4px 0}.vs-col button.big{background:#7a5a22;border-color:#a8803a}
.vs-l{font-size:12px;color:#9c988a;margin-top:8px}.vs-status{color:#e8c870;min-height:20px}.hidden{display:none}
.vs-frame{position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:200;background:#000}` }));
}
