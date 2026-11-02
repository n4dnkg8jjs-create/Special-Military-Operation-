// Versus campaign (2 players, peer-to-peer, no game server): lobby with a short room code, then both commanders share
// one operation's sector map. The host is authoritative; battles run in a full-screen iframe so each battle gets a
// fresh game page while the connection lives on in this page.
// Connecting: the host clicks "Host game" and gets a code like K7M-4QX (plus a ?join= link); the joiner types the code
// (or opens the link) and is connected — the PeerJS public broker only relays the WebRTC handshake (see peer.js).
// The old copy-paste invite/reply codes and an optional TURN relay live under "Advanced".
import { RoomPeer, ManualPeer, normalizeCode, formatCode, turnConfig, setTurnConfig } from './peer.js';
import { Versus, mirrorCampaign, other } from '../campaign/versus.js';
import { CampaignUI, injectCss } from '../campaign/ui.js';

const h = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } if (html) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MAX_GROUP = 9;
const STRICT_NAT = "Couldn't connect directly — one of you may be behind a strict network (mobile hotspot, school or office Wi-Fi). Try another Wi-Fi or hotspot, or add a TURN server under Advanced.";

// link that opens the lobby and joins the room; keeps test-only broker overrides
function joinLink(code) {
  const q = new URLSearchParams(location.search), out = new URLSearchParams({ join: code });
  for (const k of ['peerhost', 'peerport', 'peersecure', 'peerpath']) if (q.has(k)) out.set(k, q.get(k));
  return `${location.origin}${location.pathname}?${out}`;
}

export async function openVersus() {
  const { CAMPAIGNS } = await import('../campaign/index.js');
  injectCss(); lobbyCss();
  document.getElementById('menu')?.classList.add('hidden');
  let root = document.getElementById('campaign'); if (!root) { root = h('div', { id: 'campaign' }); document.body.appendChild(root); }
  root.classList.remove('hidden'); root.innerHTML = '';
  const turn = turnConfig() || {};
  const box = h('div', { class: 'cp-choose vs-lobby' }, `<div class="kicker">VERSUS CAMPAIGN · 2 PLAYERS</div><h1>Commander vs commander</h1>
    <p class="brief">One player hosts, picks the operation and a side, and gets a room code. The other player types the code — or opens the link — and you're in. Works on the same Wi-Fi and across the internet.</p>
    <div class="vs-cols">
      <section class="vs-col panel vs-hostcol">
        <h3>Host a game</h3>
        <label class="field"><span class="label">Operation</span><select class="vs-op">${Object.values(CAMPAIGNS).map(d => `<option value="${d.id}">${esc(d.title)} (${esc(d.region || '')})</option>`).join('')}</select></label>
        <div class="field"><span class="label">Your side</span><div class="seg vs-sideseg">
          <label class="seg-opt"><input type="radio" name="vs-side" value="UA" checked><span><b>Ukraine</b></span></label>
          <label class="seg-opt"><input type="radio" name="vs-side" value="RU"><span><b>Russia</b></span></label></div>
          <select class="vs-side hidden"><option value="UA">Ukraine</option><option value="RU">Russia</option></select></div>
        <button class="btn btn-go vs-host">Host game</button>
        <div class="vs-room hidden">
          <span class="label">Room code — send it to your opponent</span>
          <div class="vs-code-big" aria-live="polite"></div>
          <div class="vs-row"><button class="btn btn-s vs-copycode">Copy code</button><button class="btn btn-s vs-copylink">Copy invite link</button><button class="btn btn-s btn-ghost vs-cancel">Cancel</button></div>
          <input class="vs-link" readonly>
        </div>
      </section>
      <section class="vs-col panel vs-joincol">
        <h3>Join a game</h3>
        <label class="field"><span class="label">Room code</span><input class="vs-codein" placeholder="K7M-4QX" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
        <button class="btn btn-go vs-joinbtn">Join</button>
        <p class="vs-hint">Ask the host for the 6-character code. Dash and capitals don't matter.</p>
      </section>
    </div>
    <div class="vs-status" role="status"><i class="vs-dot"></i><span class="vs-msg">Host a game or enter a room code.</span></div>
    <details class="controls vs-adv"><summary>Advanced</summary><div class="vs-advbody">
      <div class="vs-adv-sec"><h3>TURN relay (optional)</h3>
        <p class="vs-hint">Only needed if you can't connect directly (strict networks like mobile hotspots or school Wi-Fi). Both players should enter the same TURN server. Saved on this device.</p>
        <div class="vs-turn"><input class="vs-turl" placeholder="turn:turn.example.com:3478" value="${esc(turn.url || '')}"><input class="vs-tuser" placeholder="username" value="${esc(turn.user || '')}"><input class="vs-tpass" type="password" placeholder="password" value="${esc(turn.pass || '')}"><button class="btn btn-s vs-tsave">Save</button></div></div>
      <div class="vs-adv-sec"><h3>Manual codes (no broker)</h3>
        <p class="vs-hint">Fallback if room codes don't work (e.g. the code service is blocked, or there's no internet on your LAN): the host sends a long invite code, the other player sends back a reply code. Uses the operation and side picked above.</p>
        <div class="vs-cols vs-manual">
          <div class="vs-mcol"><span class="label">Host</span><button class="btn btn-s vs-mk">Create invite code</button>
            <div class="vs-step vs-h2 hidden"><span class="vs-l">1. Send this invite code</span><textarea readonly class="vs-code"></textarea><button class="btn btn-s vs-copy">Copy</button>
            <span class="vs-l">2. Paste their reply code</span><textarea class="vs-reply" placeholder="reply code"></textarea><button class="btn btn-s btn-go vs-acc">Connect</button></div></div>
          <div class="vs-mcol"><span class="label">Join</span><span class="vs-l">1. Paste the host's invite code</span><textarea class="vs-inv" placeholder="invite code"></textarea><button class="btn btn-s vs-join">Generate reply</button>
            <div class="vs-step vs-j2 hidden"><span class="vs-l">2. Send this reply code back</span><textarea readonly class="vs-rcode"></textarea><button class="btn btn-s vs-copy2">Copy</button></div></div>
        </div></div>
    </div></details>`);
  box.append(h('button', { class: 'cp-back', onclick: () => { peer?.close(); location.href = location.pathname; } }, 'Back'));
  root.append(box);
  const $ = s => box.querySelector(s);
  const stEl = $('.vs-status');
  const say = (m, kind = '') => { $('.vs-msg').textContent = m; stEl.dataset.kind = kind; };
  const side = () => box.querySelector('input[name=vs-side]:checked').value;
  box.querySelectorAll('input[name=vs-side]').forEach(r => r.addEventListener('change', () => { $('.vs-side').value = side(); }));
  $('.vs-side').addEventListener('change', () => { box.querySelector(`input[name=vs-side][value=${$('.vs-side').value}]`).checked = true; });   // legacy hook for tests
  const copyText = (t, what) => { const done = () => say(`${what} copied — send it to your opponent.`, 'ok'); if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done)); else fallbackCopy(t, done); };
  const fallbackCopy = (t, done) => { const ta = h('textarea'); ta.value = t; document.body.append(ta); ta.select(); try { document.execCommand('copy'); done(); } catch { say('Select the code and copy it by hand.', 'warn'); } ta.remove(); };
  let peer = null, busy = false;
  const reset = () => { peer?.close(); peer = null; busy = false; $('.vs-room').classList.add('hidden'); $('.vs-host').classList.remove('hidden'); $('.vs-joinbtn').disabled = false; };

  // when the link is up: show the ping briefly, then hand over to the campaign session
  const connected = (p, start) => {
    let went = false; const go = () => { if (went) return; went = true; start(); };
    window.__vsPeer = p;   // test hook
    const via = () => p.mode === 'relay' ? ' (through relay)' : '';
    say(`Connected${via()} — measuring ping…`, 'ok');
    p.on('ping', ms => { if (!went) { say(`Connected${via()} — ping ${ms} ms`, 'ok'); setTimeout(go, 900); } });
    setTimeout(go, 2500);
    p.on('close', () => { if (!went) say('Connection lost. Try again.', 'bad'); });
  };
  const failMsg = (f, code) => ({
    broker: "Can't reach the room-code service (0.peerjs.com) — check your internet connection, or use Manual codes under Advanced.",
    notfound: `No game with code ${formatCode(code || '')} — check it with the host (the host must keep the lobby open).`,
    ice: STRICT_NAT,
    relay: "Couldn't connect directly, and the backup relay servers couldn't be reached either. Check both internet connections and try again, or try another Wi-Fi.",
    busy: 'That game already has two players.',
  }[f.kind] || 'Connection failed: ' + (f.msg || f.kind));

  // ---- host by room code
  $('.vs-host').onclick = async () => {
    reset(); const p = peer = new RoomPeer('host'); busy = true; $('.vs-host').classList.add('hidden');
    say('Getting a room code…', 'busy');
    p.on('status', s => { if (p !== peer) return; if (s === 'waiting') say('Waiting for opponent…', 'busy'); else if (s === 'connecting') say('Opponent found — connecting…', 'busy'); else if (s === 'relay') say('Direct link blocked by the network — connecting through the backup relay…', 'busy'); });
    p.on('fail', f => { if (p !== peer) return; if (f.kind === 'ice' || f.kind === 'relay') say((f.kind === 'relay' ? failMsg(f) : STRICT_NAT) + ' Still waiting — they can try again with the same code.', 'bad'); else { say(failMsg(f), 'bad'); if (f.kind === 'broker' && !p.code) reset(); } });
    p.on('open', () => connected(p, () => hostSession(root, p, CAMPAIGNS, $('.vs-op').value, side())));
    const code = await p.host();
    if (!code || p !== peer) return;
    const link = joinLink(code);
    $('.vs-code-big').textContent = formatCode(code); $('.vs-link').value = link; $('.vs-room').classList.remove('hidden');
    window.__roomCode = code;   // test hook
  };
  $('.vs-copycode').onclick = () => copyText(formatCode(peer?.code || ''), 'Code');
  $('.vs-copylink').onclick = () => copyText($('.vs-link').value, 'Invite link');
  $('.vs-link').onfocus = e => e.target.select();
  $('.vs-cancel').onclick = () => { reset(); say('Cancelled.'); };

  // ---- join by room code
  const codeIn = $('.vs-codein');
  codeIn.addEventListener('input', () => { const c = codeIn.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6); codeIn.value = c.length > 3 ? c.slice(0, 3) + '-' + c.slice(3) : c; });
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('.vs-joinbtn').click(); });
  const doJoin = raw => {
    const code = normalizeCode(raw);
    if (!code) { say(/[01OIL]/i.test(String(raw).replace(/[^0-9A-Z]/gi, '')) ? 'Room codes never contain 0, O, 1, I or L — check the code with the host.' : 'Enter the 6-character room code, e.g. K7M-4QX.', 'bad'); return; }
    reset(); const p = peer = new RoomPeer('guest'); busy = true; $('.vs-joinbtn').disabled = true;
    codeIn.value = formatCode(code);
    say(`Looking for game ${formatCode(code)}…`, 'busy');
    p.on('status', s => { if (p !== peer) return; if (s === 'connecting') say(`Connecting to ${formatCode(code)}…`, 'busy'); else if (s === 'relay') say('Direct link blocked by the network — connecting through the backup relay…', 'busy'); });
    p.on('fail', f => { if (p !== peer) return; say(failMsg(f, code), 'bad'); reset(); });
    p.on('open', () => connected(p, () => guestSession(root, p, CAMPAIGNS)));
    p.join(code);
  };
  $('.vs-joinbtn').onclick = () => doJoin(codeIn.value);

  // ---- advanced: TURN
  $('.vs-tsave').onclick = () => { const url = $('.vs-turl').value.trim(); setTurnConfig(url ? { url, user: $('.vs-tuser').value.trim(), pass: $('.vs-tpass').value } : null); say(url ? 'TURN server saved — it is used for new connections.' : 'TURN server removed.', 'ok'); };

  // ---- advanced: manual copy-paste codes
  const copyTa = ta => { ta.select(); copyText(ta.value, 'Code'); };
  $('.vs-mk').onclick = async () => {
    reset(); const p = peer = new ManualPeer('host'); say('Creating invite…', 'busy');
    const code = await p.invite(); $('.vs-code').value = code; $('.vs-h2').classList.remove('hidden'); say('Invite ready — send it, then paste the reply.');
    p.on('open', () => connected(p, () => hostSession(root, p, CAMPAIGNS, $('.vs-op').value, side())));
  };
  $('.vs-copy').onclick = () => copyTa($('.vs-code'));
  $('.vs-acc').onclick = async () => { try { await peer.accept($('.vs-reply').value); say('Connecting…', 'busy'); setTimeout(() => { if (peer && !peer.open) say(STRICT_NAT, 'bad'); }, 15000); } catch (e) { say('That reply code is not valid: ' + e.message, 'bad'); } };
  $('.vs-join').onclick = async () => {
    reset(); const p = peer = new ManualPeer('guest'); say('Reading invite…', 'busy');
    try { const r = await p.join($('.vs-inv').value); $('.vs-rcode').value = r; $('.vs-j2').classList.remove('hidden'); say('Reply ready — send it back to the host and wait.', 'busy'); } catch (e) { say('That invite code is not valid: ' + e.message, 'bad'); return; }
    p.on('open', () => connected(p, () => guestSession(root, p, CAMPAIGNS)));
  };
  $('.vs-copy2').onclick = () => copyTa($('.vs-rcode'));

  // ?join=CODE link
  const q = new URLSearchParams(location.search).get('join');
  if (q) { codeIn.value = q; doJoin(q); }
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
    status: () => `Versus: you are ${faction === 'UA' ? 'Ukraine' : 'Russia'} · opponent ${V.ready[guest] ? 'has ended the turn' : 'is planning'}${peer.rtt != null ? ` · ping ${peer.rtt} ms` : ''}`,
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
    status: () => `Versus: you are ${st.faction === 'UA' ? 'Ukraine' : 'Russia'} · host ${st.oppReady ? 'has ended the turn' : 'is planning'}${peer.rtt != null ? ` · ping ${peer.rtt} ms` : ''}`,
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
#campaign .vs-lobby{max-width:62rem;margin:5vh auto;max-height:90vh;overflow-y:auto;font-family:var(--font-ui);color:var(--t-1)}
.vs-lobby .brief{color:var(--t-2);font-size:var(--fs-m);max-width:44rem}
.vs-cols{display:flex;gap:var(--sp-4);margin:var(--sp-5) 0 var(--sp-3);flex-wrap:wrap}
.vs-col{flex:1 1 20rem;padding:var(--sp-4);display:flex;flex-direction:column;gap:var(--sp-3)}
.vs-col h3{margin:0}
.vs-lobby .field{display:block}.vs-lobby .field .label{display:block;margin-bottom:var(--sp-2)}
.vs-lobby input{width:100%;box-sizing:border-box;background:var(--s-3);color:var(--t-1);border:1px solid var(--line-2);border-radius:var(--r-1);padding:.5rem .7rem;font:inherit;font-size:var(--fs-m)}
.vs-lobby input:focus,.vs-lobby textarea:focus{outline:none;border-color:var(--accent)}
.vs-codein{font-family:ui-monospace,Menlo,Consolas,monospace!important;font-size:var(--fs-xl)!important;letter-spacing:.18em;text-transform:uppercase;text-align:center;padding:.6rem!important}
.vs-codein::placeholder{color:var(--t-3);letter-spacing:.18em}
.vs-col .btn-go{align-self:flex-start;min-width:9rem;text-transform:uppercase;letter-spacing:.12em}
.vs-col .btn:disabled{opacity:.5;cursor:default}
.vs-room{display:flex;flex-direction:column;gap:var(--sp-2);border-top:1px solid var(--line);padding-top:var(--sp-3)}
.vs-code-big{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:3rem;letter-spacing:.14em;color:var(--accent);background:var(--accent-bg);border:1px solid rgba(233,169,59,.45);border-radius:var(--r-2);text-align:center;padding:.35rem .5rem;user-select:all}
.vs-row{display:flex;gap:var(--sp-2);flex-wrap:wrap}
.vs-link{font-size:var(--fs-xs)!important;color:var(--t-2)!important;padding:.3rem .5rem!important}
.vs-hint{color:var(--t-3);font-size:var(--fs-s);margin:0}
.vs-status{display:flex;align-items:center;gap:var(--sp-2);min-height:1.6rem;padding:var(--sp-2) var(--sp-3);border:1px solid var(--line);border-radius:var(--r-2);background:var(--s-3);color:var(--t-2);font-size:var(--fs-m);margin-bottom:var(--sp-3)}
.vs-dot{flex:none;width:.55rem;height:.55rem;border-radius:50%;background:var(--t-3)}
.vs-status[data-kind=busy] .vs-dot{background:var(--accent);animation:vsPulse 1.1s ease-in-out infinite}
.vs-status[data-kind=ok]{color:var(--t-1)}.vs-status[data-kind=ok] .vs-dot{background:var(--ok)}
.vs-status[data-kind=warn] .vs-dot{background:var(--warn)}
.vs-status[data-kind=bad]{color:#f2c6bf;border-color:rgba(234,90,75,.5)}.vs-status[data-kind=bad] .vs-dot{background:var(--danger)}
@keyframes vsPulse{50%{opacity:.25}}
.vs-adv{margin:var(--sp-2) 0 var(--sp-4)}.vs-adv summary{display:inline-block}
.vs-advbody{margin-top:var(--sp-3);display:flex;flex-direction:column;gap:var(--sp-4)}
.vs-adv-sec{display:flex;flex-direction:column;gap:var(--sp-2)}.vs-adv-sec h3{margin:0}
.vs-turn{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:var(--sp-2)}
.vs-manual{margin:0}.vs-mcol{flex:1 1 18rem;display:flex;flex-direction:column;gap:var(--sp-2);align-items:flex-start}
.vs-step{display:flex;flex-direction:column;gap:var(--sp-2);align-items:flex-start;width:100%}
.vs-lobby textarea{width:100%;box-sizing:border-box;height:4.2rem;background:var(--s-3);color:var(--t-1);border:1px solid var(--line-2);border-radius:var(--r-1);font-family:ui-monospace,monospace;font-size:var(--fs-xs)}
.vs-l{font-size:var(--fs-s);color:var(--t-2)}.vs-lobby .cp-back{margin-left:0}.hidden{display:none!important}
.vs-frame{position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:200;background:#000}` }));
}
