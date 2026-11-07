#!/usr/bin/env python3
"""Audio pass v3: per-round gunshots for automatic weapons + procedural sounds. Offline, no network.

    nice -n 10 python3 tools/audio/build_v3.py && python3 tools/audio/credits.py

Run it after tools/audio/build.py (it reads that build's MP3s and merges into its manifest/credits).

1. Per-round shots.  The game calls sfx() once per ROUND, but mg_near / hmg / cannon30 (+ _far) are multi-shot
   burst recordings, so a 10-round PKM burst stacked ten 2.5 s bursts (about 100 overlapping reports).  Here every
   burst is cut at its onsets into single-shot bodies (onset to next onset), and each body is crossfaded into the
   natural tail of the burst's last shot (level-matched at the joint).  Result: real single reports with a real decay,
   played per round by src/audio/sfx.js with per-emitter choke.  New keys: mg_shot_near/_far, hmg_shot/_far,
   ac_shot/_far (2A42/2A72).  PKM bodies also include the 7.62x54R Mosin single shots (same cartridge).
2. Procedural (project-original, CC0): supersonic crack, close-explosion sub thump, 152 mm incoming (tearing
   rush), mortar whistle, FPV quad buzz loop, ATGM motor loop, track squeal loop, tyre/gravel roll loop, field
   crickets loop, songbird calls, 152 mm howitzer (pitched-down tank-gun recordings + sub + rolling echo).
"""
import json
import pathlib
import sys

import numpy as np
from scipy import signal

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dsp  # noqa: E402

SR = dsp.SR
ROOT = pathlib.Path(__file__).resolve().parents[2]
A = ROOT / "assets/audio"
MAN = json.load(open(A / "manifest.json"))
CRED = json.load(open(A / "credits.json"))
rng = np.random.default_rng(20241107)
PROC = dict(source="Procedurally generated (tools/audio/build_v3.py)", title="SMO procedural sound",
            author="Special Military Operation project", url="https://creativecommons.org/publicdomain/zero/1.0/",
            license="CC0", license_url="https://creativecommons.org/publicdomain/zero/1.0/")


def T(n):
    return np.arange(int(n)) / SR


def bp(x, f, q=2.0):
    sos = signal.butter(2, [max(20, f / (1 + 0.5 / q)), min(SR / 2 - 100, f * (1 + 0.5 / q))], "bandpass", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def lp(x, f, o=2):
    return dsp.butter(x, "low", f, o)


def hp(x, f, o=2):
    return dsp.butter(x, "high", f, o)


def smooth_noise(n, rate, seed=None):
    """band-limited random control signal (~rate Hz), zero mean, unit-ish std"""
    r = np.random.default_rng(seed) if seed is not None else rng
    k = max(4, int(n * rate / SR) + 4)
    pts = r.standard_normal(k)
    return np.interp(np.linspace(0, k - 3, n), np.arange(k), pts)


def periodic(x, xfade=0.4):
    """seamless loop: crossfade the last xfade s into the head (equal power)"""
    return dsp.make_loop(x, 0, len(x) / SR, xfade)


def write(key, i, x, sources, cat="synth", loop=False, target=None, mode="momentary", ceiling=-1.5):
    if target is not None:
        x, _ = dsp.normalize(x, target, mode=mode, ceiling_db=ceiling)
    else:
        x = x * (10 ** (ceiling / 20) / (np.max(np.abs(x)) + 1e-12))
    info = None
    if loop:
        x, ls, le = dsp.pad_loop(x, 0.25)
        info = (round(ls, 5), round(le, 5))
    rel = f"{cat}/{key}_{i:02d}.mp3"
    (A / cat).mkdir(exist_ok=True)
    dsp.encode_mp3(x, A / rel, quality=2)
    srcs, seen = [], set()
    for s in sources:
        k = (s["url"], s.get("file", ""), s.get("author"))
        if k not in seen:
            seen.add(k)
            srcs.append(s)
    CRED[rel] = dict(sources=srcs, dur=round(len(x) / SR, 3), channels=1 if x.ndim == 1 else x.shape[1], processed=True)
    return rel, info


def event(key, files, cat, gain=1.0, ref=10, maxd=900, loop=False, spatial=True, note="", loopinfo=None):
    e = dict(category=cat, gain=gain, loop=loop, spatial=spatial, refDistance=ref, maxDistance=maxd, note=note, files=files)
    if loopinfo:
        e["loopStart"], e["loopEnd"] = loopinfo
    MAN[key] = e


# ============================================================================ 1. per-round shots
def onsets(x, rise=10.0, within=15.0, mins=0.045):
    h = hp(x, 800)
    hop = SR // 1000
    n = len(h) // hop
    L = 10 * np.log10((h[: n * hop].reshape(n, hop) ** 2).mean(1) + 1e-14)
    pk, out, last = L.max(), [], -1e9
    for i in range(16, n - 1):
        if L[i] - L[i - 16:i - 1].mean() > rise and L[i] > pk - within and (i - last) * hop / SR > mins and L[i] >= L[i - 1]:
            out.append(i * hop / SR)
            last = i
    return out


def rms(v):
    return np.sqrt(np.mean(v ** 2) + 1e-14)


LAST = {}


def build_shots(out_key, src_key, extra_whole=(), maxbody=0.42, total=1.3, keep=10, donor_key=None, note="", ref=10, maxd=900, pitch=1.0, far_from=None):
    bodies, donors = [], []
    for rel in MAN[src_key]["files"]:
        x = dsp.load(A / rel)
        o = onsets(x)
        if not o:
            continue
        dur = len(x) / SR
        if dur - o[-1] > 0.45:
            donors.append((x[int(max(0, o[-1] - 0.002) * SR):], CRED[rel]["sources"]))
        for i, t in enumerate(o):
            g = (o[i + 1] - t - 0.004) if i + 1 < len(o) else min(dur - t, maxbody)
            if g < 0.05:
                continue
            a = int(max(0, t - 0.002) * SR)
            b = a + int(min(g, maxbody) * SR)
            body = x[a:b].copy()
            body[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
            # cleanliness: attack peak vs the ring-in under it
            clean = np.max(np.abs(body[: int(0.006 * SR)])) / (rms(x[max(0, a - int(0.01 * SR)):a]) + 1e-6)
            bodies.append((clean, body, CRED[rel]["sources"]))
    if donor_key:
        for rel in MAN[donor_key]["files"]:
            x = dsp.load(A / rel)
            o = onsets(x)
            if o and len(x) / SR - o[-1] > 0.6:
                donors.append((x[int(max(0, o[-1] - 0.002) * SR):], CRED[rel]["sources"]))
    assert donors, out_key
    longd = [dd for dd in donors if len(dd[0]) >= 0.8 * total * SR]
    donors = longd or sorted(donors, key=lambda dd: -len(dd[0]))[:2]
    bodies.sort(key=lambda b: -b[0])
    pool = bodies[: max(keep * 2, 4)]
    idx = rng.choice(len(pool), size=min(keep, len(pool)), replace=False)
    shots = []
    xf = int(0.025 * SR)
    for j, k in enumerate(idx):
        _, body, srcs = pool[k]
        donor, dsrc = donors[j % len(donors)]
        n = len(body)
        if len(donor) <= n + xf:
            donor = np.concatenate([donor, np.zeros(n + xf - len(donor) + 10)])
        w = int(0.02 * SR)
        kk = np.clip(rms(body[n - w:]) / rms(donor[n - w:n]), 0.03, 2.0)
        tail = donor[n - xf:] * kk
        c = np.linspace(0, np.pi / 2, xf)
        y = np.concatenate([body[: n - xf], body[n - xf:] * np.cos(c) + tail[:xf] * np.sin(c), tail[xf:]])
        y = y[: int(total * SR)]
        f = int(0.12 * SR)
        y[-f:] *= np.linspace(1, 0, f) ** 2
        shots.append((y, srcs + dsrc))
    for rel, p in extra_whole:
        x = dsp.load(A / rel)
        if p != 1.0:
            x = dsp.resample(x, p) if hasattr(dsp, "resample") else signal.resample(x, int(len(x) / p))
        shots.append((x[: int(total * SR)], CRED[rel]["sources"]))
    if far_from and len(shots) < 6:   # reverberant far recordings give few clean onsets: add near rounds pushed back
        for y, srcs in far_from[: 8 - len(shots)]:
            shots.append((dsp.distant(y, fc=1700, rt=1.8, wet=0.5)[: int(total * SR)], srcs))
    files = []
    for i, (y, srcs) in enumerate(shots, 1):
        if out_key.endswith("_far"):   # far bodies were often brighter than their donor tails: one consistent distance colour
            y = lp(y, 3800)
        if pitch != 1.0:
            y = signal.resample(y, int(len(y) / pitch))
        files.append(write(out_key, i, y, srcs, cat="weapons", target=-16)[0])
    event(out_key, files, "weapons", 1.0, ref, maxd, note=note)
    LAST[out_key] = shots
    print(out_key, len(files), "shots from", len(bodies), "bodies,", len(donors), "donors")


def shots():
    build_shots("mg_shot_near", "mg_near", note="PKM/PKT single round (cut from 7.62 MG bursts + Mosin 7.62x54R singles); per-round",
                extra_whole=[("weapons/dmr_near_01.mp3", 1.0), ("weapons/dmr_near_03.mp3", 1.03)], maxbody=0.3, total=1.2, keep=10)
    build_shots("mg_shot_far", "mg_far", note="7.62 MG round heard from 150 m+", maxbody=0.3, total=1.6, keep=8, ref=40, maxd=2000)
    build_shots("hmg_shot", "hmg", note="KPVT 14.5 / Kord 12.7 single round (cut from .50 cal bursts); per-round",
                maxbody=0.32, total=1.6, keep=10, ref=14)
    build_shots("hmg_shot_far", "hmg_far", note="heavy MG round heard from 150 m+", maxbody=0.32, total=2.0, keep=8, ref=50, maxd=2500, far_from=LAST["hmg_shot"])
    build_shots("ac_shot", "cannon30", donor_key="cannon30", note="2A42/2A72 30 mm single round (cut from 25/30 mm bursts); per-round",
                maxbody=0.42, total=2.0, keep=10, ref=16, maxd=1200)
    build_shots("ac_shot_far", "cannon30_far", note="30 mm round heard from 150 m+", maxbody=0.42, total=2.4, keep=8, ref=60, maxd=3000, far_from=LAST["ac_shot"])


# ============================================================================ 2. procedural
def crack():
    """Supersonic N-wave: instantaneous rise, linear fall through zero, instantaneous return (0.25-0.5 ms),
    a ground reflection, then the short bright 'snap' of the surroundings."""
    files = []
    for i in range(1, 6):
        n = int(0.35 * SR)
        y = np.zeros(n)
        Tn = rng.uniform(0.00022, 0.00045)
        m = max(3, int(Tn * SR * 4))           # built at 4x and decimated: keeps the edges sharp but band-limited
        nw = np.zeros(int(0.004 * SR * 4))
        nw[10:10 + m] = np.linspace(1, -1, m)
        nw = signal.resample_poly(nw, 1, 4)
        y[:len(nw)] += nw
        d = int(rng.uniform(0.0012, 0.004) * SR)
        y[d:d + len(nw)] += nw * rng.uniform(0.45, 0.7)
        t = T(n)
        snap = bp(rng.standard_normal(n), rng.uniform(2600, 4200), 1.2) * np.exp(-t / rng.uniform(0.012, 0.025)) * 0.35
        slap = np.zeros(n)
        for _ in range(4):                      # a few reflections off ground / walls
            k = int(rng.uniform(0.008, 0.06) * SR)
            slap[k:k + len(nw)] += nw * rng.uniform(0.08, 0.2) * rng.choice([-1, 1])
        y = y + snap + lp(slap, 6000)
        y = hp(y, 350)
        files.append(write("bullet_crack", i, y, [PROC], target=-14)[0])
    event("bullet_crack", files, "ballistics", 1.0, 6, 60, note="supersonic round passing close (N-wave + snap); procedural")


def sub_thump():
    files = []
    for i in range(1, 5):
        n = int(1.4 * SR)
        t = T(n)
        f0, f1 = rng.uniform(55, 75), rng.uniform(26, 34)
        f = f1 + (f0 - f1) * np.exp(-t / 0.09)
        ph = 2 * np.pi * np.cumsum(f) / SR
        env = (1 - np.exp(-t / 0.003)) * np.exp(-t / rng.uniform(0.28, 0.4))
        y = np.sin(ph) * env
        y += lp(rng.standard_normal(n), 140, 4) * np.exp(-t / 0.18) * 0.9
        y = np.tanh(y * 1.6) / np.tanh(1.6)
        y = lp(y, 220, 4)
        f2 = int(0.2 * SR)
        y[-f2:] *= np.linspace(1, 0, f2)
        files.append(write("sub_thump", i, y, [PROC], ceiling=-1.5)[0])
    event("sub_thump", files, "explosions", 1.0, 25, 400, note="close-blast low-frequency pressure thump (layered under near explosions); procedural")


def shell_incoming():
    """152 mm incoming: a rising tearing rush (band noise sweeping down + turbulence) that ends at impact."""
    files = []
    for i in range(1, 5):
        dur = 2.45
        n = int(dur * SR)
        t = T(n)
        u = t / dur
        y = np.zeros(n)
        noise = rng.standard_normal(n)
        blk = 256
        fc0, fc1 = rng.uniform(1500, 1900), rng.uniform(520, 700)
        zi = None
        out = np.zeros(n)
        for s in range(0, n, blk):                 # time-varying band-pass (block-wise, state kept)
            uu = (s + blk / 2) / n
            fc = fc0 * (fc1 / fc0) ** (uu ** 1.4)
            b, a = signal.iirpeak(fc, 2.2, fs=SR)
            if zi is None:
                zi = signal.lfilter_zi(b, a) * 0
            out[s:s + blk], zi = signal.lfilter(b, a, noise[s:s + blk], zi=zi)
        turb = 1 + 0.35 * smooth_noise(n, 28) + 0.2 * smooth_noise(n, 7)
        y += out * turb
        rumble = lp(rng.standard_normal(n), 260, 4) * (u ** 3) * 2.2
        y += rumble
        tone_f = rng.uniform(780, 900) * (1 - 0.18 * u) * (1 + 0.004 * np.sin(2 * np.pi * 5.5 * t))
        y += np.sin(2 * np.pi * np.cumsum(tone_f) / SR) * 0.12 * (0.3 + u)
        env = (0.02 + u ** 2.6) * (1 - np.exp(-(dur - t) / 0.012))
        y *= env
        y = hp(y, 80)
        files.append(write("shell_incoming", i, y, [PROC], cat="explosions", ceiling=-2)[0])
    event("shell_incoming", files, "explosions", 1.0, 40, 900,
          note="152/155 mm shell incoming, 2.45 s ending at impact (play 2.3-2.6 s before the burst); procedural")


def mortar_whistle():
    files = []
    for i in range(1, 5):
        dur = 1.45
        n = int(dur * SR)
        t = T(n)
        u = t / dur
        f = rng.uniform(1500, 1750) * (1 - rng.uniform(0.3, 0.38) * u ** 1.2) * (1 + 0.006 * np.sin(2 * np.pi * 6.3 * t))
        ph = 2 * np.pi * np.cumsum(f) / SR
        tone = np.sin(ph) + 0.25 * np.sin(2 * ph + 0.3)
        nb = np.zeros(n)
        noise = rng.standard_normal(n)
        zi, blk = None, 256
        for s in range(0, n, blk):
            b, a = signal.iirpeak(f[min(n - 1, s + blk // 2)], 9, fs=SR)
            if zi is None:
                zi = signal.lfilter_zi(b, a) * 0
            nb[s:s + blk], zi = signal.lfilter(b, a, noise[s:s + blk], zi=zi)
        y = tone * 0.35 + nb * 1.4 + bp(noise, 900, 0.8) * 0.15 * u
        y *= (0.04 + u ** 2.2) * (1 - np.exp(-(dur - t) / 0.01)) * (1 + 0.15 * smooth_noise(n, 12))
        files.append(write("incoming_whistle", i, hp(y, 300), [PROC], cat="explosions", ceiling=-2)[0])
    event("incoming_whistle", files, "explosions", 1.0, 30, 700,
          note="82/120 mm mortar bomb whistle, 1.45 s ending at impact (play ~1.4 s before); procedural")


def drone_buzz():
    """7-inch FPV quad: four motors with two-blade props, slightly detuned (blade-pass ~ 300-330 Hz) -> beating;
    harmonic-rich blade-pass + motor whine + prop-wash hiss. 2 s periodic loop (all rates are multiples of 0.5 Hz)."""
    dur = 2.0
    n = int(dur * SR)
    t = T(n)
    y = np.zeros(n)
    for f, a, phs in [(312.0, 1, 0.1), (316.5, 0.9, 1.3), (309.5, 0.85, 2.2), (321.0, 0.8, 0.7)]:
        fm = f * (1 + 0.006 * np.sin(2 * np.pi * 1.0 * t + phs) + 0.003 * np.sin(2 * np.pi * 2.5 * t))
        ph = 2 * np.pi * np.cumsum(fm) / SR + phs
        for h in range(1, 16):
            y += a * np.sin(h * ph + h * phs) / (h ** 0.9) * (1.3 if h in (2, 3) else 1)
        y += a * 0.06 * np.sin(14 * ph * 0.5 * 2 + 0.5)   # motor magnetic whine (~4.4 kHz)
    y = np.tanh(y * 0.035) * 1.0
    wash = hp(rng.standard_normal(n), 1500) * (0.6 + 0.4 * np.sin(2 * np.pi * 312.0 * t) ** 2) * 0.05
    y = y + lp(wash, 7000)
    y = lp(y, 9000)
    rel, info = write("drone_buzz", 1, np.concatenate([y, y[: int(0.0 * SR)]]), [PROC], loop=True, target=-18, mode="integrated", ceiling=-3)
    event("drone_buzz", [rel], "weapons", 1.0, 16, 600, loop=True, loopinfo=info, note="FPV quad motors (loop; playbackRate = throttle); procedural")


def atgm_motor():
    dur = 3.0
    n = int(dur * SR)
    t = T(n)
    noise = rng.standard_normal(n)
    roar = lp(noise, 2600, 2) * (1 + 0.45 * smooth_noise(n, 40))
    hiss = hp(noise, 3000) * 0.25 * (1 + 0.3 * smooth_noise(n, 90))
    crackle = np.zeros(n)
    pos = rng.integers(0, n - 200, 260)
    for p in pos:
        crackle[p:p + 60] += rng.standard_normal(60) * np.exp(-np.arange(60) / 12) * rng.uniform(0.5, 1.6)
    low = lp(noise, 180, 4) * 1.6
    y = roar + hiss + hp(crackle, 600) * 0.5 + low
    y = periodic(y, 0.6)
    rel, info = write("atgm_motor", 1, y, [PROC], loop=True, target=-18, mode="integrated", ceiling=-3)
    event("atgm_motor", [rel], "weapons", 1.0, 14, 800, loop=True, loopinfo=info, note="ATGM / rocket sustainer motor roar (loop); procedural")


def track_squeal():
    """Tracked running gear: sliding steel resonances that swell and fade irregularly + idler/sprocket grind."""
    dur = 6.0
    n = int(dur * SR)
    t = T(n)
    y = np.zeros(n)
    noise = rng.standard_normal(n)
    for f, q, a in [(1850, 40, 1.0), (2630, 55, 0.8), (3420, 60, 0.55), (1270, 30, 0.5), (4700, 70, 0.3)]:
        drift = f * (1 + 0.025 * smooth_noise(n, 0.8))
        env = np.clip(smooth_noise(n, 1.6) - 0.3, 0, None) ** 1.5
        tone = np.sin(2 * np.pi * np.cumsum(drift) / SR + rng.uniform(0, 6))
        y += (tone * 0.5 + bp(noise, f, q / 4) * 3) * env * a
    grind = bp(noise, 900, 1.0) * (0.5 + 0.5 * np.clip(smooth_noise(n, 5), -1, 1)) * 0.5
    y = y + grind
    y = periodic(y, 0.8)
    rel, info = write("track_squeal", 1, y, [PROC], loop=True, target=-22, mode="integrated", ceiling=-3)
    event("track_squeal", [rel], "vehicles", 1.0, 10, 500, loop=True, loopinfo=info, note="track / road-wheel squeal & grind (loop, layered on track_clank); procedural")


def tyre_roll():
    dur = 6.0
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    rumble = lp(noise, 220, 4) * 2.5 * (1 + 0.3 * smooth_noise(n, 3))
    roar = bp(noise, 700, 0.9) * 0.5 * (1 + 0.2 * smooth_noise(n, 2))
    grit = np.zeros(n)
    for p in rng.integers(0, n - 100, 900):
        grit[p:p + 40] += rng.standard_normal(40) * np.exp(-np.arange(40) / 6) * rng.uniform(0.2, 1)
    y = rumble + roar + hp(grit, 2500) * 0.35
    y = periodic(y, 0.8)
    rel, info = write("tyre_roll", 1, y, [PROC], loop=True, target=-22, mode="integrated", ceiling=-3)
    event("tyre_roll", [rel], "vehicles", 1.0, 10, 500, loop=True, loopinfo=info, note="big off-road tyres on broken asphalt / gravel (loop, layered under wheeled drive); procedural")


def crickets():
    dur = 12.0
    n = int(dur * SR)
    t = T(n)
    out = np.zeros((n, 2))
    for c in range(9):
        fc = rng.uniform(4100, 5200)
        rate = rng.uniform(0.55, 1.4)          # chirps per second
        syl, sylp = rng.integers(2, 5), rng.uniform(0.026, 0.038)
        dist = rng.uniform(0.15, 1.0)
        pan = rng.uniform(-0.9, 0.9)
        y = np.zeros(n)
        tt = rng.uniform(0, 1 / rate)
        while tt < dur - 0.3:
            for s in range(syl):
                a = int((tt + s * sylp) * SR)
                L = int(0.016 * SR)
                if a + L >= n:
                    break
                k = np.arange(L) / SR
                y[a:a + L] += np.sin(2 * np.pi * fc * k + rng.uniform(0, 6)) * np.sin(np.pi * k / 0.016) ** 2
            tt += 1 / rate * rng.uniform(0.85, 1.15)
        y = lp(y, 4000 + 3000 * dist) * dist
        out[:, 0] += y * np.sqrt((1 - pan) / 2)
        out[:, 1] += y * np.sqrt((1 + pan) / 2)
    out = dsp.make_loop(out, 0, dur, 1.0)
    rel, info = write("crickets", 1, out, [PROC], cat="ambience", loop=True, target=-30, mode="integrated", ceiling=-6)
    event("crickets", [rel], "ambience", 1.0, 10, 600, loop=True, spatial=False, loopinfo=info, note="field crickets bed (quiet moments, rural); procedural")


def birds():
    files = []
    for i in range(1, 9):
        n = int(rng.uniform(0.9, 1.8) * SR)
        y = np.zeros(n)
        tt = 0.02
        kind = i % 3
        while tt < n / SR - 0.2:
            L = rng.uniform(0.03, 0.12) if kind else rng.uniform(0.012, 0.03)
            m = int(L * SR)
            k = np.arange(m) / SR
            f0 = rng.uniform(2500, 4800)
            sweep = rng.uniform(-0.45, 0.6)
            f = f0 * (1 + sweep * k / L) * (1 + (0.04 if kind == 2 else 0.01) * np.sin(2 * np.pi * rng.uniform(25, 60) * k))
            ph = 2 * np.pi * np.cumsum(f) / SR
            env = np.sin(np.pi * k / L) ** 1.5
            a = int(tt * SR)
            y[a:a + m] += (np.sin(ph) + 0.15 * np.sin(2 * ph)) * env * rng.uniform(0.5, 1)
            tt += L + (rng.uniform(0.02, 0.09) if kind else rng.uniform(0.008, 0.02))
            if rng.random() < 0.12:
                tt += rng.uniform(0.15, 0.3)
        y = lp(hp(y, 1800), 9000)
        files.append(write("bird", i, y, [PROC], cat="ambience", target=-24)[0])
    event("bird", files, "ambience", 1.0, 20, 300, note="songbird calls (quiet moments); procedural")


def howitzer():
    """2S3/2S19/M777 report: tank-gun recordings pitched down ~0.72 (bigger bore, longer blast), sub-thump, rolling
    echoes off the terrain."""
    files = []
    srcs = MAN["tankgun"]["files"]
    for i, rel in enumerate(srcs, 1):
        x = dsp.load(A / rel)
        p = [0.7, 0.74, 0.68, 0.72][(i - 1) % 4]
        y = signal.resample(x, int(len(x) / p))
        n = len(y) + int(2.5 * SR)
        out = np.zeros(n)
        out[: len(y)] += y
        t = T(n)
        f = 26 + 40 * np.exp(-t / 0.08)
        sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * (1 - np.exp(-t / 0.004)) * np.exp(-t / 0.45)
        out += sub * 0.8
        lowy = lp(y, 900)
        for d, g in [(0.42, 0.32), (0.95, 0.22), (1.6, 0.14), (2.2, 0.08)]:   # rolling echo
            k = int((d + rng.uniform(-0.05, 0.05)) * SR)
            seg = lowy[: n - k]
            out[k:k + len(seg)] += seg * g
        f2 = int(0.4 * SR)
        out[-f2:] *= np.linspace(1, 0, f2)
        files.append(write("howitzer", i, hp(out, 25), CRED[rel]["sources"], cat="weapons", target=-15)[0])
    event("howitzer", files, "weapons", 1.0, 60, 6000, note="152/155 mm howitzer report (tank-gun recordings pitched down + sub + echo)")


if __name__ == "__main__":
    only = sys.argv[1].split(",") if len(sys.argv) > 1 else None
    for fn in (shots, crack, sub_thump, shell_incoming, mortar_whistle, drone_buzz, atgm_motor, track_squeal, tyre_roll, crickets, birds, howitzer):
        if only and fn.__name__ not in only:
            continue
        fn()
        print("ok", fn.__name__)
    json.dump(MAN, open(A / "manifest.json", "w"), indent=1, ensure_ascii=False)
    json.dump(CRED, open(A / "credits.json", "w"), indent=1, ensure_ascii=False)
