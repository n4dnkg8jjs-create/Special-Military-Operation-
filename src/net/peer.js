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

const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
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
class Link {
  constructor(role) { this.role = role; this.handlers = {}; this.open = false; this.queue = []; this.rtt = null; this.closed = false; }
  on(t, f) { (this.handlers[t] ||= []).push(f); return this; }
  off(t, f) { this.handlers[t] = (this.handlers[t] || []).filter(x => x !== f); }
  emit(t, ...a) { for (const f of this.handlers[t] || []) try { f(...a); } catch (e) { console.error(e); } }
  _recv(data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === '__ping') { this._sendCtl(JSON.stringify({ t: '__pong', d: m.d })); return; }
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
  send(t, d) { const m = JSON.stringify({ t, d }); if (this.open) this._sendCtl(m); else this.queue.push(m); }
  sendSnap(t, d) {
    if (!this.open) return; const m = JSON.stringify({ t, d }), ch = this.snap;
    if (!ch || ch.readyState !== 'open') return this._sendCtl(m);   // snap channel never came up: fall back to ctl
    if (ch.bufferedAmount > 256 * 1024) return; try { ch.send(m); } catch { }
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
const RELAY_AFTER = 8000, RELAY_TIMEOUT = 20000, RELAY_SNAP_MS = 190, RELAY_CHUNK = 60000;
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
    // no direct link after RELAY_AFTER (strict NAT / CGNAT on either side): carry the game over the public relay instead
    const toRelay = () => { clearTimeout(timer); if (this.open || this.closed || this.conn !== conn || this.mode === 'relay') return; if (this.relayKey) this._startRelay(); else this._fail('ice'); };
    const timer = setTimeout(toRelay, RELAY_AFTER);
    conn.on('data', d => { if (this.mode === 'relay') return; if (typeof d === 'string' && d.includes('"__full"')) { this._fail('busy'); return; } this._recv(d); });
    conn.on('error', () => { if (!this.open && this.conn === conn) toRelay(); });
    conn.on('close', () => { if (this.conn === conn && this.open && this.mode !== 'relay') this._lost('ctl'); });
    conn.on('open', () => {
      clearTimeout(timer); if (this.conn !== conn || this.closed || this.mode === 'relay') return;
      this.ctl = conn.dataChannel;
      const pc = conn.peerConnection;
      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'closed') this._lost(s);
        else if (s === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') this._lost('disconnected'); }, 5000);
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
  _sendCtl(m) { if (this.mode === 'relay') return this._relayCtl(m); try { this.conn?.send(m); } catch (e) { console.warn(e); } }
  sendSnap(t, d) {
    if (this.mode !== 'relay') return super.sendSnap(t, d);
    if (!this.open) return; const now = performance.now(); if (now - (this._lastSnap || 0) < RELAY_SNAP_MS) return; this._lastSnap = now;   // ~5 Hz over the relay
    this._pub('s|' + JSON.stringify({ t, d }));
  }
  close() { super.close(); try { this.conn?.close(); } catch { } try { this.pj?.destroy(); } catch { } for (const c of this.mq || []) try { c.end(true); } catch { } }

  // ---- relay mode: both players talk through public MQTT-over-WebSocket brokers (outbound wss only, so it works
  // behind any NAT). The topic is a random 16-char key the joiner sent along with the handshake, so only the two
  // players know it. We connect to every broker, listen on all of them, and send through the first one the
  // opponent's messages arrived on. Reliable messages carry a sequence number (reordered / deduped on receipt).
  async _startRelay() {
    this.mode = 'relay'; this.emit('status', 'relay');
    try { this.conn?.close(); } catch { }
    let M; try { M = await loadMqtt(); } catch { this._fail('relay'); return; }
    if (this.closed) return;
    const me = this.role === 'host' ? 'h' : 'g', them = me === 'h' ? 'g' : 'h', base = `smo-vs/${this.relayKey}/`;
    this.myTopic = base + me; this.mq = []; this.via = null; this.txSeq = 0; this.rxNext = 1; this.rxBuf = new Map(); this.parts = {};
    for (const url of relayUrls()) {
      let c; try { c = M.connect(url, { clientId: 'smo' + newRelayKey().slice(0, 10), reconnectPeriod: 3000, connectTimeout: 8000, clean: true, keepalive: 30 }); } catch { continue; }
      this.mq.push(c);
      c.on('connect', () => c.subscribe(base + them, { qos: 0 }, err => { if (!err) c._smoReady = true; }));
      c.on('message', (_t, buf) => this._relayIn(c, buf.toString()));
      c.on('error', () => { });
    }
    // say hello on every broker until the opponent answers; give up after RELAY_TIMEOUT
    const t0 = performance.now();
    this._hello = setInterval(() => {
      if (this.closed || (this.open && this.heard)) return clearInterval(this._hello);
      for (const c of this.mq) if (c._smoReady) try { c.publish(this.myTopic, 'hello|' + (this.heard ? 1 : 0)); } catch { }
      if (!this.open && performance.now() - t0 > RELAY_TIMEOUT) { clearInterval(this._hello); this._endRelay(); this._fail('relay'); }
    }, 700);
  }
  _endRelay() { for (const c of this.mq || []) try { c.end(true); } catch { } this.mq = []; this.via = null; this.heard = false; this.mode = null; this.conn = null; }   // host keeps its code: the joiner can retry
  _relayIn(c, s) {
    if (this.closed) return;
    if (!this.via) this.via = c;
    this.heard = true;
    if (!this.open) { this._opened(); this.emit('status', 'relay-open'); }
    const k = s.indexOf('|'), kind = s.slice(0, k), body = s.slice(k + 1);
    if (kind === 'hello') return;
    if (kind === 's') return this._recv(body);
    if (kind[0] === 'c') {   // c<seq>|json  or  c<seq>.<i>/<n>|chunk
      const [sq, part] = kind.slice(1).split('.'), seq = +sq;
      let msg = body;
      if (part) { const [i, n] = part.split('/').map(Number), P = this.parts[seq] ||= new Array(n); P[i] = body; if (P.filter(x => x != null).length < n) return; msg = P.join(''); delete this.parts[seq]; }
      if (seq < this.rxNext || this.rxBuf.has(seq)) return;
      this.rxBuf.set(seq, msg);
      while (this.rxBuf.has(this.rxNext)) { const m = this.rxBuf.get(this.rxNext); this.rxBuf.delete(this.rxNext); this.rxNext++; this._recv(m); }
    }
  }
  _relayCtl(m) {
    const seq = ++this.txSeq;
    if (m.length <= RELAY_CHUNK) return this._pub(`c${seq}|${m}`);
    const n = Math.ceil(m.length / RELAY_CHUNK); for (let i = 0; i < n; i++) this._pub(`c${seq}.${i}/${n}|${m.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK)}`);
  }
  _pub(s) { const c = this.via || this.mq?.find(x => x._smoReady); if (!c) return; try { c.publish(this.myTopic, s, { qos: 0 }); } catch (e) { console.warn(e); } }
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
  _sendCtl(m) { try { this.ctl.send(m); } catch (e) { console.warn(e); } }
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
