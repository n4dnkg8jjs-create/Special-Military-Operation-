// Peer-to-peer link for the versus campaign: WebRTC data channels, no game server of our own.
//
// RoomPeer (default): the host gets a short room code (K7M-4QX). Signalling — the one-time exchange of WebRTC offer /
// answer / ICE candidates — goes through the free public PeerJS broker (0.peerjs.com), where the host registers the id
// "smo-<code>". As soon as the direct link is up both sides drop the broker; all game traffic is peer-to-peer.
// ManualPeer (fallback, "Advanced"): the old copy-paste invite / reply codes, for when the broker is unreachable or
// for a LAN without internet.
//
// Both expose the same interface used by versus_ui.js / battle.js: on/off/emit, send (reliable, ordered 'ctl'
// channel), sendSnap (unreliable, unordered 'snap' channel), close, events 'open' / 'close' / '*' / <message type>,
// plus rtt (ms, measured with internal pings).
//
// NAT traversal: public STUN (Google, Cloudflare) finds each player's public address; that is enough for most home
// routers. Strict NATs (mobile hotspots / CGNAT, some school or office networks) need a TURN relay, which can be
// configured in the lobby (stored in localStorage 'smo_turn').

// several STUN servers on different hosts: one unreachable / slow one does not leave a player without a public address,
// and two answers for the same socket tell a symmetric NAT (a new port per destination: direct cannot work, see iceInfo)
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478'] }];
export function turnConfig() { try { const t = JSON.parse(localStorage.getItem('smo_turn') || 'null'); return t && t.url ? t : null; } catch { return null; } }
export function setTurnConfig(t) { try { if (t && t.url) localStorage.setItem('smo_turn', JSON.stringify(t)); else localStorage.removeItem('smo_turn'); } catch { } }
export function iceServers() {
  const t = turnConfig(), list = STUN.slice();
  if (t) list.push({ urls: t.url.split(/[\s,]+/).filter(Boolean).map(u => (/^turns?:/.test(u) ? u : 'turn:' + u)), username: t.user || '', credential: t.pass || '' });
  return list;
}

// ---- room codes: 6 chars from an alphabet without 0/O/1/I/L, shown as XXX-XXX
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newRoomCode() { const r = crypto.getRandomValues(new Uint8Array(6)); let s = ''; for (const b of r) s += CODE_ALPHABET[b % CODE_ALPHABET.length]; return s; }
export const formatCode = c => c.slice(0, 3) + '-' + c.slice(3);
// user input → canonical code, or null. Case-insensitive, dash / spaces optional.
export function normalizeCode(s) { const c = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); return c.length === 6 && [...c].every(ch => CODE_ALPHABET.includes(ch)) ? c : null; }
const ID_PREFIX = 'smo-';

// ---- shared link logic
// Message size: an RTCDataChannel message over the connection's maxMessageSize (256 KiB Chrome, 64 KiB Safari) makes
// send() throw - and PeerJS closes the whole connection when a send throws (DataConnection._trySend), which dropped the
// joiner mid-battle whenever one message (a big event batch, the spawn manifest, a campaign state) was too big. Every
// reliable message is therefore cut into CTL_CHUNK pieces (UTF-16 units: <= 48 KB even as UTF-8), joined on receipt
// (the channel is ordered); snapshots over SNAP_MAX go over the reliable channel instead of being lost every time.
// Backpressure: backlog() = bytes queued on the link (both channels + PeerJS' own buffer); the battle drops cosmetic
// events / snapshots while it is high instead of queueing seconds of traffic in front of the pings.
const CTL_CHUNK = 16000, SNAP_MAX = 60000, SNAP_BACKLOG = 96 * 1024;
const CHUNK_MARK = '\u0002';
class Link {
  constructor(role) { this.role = role; this.handlers = {}; this.open = false; this.queue = []; this.rtt = null; this.closed = false; this.lastRx = performance.now(); this.parts = null; this.cid = 0; this.stat = { tx: 0, rx: 0, txMax: 0, snapSkip: 0 }; }
  on(t, f) { (this.handlers[t] ||= []).push(f); return this; }
  off(t, f) { this.handlers[t] = (this.handlers[t] || []).filter(x => x !== f); }
  emit(t, ...a) { for (const f of this.handlers[t] || []) try { f(...a); } catch (e) { console.error(e); } }
  _recv(data) {
    this.lastRx = performance.now(); this.stat.rx += data?.length || 0;
    if (typeof data === 'string' && data[0] === CHUNK_MARK) {   // <mark>id|i|n|piece
      const a = data.indexOf('|'), b = data.indexOf('|', a + 1), c = data.indexOf('|', b + 1), id = data.slice(1, a), i = +data.slice(a + 1, b), n = +data.slice(b + 1, c);
      const P = (this.parts ||= new Map()); let e = P.get(id); if (!e) P.set(id, e = { n, got: 0, p: new Array(n) });
      if (e.p[i] == null) { e.p[i] = data.slice(c + 1); e.got++; }
      if (e.got < e.n) return; P.delete(id); data = e.p.join('');
    }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === '__ping') { this._sendCtl(JSON.stringify({ t: '__pong', d: m.d })); this.emit('alive'); return; }
    if (m.t === '__pong') { this.rtt = Math.round(performance.now() - m.d); this.emit('ping', this.rtt); return; }
    this.emit(m.t, m.d, m); this.emit('*', m);
  }
  _opened() {
    if (this.open || this.closed) return; this.open = true;
    for (const m of this.queue) this._sendCtl(m); this.queue = [];
    this.ping(); this._pinger = setInterval(() => this.ping(), 3000);
    this.emit('open');
  }
  _lost(why) { if (this.closed) return; this.emit('close', why); }
  ping() { if (this.open) this._sendCtl(JSON.stringify({ t: '__ping', d: performance.now() })); }
  // a reliable message, cut into pieces the data channel always accepts
  _ctlOut(m, put) {
    this.stat.tx += m.length; this.stat.txMax = Math.max(this.stat.txMax, m.length);
    if (m.length <= CTL_CHUNK) return put(m);
    const id = (++this.cid).toString(36), n = Math.ceil(m.length / CTL_CHUNK);
    for (let i = 0; i < n; i++) put(`${CHUNK_MARK}${id}|${i}|${n}|${m.slice(i * CTL_CHUNK, (i + 1) * CTL_CHUNK)}`);
  }
  backlog() { return (this.ctl?.bufferedAmount || 0) + (this.snap?.bufferedAmount || 0) + (this.conn?.bufferSize ? 1e6 : 0); }   // (PeerJS' own buffer - a message count - only fills past 8 MB on the channel)
  send(t, d) { const m = JSON.stringify({ t, d }); if (this.open) this._sendCtl(m); else this.queue.push(m); }
  sendSnap(t, d) {
    if (!this.open) return; const m = JSON.stringify({ t, d }), ch = this.snap;
    // a full link: skip this snapshot (the next one supersedes it) rather than queue it behind / in front of the rest
    if (this.backlog() > SNAP_BACKLOG) { this.stat.snapSkip++; return; }
    if (!ch || ch.readyState !== 'open' || m.length > SNAP_MAX) return this._sendCtl(m);   // snap channel never came up / too big for one datagram: reliable
    this.stat.tx += m.length; try { ch.send(m); } catch { }
  }
  close() { this.closed = true; clearInterval(this._pinger); }
}

// ---- room-code link through the PeerJS broker
let pjLoading = null;
export function loadPeerJS() {
  if (window.peerjs?.Peer) return Promise.resolve(window.peerjs.Peer);
  return (pjLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;
    s.onload = () => (window.peerjs?.Peer ? res(window.peerjs.Peer) : rej(new Error('PeerJS failed to load')));
    s.onerror = () => { pjLoading = null; rej(new Error('PeerJS failed to load')); }; document.head.appendChild(s);
  }));
}
// broker: the PeerJS cloud by default; ?peerhost=localhost&peerport=9000&peersecure=0 (&peerpath=/) for local tests
export function brokerOptions() {
  const q = new URLSearchParams(location.search), host = q.get('peerhost');
  const o = { debug: 0, config: { iceServers: iceServers() } };
  if (host) Object.assign(o, { host, port: +(q.get('peerport') || 443), secure: q.get('peersecure') !== '0', path: q.get('peerpath') || '/' });
  return o;
}
const BROKER_ERR = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable', 'disconnected', 'invalid-key']);
const SNAP_ID = 64;              // negotiated id of our own unreliable channel on PeerJS' peer connection
export const CONNECT_TIMEOUT = 15000;
const RELAY_AFTER = 7000, RELAY_TIMEOUT = 25000, RELAY_SNAP_MS = 190, RELAY_CHUNK = 24000, ICE_GRACE = 25000;
// relay: resend unacknowledged reliable messages after RELAY_RTO; a gap still open after RELAY_GAP_MS is skipped (the
// messages are lost for good: the battle resyncs its world state by itself, see net/battle.js); outgoing budget
const RELAY_RTO = 2000, RELAY_GAP_MS = 20000, RELAY_BPS = 48 * 1024;
// public MQTT-over-WebSocket brokers (free, no account); ?mqtt=ws://127.0.0.1:8888 (comma list) overrides, for tests
const RELAYS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
export function relayUrls() { const q = new URLSearchParams(location.search).get('mqtt'); return q ? q.split(',') : RELAYS; }
export function newRelayKey() { const r = crypto.getRandomValues(new Uint8Array(16)); let s = ''; for (const b of r) s += CODE_ALPHABET[b % CODE_ALPHABET.length]; return s; }
let mqLoading = null;
export function loadMqtt() {
  if (window.mqtt?.connect) return Promise.resolve(window.mqtt);
  return (mqLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = new URL('../../vendor/mqtt/mqtt.min.js', import.meta.url).href;
    s.onload = () => (window.mqtt?.connect ? res(window.mqtt) : rej(new Error('relay client failed to load')));
    s.onerror = () => { mqLoading = null; rej(new Error('relay client failed to load')); }; document.head.appendChild(s);
  }));
}

// Events beyond Link's: 'code' (host: room code ready), 'status' (text-ish state: 'broker' | 'waiting' | 'connecting'),
// 'fail' ({ kind: 'broker' | 'notfound' | 'ice' | 'busy', msg }).
export class RoomPeer extends Link {
  constructor(role) { super(role); this.pj = null; this.conn = null; this.code = null; }

  async _broker(id) {
    const PJ = await loadPeerJS().catch(() => { throw Object.assign(new Error('could not load PeerJS'), { kind: 'broker' }); });
    return new Promise((res, rej) => {
      const pj = id ? new PJ(id, brokerOptions()) : new PJ(brokerOptions());
      const t = setTimeout(() => { pj.destroy(); rej(Object.assign(new Error('broker timeout'), { kind: 'broker' })); }, 12000);
      const onErr = e => { clearTimeout(t); pj.off('open', onOpen); pj.destroy(); rej(Object.assign(new Error(e.message || e.type), { kind: e.type === 'unavailable-id' ? 'taken' : 'broker', type: e.type })); };
      const onOpen = () => { clearTimeout(t); pj.off('error', onErr); res(pj); };
      pj.once('open', onOpen); pj.once('error', onErr);
    });
  }
  _watch(pj) {
    pj.on('error', e => {
      if (this.open || this.closed || this.mode === 'relay') return;
      if (e.type === 'peer-unavailable') this._fail('notfound');
      else if (BROKER_ERR.has(e.type)) this._fail('broker', e.message);
      else if (e.type === 'webrtc') { if (!this.relayKey) this._fail('ice', e.message); }   // with a relay key the timer switches to the relay
      else console.warn('peerjs', e.type, e.message);
    });
    pj.on('disconnected', () => { if (!this.open && !this.closed && this.role === 'host') setTimeout(() => { if (!this.open && !this.closed && !pj.destroyed) try { pj.reconnect(); } catch { } }, 1500); });
  }
  _fail(kind, msg) { if (this.closed) return; this.emit('fail', { kind, msg }); }

  // host: register a fresh room code at the broker (or `fixed`: the same code again, to resume a game / let the
  // joiner reconnect after a dropped link), then wait for the joiner
  async host(fixed = null) {
    this.emit('status', 'broker');
    for (let i = 0; i < (fixed ? 8 : 6); i++) {
      const code = fixed || newRoomCode();
      try { this.pj = await this._broker(ID_PREFIX + code); this.code = code; break; } catch (e) {
        if (this.closed) return null;
        if (e.kind !== 'taken' || i === (fixed ? 7 : 5)) { this._fail(e.kind === 'taken' ? 'taken' : 'broker', e.message); return null; }
        if (fixed) await new Promise(r => setTimeout(r, 2500));   // the broker still holds the old registration for a moment
      }
    }
    if (this.closed) { this.pj.destroy(); return null; }
    this._watch(this.pj);
    this.pj.on('connection', conn => {
      if (this.open || (this.conn && this.conn.open)) { conn.on('open', () => { try { conn.send(JSON.stringify({ t: '__full' })); } catch { } setTimeout(() => conn.close(), 300); }); return; }
      try { this.conn?.close(); } catch { }
      this._wire(conn);
    });
    this.emit('code', this.code); this.emit('status', 'waiting');
    return this.code;
  }
  // joiner: connect to the host's code
  async join(code) {
    this.emit('status', 'broker');
    try { this.pj = await this._broker(null); } catch (e) { this._fail('broker', e.message); return; }
    if (this.closed) { this.pj.destroy(); return; }
    this._watch(this.pj); this.code = code;
    this.relayKey = newRelayKey();
    this._wire(this.pj.connect(ID_PREFIX + code, { reliable: true, serialization: 'raw', label: 'ctl', metadata: { relay: this.relayKey } }));
  }
  _wire(conn) {
    this.conn = conn; this.emit('status', 'connecting');
    if (this.role === 'host') this.relayKey = conn.metadata?.relay || null;
    // no direct link after RELAY_AFTER: start the public relay as well - but keep the direct attempt alive, and whichever
    // opens first carries the game. (It used to CLOSE the direct attempt at 8 s: hole punching between two home NATs
    // that took longer - slow STUN replies, candidates trickling through the broker, a busy machine - never got the
    // chance, so "direct never works". It now has until the relay is up, at least DIRECT_MIN.)
    const toRelay = () => { clearTimeout(timer); if (this.open || this.closed || this.conn !== conn || this.relaying) return; if (this.relayKey) this._startRelay(); else this._fail('ice', this.iceInfo()); };
    const timer = setTimeout(toRelay, RELAY_AFTER);
    this._iceWatch(conn);
    conn.on('data', d => { if (this.mode === 'relay') return; if (typeof d === 'string' && d.includes('"__full"')) { this._fail('busy'); return; } this._recv(d); });
    conn.on('error', e => { console.warn('direct link:', e?.type || e?.message || e); if (!this.open && this.conn === conn) toRelay(); });
    conn.on('close', () => { if (this.conn === conn && this.open && this.mode !== 'relay') this._lost('ctl'); });
    conn.on('open', () => {
      clearTimeout(timer); if (this.conn !== conn || this.closed || this.mode === 'relay') return;
      if (this.relaying) this._endRelay(true);   // direct won the race: the relay is not needed
      this.ctl = conn.dataChannel; this.emit('status', 'direct');
      const pc = conn.peerConnection;
      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState;
        // 'disconnected' is transient on a relayed (TURN) or lossy path - a few seconds without consent replies during a
        // burst - and usually comes back by itself: it used to drop the link after 5 s. Only 'failed' / 'closed', or
        // 'disconnected' that lasts ICE_GRACE with nothing received meanwhile, count as lost
        if (s === 'failed' || s === 'closed') this._lost(s);
        else if (s === 'disconnected') { const t0 = performance.now(); clearInterval(this._iceT); this._iceT = setInterval(() => { const st = pc.connectionState; if (st === 'connected' || this.closed) return clearInterval(this._iceT); if (performance.now() - t0 > ICE_GRACE && performance.now() - this.lastRx > ICE_GRACE / 2) { clearInterval(this._iceT); this._lost('disconnected'); } }, 1000); }
      });
      try {
        const ch = this.snap = pc.createDataChannel('snap', { negotiated: true, id: SNAP_ID, ordered: false, maxRetransmits: 0 });
        ch.onmessage = e => this._recv(e.data); ch.onopen = () => this._opened();
        if (ch.readyState === 'open') this._opened();
      } catch (e) { console.warn('snap channel', e); }
      setTimeout(() => this._opened(), 2500);          // snap never opened: run on ctl only (sendSnap falls back)
    });
  }
  _opened() { if (this.open) return; super._opened(); try { this.pj?.disconnect(); } catch { } }   // free the code at the broker
  // what ICE found on this side (for the status line / console when the direct link does not come up)
  _iceWatch(conn) {
    const I = this.ice = { local: {}, remote: 0, srflx: new Map(), sym: false, state: 'new' };
    const hook = pc => {
      pc.addEventListener('icecandidate', e => { const c = e.candidate; if (!c?.candidate) return; const t = c.type || / typ (\w+)/.exec(c.candidate)?.[1]; I.local[t] = (I.local[t] || 0) + 1;
        if (t === 'srflx') { const base = `${c.relatedAddress}:${c.relatedPort}`, prev = I.srflx.get(base); if (prev != null && prev !== c.port) I.sym = true; I.srflx.set(base, c.port); } });
      pc.addEventListener('iceconnectionstatechange', () => { I.state = pc.iceConnectionState; if (I.state === 'failed') console.warn('direct link: ICE failed', this.iceInfo()); });
    };
    if (conn.peerConnection) hook(conn.peerConnection); else { let n = 0; const iv = setInterval(() => { if (conn.peerConnection) { clearInterval(iv); hook(conn.peerConnection); } else if (++n > 50) clearInterval(iv); }, 100); }
  }
  iceInfo() {
    const I = this.ice; if (!I) return '';
    const l = I.local, pub = (l.srflx || 0) + (l.relay || 0);
    return !Object.keys(l).length ? 'no network candidates gathered' : !pub ? 'no public address found (STUN servers unreachable - UDP blocked?)' : I.sym ? 'your router gives a different public port per destination (symmetric NAT / carrier-grade NAT): a direct link needs a TURN relay' : `ICE ${I.state}: ${Object.entries(l).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  }
  _sendCtl(m) { if (this.mode === 'relay') return this._relayCtl(m); this._ctlOut(m, x => { try { this.conn?.send(x); } catch (e) { console.warn(e); } }); }
  backlog() { return this.mode === 'relay' ? this._relayBacklog() : super.backlog(); }
  sendSnap(t, d) {
    if (this.mode !== 'relay') return super.sendSnap(t, d);
    if (!this.open) return; const now = performance.now(); if (now - (this._lastSnap || 0) < RELAY_SNAP_MS) return;   // ~5 Hz over the relay
    if (this._relayBacklog() > RELAY_BPS / 2) { this.stat.snapSkip++; return; }   // over budget: this one is skipped, the next supersedes it
    this._lastSnap = now;
    const m = JSON.stringify({ t, d }); this.stat.tx += m.length;
    if (m.length <= RELAY_CHUNK) return this._pub('s|' + m);
    // a big snapshot in pieces (public brokers cap the packet size and disconnect a client that exceeds it)
    const id = (++this.cid).toString(36), n = Math.ceil(m.length / RELAY_CHUNK);
    for (let i = 0; i < n; i++) this._pub(`S${id}.${i}/${n}|${m.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK)}`);
  }
  close() { super.close(); clearInterval(this._iceT); clearInterval(this._relayT); try { this.conn?.close(); } catch { } try { this.pj?.destroy(); } catch { } for (const c of this.mq || []) try { c.end(true); } catch { } }

  // ---- relay mode: both players talk through public MQTT-over-WebSocket brokers (outbound wss only, so it works
  // behind any NAT). The topic is a random 16-char key the joiner sent along with the handshake, so only the two
  // players know it. We connect to every broker, listen on all of them, and send through the first one the
  // opponent's messages arrived on (another connected one while that one is down).
  // Reliable messages carry a sequence number and are acknowledged (cumulative 'a|<seq>', ~4 Hz); the unacknowledged
  // are sent again after RELAY_RTO. Publishing is QoS 0: a broker drops messages under load and while a client
  // reconnects, and one lost message used to hold every later one in the reorder buffer for good - no events, no
  // pongs, no orders - until the liveness timeout dropped the link ("kicked"). A gap that outlives RELAY_GAP_MS is
  // skipped. Outgoing bytes are metered (RELAY_BPS): snapshots are skipped while over budget.
  async _startRelay() {
    this.relaying = true; this.emit('status', 'relay', this.iceInfo());
    let M; try { M = await loadMqtt(); } catch { this.relaying = false; this._fail('relay'); return; }
    if (this.closed || !this.relaying || this.open) return;
    const me = this.role === 'host' ? 'h' : 'g', them = me === 'h' ? 'g' : 'h', base = `smo-vs/${this.relayKey}/`;
    this.myTopic = base + me; this.mq = []; this.via = null; this.txSeq = 0; this.rxNext = 1; this.rxBuf = new Map(); this.rparts = {};
    this.unacked = new Map(); this.ackDue = false; this.gapT = 0; this.sparts = null; this.meter = { t: performance.now(), b: 0 };
    for (const url of relayUrls()) {
      let c; try { c = M.connect(url, { clientId: 'smo' + newRelayKey().slice(0, 10), reconnectPeriod: 2000, connectTimeout: 8000, clean: true, keepalive: 20, queueQoSZero: false }); } catch { continue; }
      this.mq.push(c);
      c.on('connect', () => c.subscribe(base + them, { qos: 0 }, err => { if (!err) c._smoReady = true; }));
      c.on('close', () => { c._smoReady = false; });
      c.on('message', (_t, buf) => this._relayIn(c, buf.toString()));
      c.on('error', () => { });
    }
    clearInterval(this._relayT); this._relayT = setInterval(() => this._relayTick(), 250);
    // say hello on every broker until the opponent answers; give up after RELAY_TIMEOUT
    const t0 = performance.now();
    this._hello = setInterval(() => {
      if (this.closed || (this.open && this.heard)) return clearInterval(this._hello);
      for (const c of this.mq) if (c._smoReady) try { c.publish(this.myTopic, 'hello|' + (this.heard ? 1 : 0)); } catch { }
      if (!this.open && performance.now() - t0 > RELAY_TIMEOUT) { clearInterval(this._hello); this._endRelay(); this._fail('relay', this.iceInfo()); }
    }, 700);
  }
  // keepDirect: the direct link won the race (only the relay goes); otherwise both attempts end (host keeps its code: the joiner can retry)
  _endRelay(keepDirect = false) { clearInterval(this._relayT); clearInterval(this._hello); for (const c of this.mq || []) try { c.end(true); } catch { } this.mq = []; this.via = null; this.heard = false; this.relaying = false; this.mode = null; if (!keepDirect) { try { this.conn?.close(); } catch { } this.conn = null; } }
  // 4 Hz: acknowledge, resend what the other side has not acknowledged, skip a gap that will not fill
  _relayTick() {
    if (this.closed || this.mode !== 'relay' || !this.open) return;
    const now = performance.now();
    if (this.ackDue) { this.ackDue = false; this._pub('a|' + (this.rxNext - 1)); }
    const rto = RELAY_RTO;   // (not from the ping time: that includes waiting for resends, and grew with every loss)
    // a hole in what we received (later messages are waiting): ask for the missing ones at once (NACK) instead of
    // waiting for the sender's timeout - everything behind the hole waits for it
    if (this.rxBuf.size && now - (this.nackT || 0) > 500) { const top = Math.max(...this.rxBuf.keys()), miss = []; for (let q = this.rxNext; q < top && miss.length < 24; q++) if (!this.rxBuf.has(q)) miss.push(q); if (miss.length) { this.nackT = now; this._pub('n|' + miss.join(','), true); } }
    let budget = 64 * 1024;   // (resent bytes per tick: a long outage does not come back as one burst)
    for (const [, e] of this.unacked) { if (now - e.t < rto) continue; if (budget <= 0) break; e.t = now; e.n++; for (const p of e.p) { this._pub(p, true); budget -= p.length; } this.stat.resent = (this.stat.resent || 0) + 1; }
    if (this.rxBuf.size) { if (!this.gapT) this.gapT = now; else if (now - this.gapT > RELAY_GAP_MS) { const next = Math.min(...this.rxBuf.keys()); console.warn('relay: skipped lost messages', this.rxNext, '..', next - 1); this.rxNext = next; this.gapT = 0; this._drain(); } }
    else this.gapT = 0;
  }
  _relayBacklog() { const now = performance.now(), M = this.meter; if (!M) return 0; const k = Math.min(1, (now - M.t) / 1000); M.b = Math.max(0, M.b - k * RELAY_BPS); M.t = now; return M.b; }
  _drain() { while (this.rxBuf.has(this.rxNext)) { const m = this.rxBuf.get(this.rxNext); this.rxBuf.delete(this.rxNext); this.rxNext++; this._recv(m); } if (!this.rxBuf.size) this.gapT = 0; }
  _relayIn(c, s) {
    if (this.closed || !this.relaying) return;
    if (this.mode !== 'relay') {   // the relay won the race: the direct attempt goes
      if (this.open) return;       // (the direct link is up already: ignore the relay)
      this.mode = 'relay'; const dc = this.conn; this.conn = null; try { dc?.close(); } catch { }
    }
    if (!this.via || !this.via._smoReady) this.via = c;
    this.heard = true; this.lastRx = performance.now();
    if (!this.open) { this._opened(); this.emit('status', 'relay-open'); }
    const k = s.indexOf('|'), kind = s.slice(0, k), body = s.slice(k + 1);
    if (kind === 'hello') return;
    if (kind === 's') return this._recv(body);
    if (kind === 'a') { const n = +body; for (const q of this.unacked.keys()) if (q <= n) this.unacked.delete(q); return; }
    if (kind === 'n') { const now = performance.now(); for (const q of body.split(',')) { const e = this.unacked.get(+q); if (e && now - (e.nk || 0) > 400) { e.nk = now; e.t = now; for (const p of e.p) this._pub(p, true); this.stat.resent = (this.stat.resent || 0) + 1; } } return; }
    if (kind[0] === 'S') {   // a snapshot in pieces: S<id>.<i>/<n>|piece (unreliable: an incomplete one is dropped by the next)
      const [id, part] = kind.slice(1).split('.'), [i, n] = part.split('/').map(Number);
      if (!this.sparts || this.sparts.id !== id) this.sparts = { id, n, got: 0, p: new Array(n) };
      const P = this.sparts; if (P.p[i] == null) { P.p[i] = body; P.got++; } if (P.got === P.n) { this.sparts = null; this._recv(P.p.join('')); }
      return;
    }
    if (kind[0] === 'c') {   // c<seq>|json  or  c<seq>.<i>/<n>|chunk
      const [sq, part] = kind.slice(1).split('.'), seq = +sq;
      this.ackDue = true;
      if (seq < this.rxNext || this.rxBuf.has(seq)) return;   // (a resend of one we have: the ack above stops it)
      let msg = body;
      if (part) { const [i, n] = part.split('/').map(Number), P = this.rparts[seq] ||= new Array(n); P[i] = body; for (let j = 0; j < n; j++) if (P[j] == null) return; msg = P.join(''); delete this.rparts[seq]; }
      this.rxBuf.set(seq, msg);
      this._drain();
    }
  }
  _relayCtl(m) {
    const seq = ++this.txSeq; this.stat.tx += m.length; this.stat.txMax = Math.max(this.stat.txMax, m.length);
    const p = m.length <= RELAY_CHUNK ? [`c${seq}|${m}`] : Array.from({ length: Math.ceil(m.length / RELAY_CHUNK) }, (_, i) => `c${seq}.${i}/${Math.ceil(m.length / RELAY_CHUNK)}|${m.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK)}`);
    this.unacked.set(seq, { p, t: performance.now(), n: 0 });
    for (const x of p) this._pub(x);
  }
  // all: through every connected broker (a second resend: the one we use may be the one that lost it / dropped the
  // other side's subscription; duplicates are ignored by sequence number)
  _pub(s, all = false) {
    const c = (this.via?._smoReady && this.via) || this.mq?.find(x => x._smoReady) || this.via; if (!c) return;
    const list = all ? this.mq.filter(x => x._smoReady) : [c];
    for (const x of list.length ? list : [c]) { if (this.meter) { this._relayBacklog(); this.meter.b += s.length; } try { x.publish(this.myTopic, s, { qos: 0 }); } catch (e) { console.warn(e); } }
  }
}

// ---- manual copy-paste signalling (fallback)
async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== 'undefined') {
    const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buf = new Uint8Array(await new Response(cs).arrayBuffer());
    return 'Z' + btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return 'J' + btoa(String.fromCharCode(...bytes));
}
async function unpack(code) {
  code = code.trim().replace(/\s+/g, '');
  const kind = code[0], b64 = code.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bin = Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
  if (kind === 'Z') { const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return JSON.parse(await new Response(ds).text()); }
  return JSON.parse(new TextDecoder().decode(bin));
}
const gathered = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 4000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });

export class ManualPeer extends Link {
  constructor(role) {
    super(role);
    this.pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc.addEventListener('connectionstatechange', () => { const s = this.pc.connectionState; if (s === 'failed' || s === 'disconnected' || s === 'closed') this._lost(s); });
    if (role === 'host') { this.setup(this.pc.createDataChannel('ctl', { ordered: true }), 'ctl'); this.setup(this.pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 }), 'snap'); }
    else this.pc.addEventListener('datachannel', e => this.setup(e.channel, e.channel.label));
  }
  setup(ch, name) {
    this[name] = ch; ch.binaryType = 'arraybuffer';
    ch.onopen = () => { if (this.ctl?.readyState === 'open' && this.snap?.readyState === 'open') this._opened(); };
    ch.onmessage = e => this._recv(e.data);
    ch.onclose = () => this._lost(name);
  }
  _sendCtl(m) { this._ctlOut(m, x => { try { this.ctl.send(x); } catch (e) { console.warn(e); } }); }
  // host: invite code
  async invite() { const o = await this.pc.createOffer(); await this.pc.setLocalDescription(o); await gathered(this.pc); return pack({ v: 1, sdp: this.pc.localDescription }); }
  // joiner: paste invite, get reply code
  async join(code) { const { sdp } = await unpack(code); await this.pc.setRemoteDescription(sdp); const a = await this.pc.createAnswer(); await this.pc.setLocalDescription(a); await gathered(this.pc); return pack({ v: 1, sdp: this.pc.localDescription }); }
  // host: paste reply
  async accept(code) { const { sdp } = await unpack(code); await this.pc.setRemoteDescription(sdp); }
  close() { super.close(); try { this.pc.close(); } catch { } }
}
export { ManualPeer as Peer };

// the link survives page reloads only inside one page; the versus mode therefore runs campaign screen and battles
// in the same page (no reloads), see versus.js
export const net = { peer: null };
