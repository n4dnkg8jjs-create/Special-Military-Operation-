// Versus campaign (2 players, peer-to-peer, no game server): lobby with a short room code, then both commanders share
// one operation's sector map. The host is authoritative; battles run in a full-screen iframe so each battle gets a
// fresh game page while the connection lives on in this page.
// Connecting: the host clicks "Host game" and gets a code like K7M-4QX (plus a ?join= link); the joiner types the code
// (or opens the link) and is connected — the PeerJS public broker only relays the WebRTC handshake (see peer.js).
// The old copy-paste invite/reply codes and an optional TURN relay live under "Advanced".
import { RoomPeer, ManualPeer, normalizeCode, formatCode, turnConfig, setTurnConfig } from './peer.js';
import { injectCss } from '../campaign/ui.js';            // lobby look (shared with the v1 screens)
import { loadCampaigns } from '../campaign/v2/index.js';
import { dateLabel } from '../campaign/v2/state.js';

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
  const { defs } = await loadCampaigns();
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
        <label class="field"><span class="label">Operation</span><select class="vs-op">${Object.values(defs).map(d => `<option value="${d.id}">${esc(d.title)} — ${esc(d.intro?.place || d.region || '')}</option>`).join('')}</select></label>
        <div class="field"><span class="label">Your side</span><div class="seg vs-sideseg">
          <label class="seg-opt"><input type="radio" name="vs-side" value="UA" checked><span><b>Ukraine</b></span></label>
          <label class="seg-opt"><input type="radio" name="vs-side" value="RU"><span><b>Russia</b></span></label></div>
          <select class="vs-side hidden"><option value="UA">Ukraine</option><option value="RU">Russia</option></select></div>
        <div class="vs-resume hidden"></div>
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
        <div class="vs-rejoin hidden"></div>
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
  const reset = () => { clearTimeout(joinT); peer?.close(); peer = null; busy = false; $('.vs-room').classList.add('hidden'); $('.vs-host').classList.remove('hidden'); $('.vs-joinbtn').disabled = false; };

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
    const old = lsGet(HOST_KEY); if (old?.saved && old.saved.phase !== 'over' && !confirm('Hosting a new game replaces your saved versus game (week ' + old.saved.turn + '). Continue?')) return;
    reset(); const p = peer = new RoomPeer('host'); busy = true; $('.vs-host').classList.add('hidden');
    say('Getting a room code…', 'busy');
    p.on('status', s => { if (p !== peer) return; if (s === 'waiting') say('Waiting for opponent…', 'busy'); else if (s === 'connecting') say('Opponent found — connecting…', 'busy'); else if (s === 'relay') say('Direct link blocked by the network — connecting through the backup relay…', 'busy'); });
    p.on('fail', f => { if (p !== peer) return; if (f.kind === 'ice' || f.kind === 'relay') say((f.kind === 'relay' ? failMsg(f) : STRICT_NAT) + ' Still waiting — they can try again with the same code.', 'bad'); else { say(failMsg(f), 'bad'); if (f.kind === 'broker' && !p.code) reset(); } });
    p.on('open', () => connected(p, () => hostSession(p, defs, $('.vs-op').value, side())));
    const code = await p.host();
    if (!code || p !== peer) return;
    const link = joinLink(code);
    $('.vs-code-big').textContent = formatCode(code); $('.vs-link').value = link; $('.vs-room').classList.remove('hidden');
    window.__roomCode = code;   // test hook
  };
  $('.vs-copycode').onclick = () => copyText(formatCode(peer?.code || ''), 'Code');
  $('.vs-copylink').onclick = () => copyText($('.vs-link').value, 'Invite link');
  $('.vs-link').onfocus = e => e.target.select();
  $('.vs-cancel').onclick = () => { reset(); const rb = box.querySelector('.vs-resumebtn'); if (rb) rb.disabled = false; say('Cancelled.'); };

  // ---- join by room code
  const codeIn = $('.vs-codein');
  codeIn.addEventListener('input', () => { const c = codeIn.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6); codeIn.value = c.length > 3 ? c.slice(0, 3) + '-' + c.slice(3) : c; });
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('.vs-joinbtn').click(); });
  // persistent (a rejoin, or an invite link): the host may still be re-opening the room (it reloaded, or has not noticed
  // yet that the link dropped) — keep trying for a while instead of failing at once
  let joinT = 0;
  const doJoin = (raw, persistent = false, t0 = performance.now()) => {
    const code = normalizeCode(raw);
    if (!code) { say(/[01OIL]/i.test(String(raw).replace(/[^0-9A-Z]/gi, '')) ? 'Room codes never contain 0, O, 1, I or L — check the code with the host.' : 'Enter the 6-character room code, e.g. K7M-4QX.', 'bad'); return; }
    clearTimeout(joinT); reset(); const p = peer = new RoomPeer('guest'); busy = true; $('.vs-joinbtn').disabled = true;
    codeIn.value = formatCode(code);
    say(`Looking for game ${formatCode(code)}…`, 'busy');
    p.on('status', s => { if (p !== peer) return; if (s === 'connecting') say(`Connecting to ${formatCode(code)}…`, 'busy'); else if (s === 'relay') say('Direct link blocked by the network — connecting through the backup relay…', 'busy'); });
    p.on('fail', f => {
      if (p !== peer) return;
      if (persistent && ['notfound', 'busy', 'ice', 'relay'].includes(f.kind) && performance.now() - t0 < 120000) {
        reset(); $('.vs-joinbtn').disabled = true;
        say(`Waiting for the host to open room ${formatCode(code)}… (${f.kind === 'notfound' ? 'not open yet' : 'retrying'})`, 'busy');
        joinT = setTimeout(() => { if (!peer) doJoin(code, true, t0); }, 3000); return;
      }
      say(failMsg(f, code), 'bad'); reset();
    });
    p.on('open', () => connected(p, () => guestSession(p, defs, p.code || null)));
    p.join(code);
  };
  $('.vs-joinbtn').onclick = () => doJoin(codeIn.value, normalizeCode(codeIn.value) === lsGet(GUEST_KEY)?.code);

  // ---- advanced: TURN
  $('.vs-tsave').onclick = () => { const url = $('.vs-turl').value.trim(); setTurnConfig(url ? { url, user: $('.vs-tuser').value.trim(), pass: $('.vs-tpass').value } : null); say(url ? 'TURN server saved — it is used for new connections.' : 'TURN server removed.', 'ok'); };

  // ---- advanced: manual copy-paste codes
  const copyTa = ta => { ta.select(); copyText(ta.value, 'Code'); };
  $('.vs-mk').onclick = async () => {
    reset(); const p = peer = new ManualPeer('host'); say('Creating invite…', 'busy');
    const code = await p.invite(); $('.vs-code').value = code; $('.vs-h2').classList.remove('hidden'); say('Invite ready — send it, then paste the reply.');
    p.on('open', () => connected(p, () => hostSession(p, defs, $('.vs-op').value, side())));
  };
  $('.vs-copy').onclick = () => copyTa($('.vs-code'));
  $('.vs-acc').onclick = async () => { try { await peer.accept($('.vs-reply').value); say('Connecting…', 'busy'); setTimeout(() => { if (peer && !peer.open) say(STRICT_NAT, 'bad'); }, 15000); } catch (e) { say('That reply code is not valid: ' + e.message, 'bad'); } };
  $('.vs-join').onclick = async () => {
    reset(); const p = peer = new ManualPeer('guest'); say('Reading invite…', 'busy');
    try { const r = await p.join($('.vs-inv').value); $('.vs-rcode').value = r; $('.vs-j2').classList.remove('hidden'); say('Reply ready — send it back to the host and wait.', 'busy'); } catch (e) { say('That invite code is not valid: ' + e.message, 'bad'); return; }
    p.on('open', () => connected(p, () => guestSession(p, defs, p.code || null)));
  };
  $('.vs-copy2').onclick = () => copyTa($('.vs-rcode'));

  // a saved game: the host resumes it under the same room code, the joiner rejoins with that code
  const sv = lsGet(HOST_KEY), gv = lsGet(GUEST_KEY);
  if (sv?.code && sv.saved) {
    const st = sv.saved, el = $('.vs-resume'), C = st.sides?.[st.host];
    el.innerHTML = `<span class="label">Saved game</span><div class="vs-resume-t"><b>${esc(defs[st.opId]?.title || st.opId)}</b> · you are ${sideName(st.host)} · week ${st.turn}${st.phase === 'over' ? ' · finished' : ''}<br><small>Room ${formatCode(sv.code)} · ${new Date(sv.at).toLocaleString()}</small></div>`;
    const row = h('div', { class: 'vs-row' });
    if (st.phase !== 'over') row.appendChild(h('button', { class: 'btn btn-go btn-s vs-resumebtn', onclick: async e => {
      const btn = e?.currentTarget || box.querySelector('.vs-resumebtn'); if (btn?.disabled) return;
      reset(); const p = peer = new RoomPeer('host'); busy = true; $('.vs-host').classList.add('hidden'); say(`Re-opening room ${formatCode(sv.code)}…`, 'busy'); if (btn) btn.disabled = true;
      p.on('fail', f => { if (p !== peer) return; say(f.kind === 'taken' ? `Room ${formatCode(sv.code)} is still in use — wait a moment and try again.` : failMsg(f), 'bad'); if (!p.code) { reset(); if (btn) btn.disabled = false; } });
      p.on('status', x => { if (p === peer && x === 'connecting') say('Opponent found — connecting…', 'busy'); });
      p.on('open', () => connected(p, () => hostSession(p, defs, st.opId, st.host, st)));
      const code = await p.host(sv.code); if (!code || p !== peer) return;
      $('.vs-code-big').textContent = formatCode(code); $('.vs-link').value = joinLink(code); $('.vs-room').classList.remove('hidden'); window.__roomCode = code;
      say(`Waiting for your opponent to rejoin room ${formatCode(code)}…`, 'busy');
    } }, 'Resume game'));
    row.appendChild(h('button', { class: 'btn btn-ghost btn-s', onclick: () => { if (!confirm('Delete the saved versus game?')) return; lsSet(HOST_KEY, null); el.classList.add('hidden'); } }, 'Discard'));
    el.appendChild(row); el.classList.remove('hidden');
  }
  if (gv?.code && !new URLSearchParams(location.search).get('join')) {
    const el = $('.vs-rejoin'); el.innerHTML = `<p class="vs-hint">Last game: room <b>${formatCode(gv.code)}</b></p>`;
    el.appendChild(h('button', { class: 'btn btn-s vs-rejoinbtn', onclick: () => doJoin(gv.code, true) }, `Rejoin ${formatCode(gv.code)}`)); el.classList.remove('hidden');
  }
  // ?join=CODE link
  const q = new URLSearchParams(location.search).get('join');
  if (q) { codeIn.value = q; doJoin(q, true); }
  // the page was reloaded (or closed) during a game: rejoin / resume by itself
  else if (gv?.code && gv.live && Date.now() - (gv.at || 0) < LIVE_MS) { say(`Rejoining your game in room ${formatCode(gv.code)}…`, 'busy'); doJoin(gv.code, true); }
  else if (sv?.code && sv.live && sv.saved?.phase !== 'over' && Date.now() - (sv.at || 0) < LIVE_MS) box.querySelector('.vs-resumebtn')?.click();
  window.__done = true;
}

// ================================================================================================ sessions (v2 grid)
// Host: authoritative VersusGame (src/campaign/v2/versus.js) — applies its own and the joiner's commands, resolves the
// week when both are ready, runs the battles, persists the game (resume with the same room code after a reload).
// Joiner: a local copy of its side (applied at once for a responsive screen) that is replaced by the host's state as
// soon as the host has applied every command sent (ack). Both sides watch the link (pings / any traffic) and, when it
// drops, reconnect through the same room code: the host re-registers the code and waits, the joiner retries; commands
// sent meanwhile are re-sent (the host ignores duplicates by sequence number). Battles run in a full-screen iframe
// (?vsbattle=1) with the link carried through window.__vs; a joiner reconnecting mid-battle gets the battle again.
export const HOST_KEY = 'smo.versus.v2.host', GUEST_KEY = 'smo.versus.v2.guest';
const DROP_MS = 25000, DROP_BATTLE_MS = 60000, LIVE_MS = 20 * 60000;
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { } };
const sideName = f => (f === 'UA' ? 'Ukraine' : 'Russia');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the link wrapper both sessions share: binding to the current peer, liveness, battle traffic routing, the iframe
function linkState(peer, code, onMsg, onDrop) {
  const S = { peer: null, code, connected: false, lastHeard: performance.now(), frame: null, bp: null, onMsg, onDrop, timer: null };
  S.bind = p => {
    S.peer = p; S.connected = true; S.lastHeard = performance.now(); window.__vsPeer = p;
    p.on('*', m => { if (p !== S.peer) return; S.lastHeard = performance.now(); try { S.onMsg(m); } catch (e) { console.error('versus message', m.t, e); } });
    p.on('ping', () => { if (p === S.peer) S.lastHeard = performance.now(); });
    p.on('close', () => { if (p === S.peer) S.drop('closed'); });
  };
  S.drop = why => { if (!S.connected) return; S.connected = false; const p = S.peer; S.peer = null; try { p?.close(); } catch { } console.info('versus link lost:', why); S.onDrop(why); };
  S.send = (t, d) => { if (S.peer && S.connected) S.peer.send(t, d); };
  S.timer = setInterval(() => { if (S.connected && performance.now() - S.lastHeard > (S.frame ? DROP_BATTLE_MS : DROP_MS)) S.drop('timeout'); }, 2000);
  // battle traffic goes to a per-battle proxy, so a finished battle's handlers die with its iframe; it always talks
  // through the current link (which may have been re-established during the battle)
  S.route = m => { const bp = S.bp; if (!bp) return; if (m.t === 'manifest') bp.last.manifest = m.d; for (const f of bp.handlers[m.t] || []) try { f(m.d); } catch (e) { console.error(e); } };
  S.openFrame = (opts, done, fail = null) => {
    S.closeFrame();
    S.bp = { handlers: {}, last: {}, open: true, on(t, f) { (this.handlers[t] ||= []).push(f); if (t === 'manifest' && this.last.manifest) f(this.last.manifest); return this; }, off() { }, send: (t, d) => { if (t === 'manifest') S.manifest = d; S.send(t, d); }, sendSnap: (t, d) => { if (S.peer && S.connected) S.peer.sendSnap(t, d); } };
    window.__vs = { peer: S.bp, opts, done, fail };
    const f = h('iframe', { src: `${location.pathname}?vsbattle=1`, class: 'vs-frame', allow: 'autoplay; fullscreen' });
    document.body.appendChild(f); S.frame = f; holdPage(true); return f;
  };
  S.closeFrame = () => { S.frame?.remove(); S.frame = null; S.bp = null; S.manifest = null; window.__vs = null; holdPage(false); };
  if (peer) S.bind(peer);
  return S;
}
// While a battle iframe is open it covers the whole page, but the iframe (same origin) shares this page's main thread
// and GPU: the sector map's own WebGL renderer (campaign/v2/map3d.js, MSAA at up to 2x DPR), its label / tween loops and
// the UI's CSS animations kept running underneath and took frame time from the battle. Hold every requestAnimationFrame
// callback of THIS page (the iframe has its own window and its own rAF) and hide the page under the frame; on close the
// held callbacks run again, so every loop resumes where it was.
let held = null;
function holdPage(on) {
  if (on && !held) {
    const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame, q = new Map(); let id = 1e9;
    held = { raf, caf, q };
    window.requestAnimationFrame = f => { q.set(++id, f); return id; };
    window.cancelAnimationFrame = i => { if (!q.delete(i)) caf.call(window, i); };
    document.body.classList.add('vs-battle-open');
  } else if (!on && held) {
    const { raf, caf, q } = held; held = null;
    window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf;
    document.body.classList.remove('vs-battle-open');
    // (a loop that cancels its own frame by the old id afterwards only misses one frame: map3d / ui loops re-arm each frame)
    for (const f of q.values()) raf.call(window, f);
  }
}
function banner(text, kind = '') {
  let b = document.querySelector('.c2-banner');
  if (!text) { b?.remove(); return; }
  if (!b) { b = h('div', { class: 'c2-banner', role: 'status' }); (document.getElementById('c2') || document.body).appendChild(b); }
  b.className = 'c2-banner ' + kind; b.innerHTML = `<i></i><span>${text}</span>`;
}
function weekReport(ui, C, fromN, prevDate) {
  const entries = C.log.filter(e => (e.n || 0) > fromN);
  if (!entries.length) { ui.checkOutcome(); return; }
  ui.turnReport(prevDate, entries, () => ui.checkOutcome());
}

async function hostSession(peer, defs, opId, faction, saved = null) {
  const { VersusGame } = await import('../campaign/v2/versus.js'), { openScreen } = await import('../campaign/v2/ui.js');
  document.getElementById('campaign')?.classList.add('hidden');
  const V = saved ? new VersusGame(defs, saved.opId, saved.host, saved) : new VersusGame(defs, opId, faction);
  const me = V.host, them = V.guest; window.__vsGame = V;
  let ui = null, stateSeq = 0, sendT = 0, saveT = 0, resolving = false, cur = null, fightN = 0;
  const S = linkState(peer, peer.code, m => onMsg(m), () => onDrop()); window.__vsLink = S;
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => lsSet(HOST_KEY, { code: S.code, saved: V.save(), at: Date.now(), live: V.phase !== 'over' }), 250); };
  const pushState = (now = false) => { clearTimeout(sendT); const go = () => { S.send('v2state', { ...V.view(them), seq: ++stateSeq, code: S.code }); persist(); }; if (now) go(); else sendT = setTimeout(go, 120); };
  const mine = () => { const C = V.side[me]; C.foes = V.foes(me); return C; };
  const refresh = () => { if (!ui) return; mine(); ui.map.refresh(); ui.renderTop(); };
  const adapter = {
    act: (name, args) => { const r = V.apply(me, name, args); if (typeof r === 'string') ui?.toast(r, false); mine(); pushState(); ui?.map.refresh(); return r; },
    isReady: () => !!V.ready[me] && V.phase === 'plan',
    endLabel: () => V.phase === 'over' ? 'GAME OVER' : V.phase !== 'plan' ? 'RESOLVING…' : V.ready[me] ? 'WAITING…' : 'END WEEK ▸',
    statusKind: () => !S.connected ? 'bad' : V.phase === 'plan' && !V.ready[them] ? 'wait' : '',
    status: () => `<i></i><span>You: <b>${sideName(me)}</b><br>${!S.connected ? `opponent disconnected — room <b>${formatCode(S.code || '')}</b> stays open` : V.phase === 'over' ? 'game over' : V.phase !== 'plan' ? 'carrying out the week' : V.ready[them] ? 'opponent has ended the week' : 'opponent is planning'}${S.connected && S.peer?.rtt != null ? ` · ${S.peer.rtt} ms` : ''}</span>`,
    toggleReady: () => { if (V.phase !== 'plan') return; V.setReady(me, !V.ready[me]); pushState(true); ui.renderTop(); maybeResolve(); },
    leave: (final = false) => { if (!final && !confirm('Leave the game? You can resume it later from the Versus menu — your opponent rejoins with the same room code.')) return; clearTimeout(saveT); if (final || V.phase === 'over') lsSet(HOST_KEY, null); else lsSet(HOST_KEY, { code: S.code, saved: V.save(), at: Date.now(), live: false }); S.send('v2bye', {}); setTimeout(() => { try { S.peer?.close(); } catch { } location.href = location.pathname; }, 150); },
  };
  function onMsg(m) {
    const d = m.d;
    if (m.t === 'v2hello') { pushState(true); if (cur && S.frame) { S.send('v2battle', cur.desc); if (S.manifest) S.send('manifest', S.manifest); } return; }
    if (m.t === 'v2cmd') { if (d && d.seq > (V.acks[them] || 0)) { V.apply(them, d.name, d.args); V.acks[them] = d.seq; } refresh(); pushState(); return; }
    if (m.t === 'v2ready') { if (d?.seq == null || d.seq >= (V.acks[them] || 0)) { V.setReady(them, !!d?.ready); } pushState(true); ui?.renderTop(); maybeResolve(); return; }
    if (m.t === 'v2bye') { banner(`Your opponent has left the game. The room <b>${formatCode(S.code || '')}</b> stays open — they can rejoin with it.`, 'bad'); return; }
    S.route(m);
  }
  async function onDrop() {
    ui?.renderTop();
    if (!S.code) { banner('The connection was lost. Go back to the Versus menu — you can resume this game there.', 'bad'); return; }
    banner(`Opponent disconnected. Waiting for them to reconnect with room code <b>${formatCode(S.code)}</b>… You can keep planning.`, 'bad');
    for (let i = 0; !S.connected; i++) {
      const p = new RoomPeer('host'); const code = await p.host(S.code);
      if (!code) { p.close(); await sleep(4000); continue; }
      // (the room-code service itself may drop: register the code again instead of waiting on a dead registration)
      await new Promise(res => { p.on('open', () => { S.bind(p); res(); }); p.on('fail', f => { if (f.kind === 'broker' && !p.open) { p.close(); setTimeout(res, 3000); } }); });
    }
    banner(''); pushState(true); refresh(); ui?.toast('Opponent reconnected');
  }
  function maybeResolve() { if (V.bothReady() && !resolving) resolve(); }
  async function resolve(resume = false) {
    resolving = true; const C = V.side[me], fromN = C.logSeq || 0, d0 = C.date;
    if (!resume) V.buildQueue();
    pushState(true); ui?.renderTop();
    if (resume && V.pendingBattle) { await fight(V.pendingBattle); refresh(); }
    for (;;) { const b = V.nextAttack(); persist(); refresh(); if (!b) break; pushState(true); await fight(b); refresh(); }
    V.endWeek(); persist(); pushState(true);
    resolving = false; ui.setCampaign(mine()); weekReport(ui, V.side[me], fromN, d0);
  }
  function fight(b) {
    return new Promise(res => {
      const hostAtt = b.f === me, HC = V.side[me], GC = V.side[them];
      const hostUids = hostAtt ? HC.tf(b.tf).units : b.defUids, guestUids = hostAtt ? b.defUids : GC.tf(b.tf).units;
      const setup = HC.battleSetup(b.cell, hostUids, hostAtt ? 'attack' : 'defend');
      setup.enemy = []; const ov = new URLSearchParams(location.search).get('vsmap'); if (ov) setup.map = ov;   // test hook
      const opts = { side: me, map: setup.map, campaign: setup, net: { role: 'host', enemyForce: JSON.parse(JSON.stringify(GC.battleUnits(guestUids))), enemyMods: GC.battleMods(b.cell, guestUids) } };
      // a fresh id per fight: a battle fought again after the host reloaded is a new battle for the joiner (a new iframe)
      const desc = { id: `${b.id}.${(++fightN).toString(36)}${Date.now().toString(36).slice(-4)}`, side: them, map: setup.map, sectorName: setup.sectorName, mode: hostAtt ? 'defend' : 'attack' }; cur = { b, desc };
      V.battle = cur.desc; pushState(true); S.send('v2battle', cur.desc);
      ui?.toast(`Battle for ${setup.sectorName}`);
      S.openFrame(opts, (rHost, rGuest) => {
        if (!cur || cur.b !== b) return; cur = null;
        S.closeFrame(); V.battle = null; S.send('v2battleEnd', { id: desc.id });
        V.applyBattle(b, hostAtt ? rHost : rGuest, hostAtt ? rGuest : rHost); persist(); res();
      }, msg => {   // the battle map could not be built on this computer: the staff resolves the battle instead of hanging
        if (!cur || cur.b !== b) return; cur = null; console.warn('versus battle failed to load:', msg);
        S.closeFrame(); V.battle = null; S.send('v2battleEnd', { id: desc.id });
        V.autoBattle(b); persist(); ui?.toast(`The battle for ${setup.sectorName} could not be loaded — the staff resolved it`, false); res();
      });
    });
  }
  ui = await openScreen(mine(), { vs: adapter, test: false });
  window.__vsUi = ui;
  if (!saved) ui.modal(`<div class="c2-k">VERSUS · ${esc(dateLabel(V.side[me].date, true).toUpperCase())}</div><h2>${esc(V.side[me].def.brigade?.name || sideName(me))}</h2><div class="c2-note">You command the ${sideName(me)} brigade on the ${esc(V.sdef[V.opId].aor.name || V.sdef[V.opId].title)}; the other player commands the ${sideName(them)} brigade opposite you. Plan your moves and attacks for the week, then end it — when both of you have, the attacks are carried out (battles against the other player's task forces are fought by both of you on the battle map).</div>`, [['TO COMMAND', 'pri', () => ui.offerTutorial()]]);
  else { banner(''); ui.toast(`Game resumed · week ${V.turn}`); }
  pushState(true);
  if (V.phase === 'resolve') resolve(true);   // reloaded while the week was being carried out: continue (a battle in progress is fought again)
  window.__done = true;
}

async function guestSession(peer, defs, code) {
  const { mirror2 } = await import('../campaign/v2/versus.js'), { openScreen } = await import('../campaign/v2/ui.js');
  document.getElementById('campaign')?.classList.add('hidden');
  let ui = null, C = null, st = null, seq = 0, outbox = [], markN = 0, lastTurn = 0, opening = null, lastSig = '', resync = false; const cache = {};
  const S = linkState(peer, code, m => onMsg(m), () => onDrop()); window.__vsLink = S;
  let liveT = 0; const live = () => { if (S.code && performance.now() - liveT > 5000) { liveT = performance.now(); lsSet(GUEST_KEY, { code: S.code, at: Date.now(), live: st?.phase !== 'over' }); } };   // a reload rejoins by itself
  if (code) lsSet(GUEST_KEY, { code, at: Date.now(), live: true });
  const adapter = {
    act: (name, args) => {
      if (!st || st.phase !== 'plan') { ui?.toast('The week is being carried out — wait for the next one', false); return 'The week is being resolved'; }
      if (st.ready && name !== 'rename') { ui?.toast('You have ended the week — click WAITING… to change your orders', false); return 'You have ended the week'; }
      const r = C[name](...args); if (typeof r === 'string') { ui?.toast(r, false); return r; }
      const cmd = { seq: ++seq, name, args }; outbox.push(cmd); S.send('v2cmd', cmd); return r;
    },
    isReady: () => !!st?.ready && st?.phase === 'plan',
    endLabel: () => !st ? '…' : st.phase === 'over' ? 'GAME OVER' : st.phase !== 'plan' ? 'RESOLVING…' : st.ready ? 'WAITING…' : 'END WEEK ▸',
    statusKind: () => !S.connected ? 'bad' : st?.phase === 'plan' && !st?.oppReady ? 'wait' : '',
    status: () => `<i></i><span>You: <b>${sideName(st?.faction)}</b><br>${!S.connected ? 'connection lost — reconnecting…' : !st ? '' : st.phase === 'over' ? 'game over' : st.phase !== 'plan' ? 'the host is carrying out the week' : st.oppReady ? 'opponent has ended the week' : 'opponent is planning'}${S.connected && S.peer?.rtt != null ? ` · ${S.peer.rtt} ms` : ''}</span>`,
    toggleReady: () => { if (!st || st.phase !== 'plan') return; st.ready = !st.ready; S.send('v2ready', { ready: st.ready, seq }); ui.renderTop(); },
    leave: (final = false) => { if (!final && !confirm('Leave the game? You can rejoin from the Versus menu while the host keeps the game.')) return; if (final || st?.phase === 'over') lsSet(GUEST_KEY, null); else lsSet(GUEST_KEY, { code: S.code, at: Date.now(), live: false }); S.send('v2bye', {}); setTimeout(() => { try { S.peer?.close(); } catch { } location.href = location.pathname; }, 150); },
  };
  async function onState(s) {
    const prev = st; st = s; live();
    // a new session of this joiner (page reloaded, rejoined): carry on the host's command numbering — the host ignores
    // command / ready messages numbered at or below what it has already applied
    if (!outbox.length && (s.ack || 0) > seq) seq = s.ack;
    if (!ui) {
      if (opening) return; C = mirror2(defs, s, cache); markN = C.logSeq || 0; lastTurn = s.turn;
      opening = openScreen(C, { vs: adapter }); ui = await opening; window.__vsUi = ui; opening = null;
      ui.modal(`<div class="c2-k">VERSUS · ${esc(dateLabel(C.date, true).toUpperCase())}</div><h2>${esc(C.def.brigade?.name || sideName(s.faction))}</h2><div class="c2-note">You command the ${sideName(s.faction)} brigade; the host commands the ${sideName(s.faction === 'UA' ? 'RU' : 'UA')} brigade opposite you. Plan your moves and attacks for the week, then end it — when both of you have, the attacks are carried out.</div>`, [['TO COMMAND', 'pri', () => ui.offerTutorial()]]);
      onState(st); return;
    }
    const newTurn = s.turn !== lastTurn, sig = JSON.stringify([s.c, s.foes, s.phase]);
    const force = resync; if (resync) { resync = false; outbox = []; }
    else if (!newTurn && sig === lastSig && !outbox.length) { if (s.battle && (!S.frame || S.battleId !== s.battle.id)) openBattle(s.battle); ui.renderTop(); return; }   // nothing on this side changed
    lastSig = sig;
    if (force || newTurn || s.ack >= seq || s.phase !== 'plan') {
      outbox = outbox.filter(c => c.seq > s.ack);
      const d0 = C.date; C = mirror2(defs, s, cache); ui.setCampaign(C);
      if (newTurn) { const from = markN; markN = C.logSeq || 0; lastTurn = s.turn; outbox = []; weekReport(ui, C, from, d0); markN = C.logSeq || 0; }
    } else { C.foes = s.foes; C.vsCover = s.c?.vsCover || C.vsCover; C.vsSeen = s.c?.vsSeen || C.vsSeen; ui.map.refresh(); }   // (the host's picture of the held squares: versus.js refreshCover)
    if (s.battle && (!S.frame || S.battleId !== s.battle.id)) openBattle(s.battle);
    if (!s.battle && S.frame) { S.closeFrame(); S.battleId = null; }
    ui.renderTop();
    if (s.result && !prev?.result) ui.checkOutcome();
  }
  function openBattle(b) {
    if (window.__vsRecord) { window.__inBattle = b; return; }
    S.battleId = b.id; S.openFrame({ side: b.side, map: b.map, campaign: { sectorName: b.sectorName, mode: b.mode, force: [], enemy: [] }, net: { role: 'client' } }, () => { });
  }
  function onMsg(m) {
    if (m.t === 'v2state') return onState(m.d);
    if (m.t === 'v2battle') { if (!S.frame || S.battleId !== m.d.id) openBattle(m.d); return; }
    if (m.t === 'v2battleEnd') { if (S.battleId === m.d?.id) { S.closeFrame(); S.battleId = null; } return; }
    if (m.t === 'v2bye') { banner('The host has left the game. Waiting for them to come back with the same room code…', 'bad'); return; }
    if (window.__vsRecord && ['manifest', 'snap', 'ev'].includes(m.t)) (window.__rec ||= []).push(m);   // test hook: record the battle stream
    S.route(m);
  }
  function onDrop() {
    ui?.renderTop();
    if (!S.code) { banner('The connection was lost. Ask the host to resume the game, then join again.', 'bad'); return; }
    let n = 0;
    const attempt = () => {
      if (S.connected) return; n++;
      banner(`Connection to the host lost — reconnecting (attempt ${n})…`, 'bad');
      const p = new RoomPeer('guest'); let settled = false;
      const retry = ms => { if (settled) return; settled = true; try { p.close(); } catch { } setTimeout(attempt, ms); };
      // orders given while cut off go first, then the request for the full state; the host is the authority on what it
      // kept (a host that reloaded may have lost the last unsaved orders), so its next state is taken as it is
      p.on('open', () => { if (settled) return; settled = true; S.bind(p); banner(''); for (const c of outbox) S.send('v2cmd', c); if (st) S.send('v2ready', { ready: !!st.ready, seq }); resync = true; S.send('v2hello', { turn: st?.turn, ack: seq }); ui?.renderTop(); ui?.toast('Reconnected'); });
      p.on('fail', f => retry(f.kind === 'notfound' ? 3000 : 4000));
      p.join(S.code); setTimeout(() => retry(1000), 45000);
    };
    setTimeout(attempt, 800);
  }
  S.send('v2hello', { turn: 0, ack: 0 });
  window.__done = true;
}

function lobbyCss() {
  if (document.getElementById('vs-css')) return;
  document.head.appendChild(Object.assign(document.createElement('style'), { id: 'vs-css', textContent: `
#campaign .vs-lobby{max-width:62rem;margin:5vh auto;max-height:90vh;overflow-y:auto;font-family:var(--font-ui);color:var(--t-1)}
.vs-lobby h1,.vs-lobby h2{font-family:var(--font-head);font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.vs-col.panel{padding:0 var(--sp-4) var(--sp-4)}.vs-col.panel>h3:first-child{margin:0 calc(-1 * var(--sp-4));padding:.4rem var(--sp-4);background:var(--s-2);border-bottom:1px solid var(--line-2)}
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
.vs-dot{flex:none;width:.5rem;height:.5rem;background:var(--t-3)}
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
.vs-resume{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-3);border:1px solid rgba(233,169,59,.45);background:var(--accent-bg);border-radius:var(--r-2)}.vs-resume-t{font-size:var(--fs-m);color:var(--t-1)}.vs-resume-t small{color:var(--t-2)}.vs-rejoin{display:flex;flex-direction:column;gap:var(--sp-2);align-items:flex-start}
.vs-l{font-size:var(--fs-s);color:var(--t-2)}.vs-lobby .cp-back{margin-left:0}.hidden{display:none!important}
.vs-frame{position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:200;background:#000}
body.vs-battle-open>:not(.vs-frame){visibility:hidden!important}body.vs-battle-open *{animation-play-state:paused!important}` }));
}
