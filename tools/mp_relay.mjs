// Relay-mode reliability check (no browser): two RoomPeer objects (src/net/peer.js) talking through fake MQTT brokers
// in node that lose messages (QoS 0 under load), delay / reorder them, and drop the client the peers send through for a
// few seconds (a broker kicking a client). The host sends 'ev' batches (10 Hz) and snapshots (5 Hz) as a battle does,
// the joiner orders (1 Hz); both ping every 3 s. Checks: every reliable message arrives once, in order; the longest
// silence each side sees (what versus_ui.js's liveness timeout acts on); snapshots get through.
// OLD=1 disables the acknowledgement / resend / gap skip (the behaviour before mp_v9).
// Usage: node tools/mp_relay.mjs [seconds=60]   env LOSS=0.03 LAT=150 JIT=120
const SECS = +(process.argv[2] || 60), LOSS = +(process.env.LOSS ?? 0.03), LAT = +(process.env.LAT ?? 150), JIT = +(process.env.JIT ?? 120);
globalThis.window = globalThis; globalThis.location = { search: '?mqtt=fake://a,fake://b' };
globalThis.localStorage = { getItem: () => null, setItem() { }, removeItem() { } };
// ---- fake brokers
const subs = new Map();   // topic -> Set(client)
let kicked = 0;
const mkClient = url => {
  const H = {}, c = { url, connected: false, on(e, f) { (H[e] ||= []).push(f); return c; }, emit(e, ...a) { for (const f of H[e] || []) f(...a); },
    subscribe(t, o, cb) { (subs.get(url + t) || subs.set(url + t, new Set()).get(url + t)).add(c); cb?.(null); },
    publish(t, m) { if (!c.connected) return; if (Math.random() < LOSS) return; const set = subs.get(url + t); if (!set) return; for (const d of set) setTimeout(() => { if (d.connected) d.emit('message', t, Buffer.from(m)); }, LAT + Math.random() * JIT); },
    end() { c.connected = false; } };
  setTimeout(() => { c.connected = true; c.emit('connect'); }, 50);
  return c;
};
globalThis.mqtt = { connect: url => mkClient(url) };
const { RoomPeer } = await import('../src/net/peer.js');
if (process.env.OLD) RoomPeer.prototype._relayTick = function () { };
const H = new RoomPeer('host'), G = new RoomPeer('guest'); H.relayKey = G.relayKey = 'TESTKEY';
const R = { host: { ev: [], snaps: 0, gaps: [], last: 0 }, guest: { cmd: [], gaps: [], last: 0 } };
const alive = (who) => { const r = R[who], now = performance.now(); if (r.last) r.gaps.push(now - r.last); r.last = now; };
H.on('*', () => alive('host')); H.on('ping', () => alive('host')); H.on('alive', () => alive('host')); H.on('cmd', d => R.host.cmd = (R.host.cmd || []).concat(d.n));
G.on('*', () => alive('guest')); G.on('ping', () => alive('guest')); G.on('alive', () => alive('guest')); G.on('ev', d => R.guest.cmd.push(d.n)); G.on('snap', d => { R.host.snaps++; (R.age ||= []).push(performance.now() - d.at); });
await Promise.all([H._startRelay(), G._startRelay()]);
await new Promise(r => { const iv = setInterval(() => { if (H.open && G.open) { clearInterval(iv); r(); } }, 50); });
console.log('relay open', H.mode, G.mode, OLDtag());
function OLDtag() { return process.env.OLD ? '(OLD: no acks / resend)' : ''; }
let evN = 0, cmdN = 0, snapN = 0; const t0 = performance.now();
const pad = 'x'.repeat(400);   // (sizes as measured in a battle, tools/mp_net.mjs: event batch ~0.4 KB, snapshot ~4.8 KB)
const big = pad.repeat(180);   // (every 50th batch ~70 KB: relayed in pieces)
const ivE = setInterval(() => { ++evN; H.send('ev', { n: evN, pad: evN % 50 ? pad : big }); }, 100);
const ivS = setInterval(() => { H.sendSnap('snap', { t: ++snapN, at: performance.now(), pad: pad.repeat(12) }); }, 100);
const ivC = setInterval(() => G.send('cmd', { n: ++cmdN }), 1000);
// at 20 s the broker the host sends through kicks it for 6 s
setTimeout(() => { const c = H.via || H.mq[0]; c.connected = false; c._smoReady = false; c.emit('close'); kicked++; setTimeout(() => { c.connected = true; c.emit('connect'); }, 6000); }, 20000);
await new Promise(r => setTimeout(r, SECS * 1000));
clearInterval(ivE); clearInterval(ivS); clearInterval(ivC);
await new Promise(r => setTimeout(r, 4000));
const got = R.guest.cmd, inOrder = got.every((n, i) => i === 0 || n === got[i - 1] + 1), cmds = R.host.cmd || [];
const mx = a => Math.round(Math.max(0, ...a) / 100) / 10;
console.log(`loss ${LOSS * 100}% per hop, ${LAT}+${JIT} ms, one 6 s broker kick of the host's client`);
console.log(`host -> joiner 'ev': sent ${evN}, delivered ${got.length} (${new Set(got).size} distinct), in order ${inOrder}, last ${got[got.length - 1]}`);
console.log(`joiner -> host 'cmd': sent ${cmdN}, delivered ${cmds.length}`);
console.log(`snapshots: sent ${snapN}, delivered ${R.host.snaps} · host resent ${H.stat.resent || 0} · longest silence: host ${mx(R.host.gaps)} s, joiner ${mx(R.guest.gaps)} s`);
const ag = (R.age || []).sort((a, b) => a - b), q = f => Math.round(ag[Math.floor(ag.length * f)] || 0);
console.log(`host sent ${(H.stat.tx / 1024 / SECS).toFixed(1)} KB/s (payload; ${Math.round(H.stat.snapSkip)} snapshots skipped over the ${'48'} KB/s budget) · snapshot age on arrival median ${q(0.5)} ms, p95 ${q(0.95)} ms · ping ${G.rtt} ms`);
const pass = got.length === evN && inOrder && cmds.length === cmdN;
console.log(pass ? 'PASS every reliable message delivered once, in order' : 'FAIL reliable stream incomplete / stalled');
H.close(); G.close(); process.exit(pass ? 0 : 1);
