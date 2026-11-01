// Peer-to-peer link for the versus campaign: WebRTC data channels with MANUAL signalling — no game server.
// The host makes an invite code, the joiner pastes it and gets a reply code, the host pastes that back. Works on a
// LAN without internet (host candidates) and over the internet via public STUN (most home routers; strict
// symmetric NATs may need both players on the same network).
// Two channels: 'ctl' (reliable, ordered: lobby, campaign state, commands, events) and 'snap' (unreliable,
// unordered: battle snapshots).

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

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

export class Peer {
  constructor(role) {
    this.role = role; this.handlers = {}; this.open = false; this.queue = [];
    this.pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc.addEventListener('connectionstatechange', () => { const s = this.pc.connectionState; if (s === 'failed' || s === 'disconnected' || s === 'closed') this.emit('close', s); });
    if (role === 'host') { this.setup(this.pc.createDataChannel('ctl', { ordered: true }), 'ctl'); this.setup(this.pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 }), 'snap'); }
    else this.pc.addEventListener('datachannel', e => this.setup(e.channel, e.channel.label));
  }
  setup(ch, name) {
    this[name] = ch; ch.binaryType = 'arraybuffer';
    ch.onopen = () => { if (this.ctl?.readyState === 'open' && this.snap?.readyState === 'open' && !this.open) { this.open = true; for (const m of this.queue) this.ctl.send(m); this.queue = []; this.emit('open'); } };
    ch.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } this.emit(m.t, m.d, m); this.emit('*', m); };
    ch.onclose = () => this.emit('close', name);
  }
  // host: invite code
  async invite() { const o = await this.pc.createOffer(); await this.pc.setLocalDescription(o); await gathered(this.pc); return pack({ v: 1, sdp: this.pc.localDescription }); }
  // joiner: paste invite, get reply code
  async join(code) { const { sdp } = await unpack(code); await this.pc.setRemoteDescription(sdp); const a = await this.pc.createAnswer(); await this.pc.setLocalDescription(a); await gathered(this.pc); return pack({ v: 1, sdp: this.pc.localDescription }); }
  // host: paste reply
  async accept(code) { const { sdp } = await unpack(code); await this.pc.setRemoteDescription(sdp); }
  on(t, f) { (this.handlers[t] ||= []).push(f); return this; }
  off(t, f) { this.handlers[t] = (this.handlers[t] || []).filter(x => x !== f); }
  emit(t, ...a) { for (const f of this.handlers[t] || []) try { f(...a); } catch (e) { console.error(e); } }
  send(t, d) { const m = JSON.stringify({ t, d }); if (this.open) { try { this.ctl.send(m); } catch (e) { console.warn(e); } } else this.queue.push(m); }
  sendSnap(t, d) { if (!this.open || this.snap.readyState !== 'open') return; const m = JSON.stringify({ t, d }); if (this.snap.bufferedAmount > 256 * 1024) return; try { this.snap.send(m); } catch {} }
  close() { try { this.pc.close(); } catch {} }
}

// the link survives page reloads only inside one page; the versus mode therefore runs campaign screen and battles
// in the same page (no reloads), see versus.js
export const net = { peer: null };
