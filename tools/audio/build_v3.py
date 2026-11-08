#!/usr/bin/env python3
"""Audio pass v3: artillery / mortar sounds built from real CC0 / CC-BY recordings (download cache of build.py). No downloads.

    nice -n 10 python3 tools/audio/build_v3.py && python3 tools/audio/credits.py

Run after tools/audio/build.py; it rewrites / adds these events in that build's manifest + credits (idempotent: it
reads the raw cache, $AUDIO_CACHE default /tmp/audio_src, and the untouched build.py files).

  howitzer        152/155 mm at the gun: qubodup's "Artillery Gunfire" / "Cannon Shot" reports (instant crack + boom,
                  natural multi-second decay), low end reinforced, crack accentuated, rolling terrain echo extended.
  artillery_far   the same guns 2-10 km off: low-passed to a dull thud, rounded onset, delayed swelling rumble
                  (+ qubodup's "Distant Tank Shots").
  shell_impact    152/155 mm burst: shock-front crack (first 70 ms of the fastest real blasts / gun reports) + a real
                  blast body picked for a near-instant rise and a 1-2 s decay + recorded debris rain + rolling echo.
  mortar_impact   82/120 mm burst: sharper, smaller, shorter version of the same (incl. real M224 impact recordings).
  shell_incoming  last 1.3 s of a shell's flight: a fast-rising tearing hiss / rip (no tone, no long whoosh) from real
                  air-turbulence and rocket-crackle recordings; the game plays it only for some rounds.
  mortar_incoming the same, 0.7 s, for mortar bombs (played even less often).
  mortar_launch   hollow tube "thunk" + pop reshaped from the M224 / range recordings.
  male_voices     drops the high-pitched pain / death takes from the manifest (male soldiers only).
"""
import json
import os
import pathlib
import sys

import numpy as np
from scipy import signal

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dsp  # noqa: E402

SR = dsp.SR
ROOT = pathlib.Path(__file__).resolve().parents[2]
A = ROOT / "assets/audio"
CACHE = pathlib.Path(os.environ.get("AUDIO_CACHE", "/tmp/audio_src"))
MAN = json.load(open(A / "manifest.json"))
CRED = json.load(open(A / "credits.json"))
rng = np.random.default_rng(20241108)
CC0 = dict(license="CC0", license_url="https://creativecommons.org/publicdomain/zero/1.0/")


def fsd(i, title):
    return dict(source="Freesound (via FSD50K dataset)", title=title, author="qubodup", url=f"https://freesound.org/s/{i}/", **CC0)


ROCKET = dict(source="OpenGameArt.org", title="Rocket launch", author="qubodup", url="https://opengameart.org/content/rocket-launch", file="launch/launch.wav", notice="", **CC0)
WHOOSH = dict(source="OpenGameArt.org", title="Air whoosh", author="pyranostudios", url="https://opengameart.org/content/air-whoosh", file="whoosh2_0.wav", notice="", **CC0)


def T(n):
    return np.arange(int(n)) / SR


def smooth_noise(n, rate):
    k = max(4, int(n * rate / SR) + 4)
    return np.interp(np.linspace(0, k - 3, n), np.arange(k), rng.standard_normal(k))


def write(cat, key, i, x, sources, target):
    x, _ = dsp.normalize(x, target, mode="momentary", ceiling_db=-1.5)
    rel = f"{cat}/{key}_{i:02d}.mp3"
    dsp.encode_mp3(x, A / rel, quality=2)
    CRED[rel] = dict(sources=sources, dur=round(len(x) / SR, 3), channels=1, processed=True)
    return rel


def event(key, files, cat, ref, maxd, note):
    MAN[key] = dict(category=cat, gain=1.0, loop=False, spatial=True, refDistance=ref, maxDistance=maxd, note=note, files=files)


def rolling_echo(y, n, g, lp=600, t_peak=0.5, tau=1.4, seed=0):
    """terrain echo as heard in footage: a continuous rumble that swells after the report (t_peak) and rolls away
    (tau) - the report convolved with a darkened noise response, scaled to g x the report's peak"""
    r = np.random.default_rng(seed)
    t = T(n)
    ir = r.standard_normal(n) * (1 - np.exp(-t / t_peak)) * np.exp(-t / tau)
    ir = dsp.butter(ir, "low", lp, order=2)
    low = dsp.butter(y, "low", lp * 1.5, order=2)
    out = signal.fftconvolve(low, ir)[:n]
    return out * g * np.max(np.abs(y)) / (np.max(np.abs(out)) + 1e-9)


def fade_end(x, sec):
    f = min(len(x), int(sec * SR))
    x = x.copy()
    x[-f:] *= np.linspace(1, 0, f) ** 2
    return x


ART = "Artillery Gunfire"
# real gun reports with an instant attack and a natural multi-second decay: [fsd id, title, start s, end s]
GUN = [("239137", ART, 0.0, 3.06), ("239137", ART, 3.07, 5.09), ("239137", ART, 5.10, 6.9),
       ("187767", "Cannon Shot", 0.14, 6.3), ("187767", "Cannon Shot", 6.37, 12.3)]
DIST = [("184275", "Distant Tank Shots.flac", 0.0, 5.9), ("184275", "Distant Tank Shots.flac", 6.03, 8.95),
        ("184275", "Distant Tank Shots.flac", 9.0, 11.95), ("184275", "Distant Tank Shots.flac", 11.99, 18.0)]


def gun_slice(fid, a, b):
    x = dsp.load(CACHE / "fsd" / f"{fid}.wav")
    y = x[int(a * SR): int(b * SR)].copy()
    y[: int(0.001 * SR)] *= np.linspace(0, 1, int(0.001 * SR))
    return fade_end(y, 0.25)


def howitzer():
    """outgoing 152/155 mm heard at the battery: hard crack + chest-thump boom (instant attack), then seconds of
    rolling echo.  Real gun recordings (instant rise, long natural decay), lowered a little for the bore, the low end
    reinforced from the recording itself, and the echo extended where a recording was cut by the next shot."""
    files = []
    for i, (fid, title, a, b) in enumerate(GUN, 1):
        y = gun_slice(fid, a, b)
        p = [0.9, 0.86, 0.88, 0.92, 0.9][i - 1]
        y = signal.resample(y, int(len(y) / p))
        y = y + dsp.butter(y, "low", 160, order=4) * 0.6                 # chest thump from its own low end
        c = y[: int(0.06 * SR)] * np.exp(-np.arange(int(0.06 * SR)) / (0.008 * SR))
        y[: len(c)] += dsp.butter(c, "high", 1200, order=2) * 1.5          # the hard muzzle crack on top
        n = max(len(y), int(4.8 * SR))
        out = np.zeros(n)
        out[: len(y)] += y
        out += rolling_echo(y[: int(0.5 * SR)], n, 0.3, lp=600, t_peak=0.5, tau=1.4, seed=i)
        files.append(write("weapons", "howitzer", i, fade_end(dsp.butter(out, "high", 28), 0.6), [fsd(fid, title)], -13))
    event("howitzer", files, "weapons", 60, 9000, "152/155 mm howitzer at the gun: real gun reports (instant crack + boom) with long rolling echo")


def artillery_far():
    """the same guns 2-10 km off: low dull thud (everything above ~500 Hz gone, onset rounded) and a delayed rumble"""
    files = []
    srcs = [(fid, t, a, b) for fid, t, a, b in DIST] + GUN[:3:2] + GUN[3:4]
    for i, (fid, title, a, b) in enumerate(srcs, 1):
        y = gun_slice(fid, a, b)[: int(3.5 * SR)]
        y = signal.resample(y, int(len(y) / 0.85))
        y = dsp.butter(dsp.butter(y, "low", rng.uniform(380, 520), order=4), "high", 25)
        y = signal.fftconvolve(y, np.hanning(int(0.02 * SR)))[: len(y)]          # rounded onset
        n = len(y) + int(2.5 * SR)
        out = np.zeros(n)
        out[: len(y)] += y
        out += rolling_echo(y[: int(0.6 * SR)], n, 0.6, lp=300, t_peak=0.8, tau=1.6, seed=10 + i)
        files.append(write("weapons", "artillery_far", i, fade_end(out, 0.8), [fsd(fid, title)], -16))
    MAN["artillery_far"]["files"] = files
    MAN["artillery_far"]["note"] = "distant artillery (2-10 km): real gun reports, low-passed to a dull thud + delayed rumble"


def crack_pool():
    """the sharp first ~50 ms (shock front) of the fastest-rising real blast / gun recordings"""
    pool = []
    for rel, at in [("explosions/explosion_large_05.mp3", None), ("explosions/explosion_large_01.mp3", None),
                    ("explosions/explosion_medium_01.mp3", None), ("explosions/explosion_small_04.mp3", None),
                    ("explosions/explosion_small_05.mp3", None), ("explosions/explosion_medium_04.mp3", None)]:
        x = dsp.load(A / rel)
        o = int(np.argmax(np.abs(x) > np.max(np.abs(x)) * 0.3))
        seg = x[max(0, o - int(0.001 * SR)): o + int(0.07 * SR)].copy()
        seg *= np.exp(-np.arange(len(seg)) / (0.012 * SR))
        seg = dsp.butter(seg, "high", 700, order=2)
        pool.append((seg / (np.max(np.abs(seg)) + 1e-9), CRED[rel]["sources"]))
    for fid, title, a, b in GUN[:3]:
        y = gun_slice(fid, a, a + 0.1)
        seg = y[: int(0.07 * SR)] * np.exp(-np.arange(int(0.07 * SR)) / (0.010 * SR))
        seg = dsp.butter(seg, "high", 700, order=2)
        pool.append((seg / (np.max(np.abs(seg)) + 1e-9), [fsd(fid, title)]))
    return pool


def impacts():
    """shell / bomb bursts, layered from real recordings: shock-front crack + blast body + debris/dirt + echo tail.
    shell_impact (152/155 mm): big body, long low tail.  mortar_impact (82/120 mm): sharper, smaller, shorter."""
    cracks = crack_pool()
    debris = [f for f in MAN["debris"]["files"]]
    for key, bodies, total, crack_g, tail_g, target in [
        # bodies picked for a near-instant rise and a decay of ~1-2 s (a burst, not a sustained fireball roar)
        ("shell_impact", [("explosion_large_05", 0.92), ("explosion_medium_04", 0.9), ("explosion_medium_01", 0.82),
                          ("explosion_small_09", 0.8), ("explosion_small_04", 0.78), ("explosion_small_08", 0.8)], 4.5, 0.9, 0.3, -12),
        ("mortar_impact", [("explosion_medium_07", 1.0), ("explosion_small_04", 1.0), ("explosion_small_05", 0.95),
                           ("explosion_small_08", 1.0), ("explosion_small_09", 1.0), ("explosion_small_10", 1.0)], 2.6, 1.1, 0.15, -14)]:
        files = []
        for i, (b, pitch) in enumerate(bodies, 1):
            rel = f"explosions/{b}.mp3"
            x = dsp.load(A / rel)
            o = int(np.argmax(np.abs(x) > np.max(np.abs(x)) * 0.3))
            body = x[max(0, o - int(0.003 * SR)):][: int(total * SR)]
            if pitch != 1.0:
                body = signal.resample(body, int(len(body) / pitch))          # < 1: a bigger charge
            body = fade_end(body[: int(total * SR)], 0.4)
            n = int(total * SR)
            out = np.zeros(n)
            out[: len(body)] += body[:n]
            c, csrc = cracks[(i * 3 + (key == "mortar_impact")) % len(cracks)]
            out[int(0.002 * SR): int(0.002 * SR) + len(c)] += c[: n] * crack_g * np.max(np.abs(body[: int(0.05 * SR)]))
            dr = debris[(i * 5) % len(debris)]
            d = dsp.load(A / dr)[: int(1.6 * SR)]
            k = int(rng.uniform(0.25, 0.45) * SR)
            out[k:k + len(d)] += d[: n - k] * 0.35 * np.max(np.abs(body)) / (np.max(np.abs(d)) + 1e-9)
            out += rolling_echo(body[: int(0.4 * SR)], n, tail_g, lp=500, t_peak=0.35 if key == 'shell_impact' else 0.25, tau=1.2 if key == 'shell_impact' else 0.7, seed=20 + i)
            srcs = CRED[rel]["sources"] + csrc + CRED[dr]["sources"]
            files.append(write("explosions", key, i, fade_end(dsp.butter(out, "high", 25), 0.5), srcs, target))
        event(key, files, "explosions", 20 if key == "shell_impact" else 16, 6000,
              "152/155 mm HE burst: crack + body + debris + echo (real recordings)" if key == "shell_impact" else
              "82/120 mm mortar burst: sharper/smaller crack + body + debris (real recordings)")


def incoming(key, dur, tau, n_var, note):
    """the last moments of a shell's flight as heard in footage: no tone, a fast-rising tearing hiss / rip.
    Real air-turbulence (whoosh) and rocket-motor crackle recordings, an exponential swell, ripping modulation."""
    w = dsp.mono(dsp.load(CACHE / "oga/air-whoosh/whoosh2_0.wav", channels=2))
    r = dsp.load(CACHE / "oga/rocket-launch/launch/launch.wav")
    files = []
    for i in range(1, n_var + 1):
        n = int(dur * SR)
        a = rng.uniform(2.0, 4.6)
        roar = dsp.butter(r[int(a * SR): int(a * SR) + n], "high", 500, order=2)
        b = rng.uniform(0.3, 4.0)
        hiss = w[int(b * SR): int(b * SR) + n]
        hiss = np.pad(hiss, (0, n - len(hiss)))
        hiss = dsp.butter(hiss, "high", 900, order=2)
        y = roar * 0.6 + hiss / (np.max(np.abs(hiss)) + 1e-9) * np.max(np.abs(roar)) * 0.8
        t = T(n)
        rip = np.clip(1 + 0.6 * smooth_noise(n, 45), 0.05, None)
        y = y * rip * np.exp((t - dur) / tau) * (1 - np.exp(-(dur - t) / 0.006))
        files.append(write("explosions", key, i, y, [ROCKET, WHOOSH], -14))
    event(key, files, "explosions", 30 if key == "shell_incoming" else 20, 700, note)


def shell_incoming():
    incoming("shell_incoming", 1.3, 0.22, 4, "152/155 mm incoming, last 1.3 s: fast-rising tearing hiss/rip ending at the burst (no whistle); played only for some rounds")


def mortar_incoming():
    incoming("mortar_incoming", 0.7, 0.13, 4, "mortar bomb arrival, last 0.7 s: short rising rip/flutter ending at the burst; played only for some rounds")


def mortar_launch():
    """82/120 mm launch: a hollow 'thoonk' (tube resonance, low-mid, ~150 ms) with a short pop on top and a little
    echo.  The M224 / range recordings are reshaped: their 110-650 Hz band with a fast decay is the body, their first
    20 ms above 1.5 kHz is the pop (the raw camcorder takes were a long bright hiss)."""
    files, srcs = [], []
    for fid, title, author, lic in [("426161", "M224 Mortar Firing Close 03", "Nanashi", "by"), ("426162", "M224 Mortar Firing Close 02", "Nanashi", "by"),
                                    ("161970", "Firing Mortar at Shooting Range", "qubodup", "zero")]:
        x = dsp.load(CACHE / "fsd" / f"{fid}.wav")
        o = int(np.argmax(np.abs(x) > np.max(np.abs(x)) * 0.3))
        y = x[max(0, o - int(0.002 * SR)):][: int(1.2 * SR)]
        src = dict(source="Freesound (via FSD50K dataset)", title=title, author=author, url=f"https://freesound.org/s/{fid}/",
                   license="CC-BY 3.0" if lic == "by" else "CC0",
                   license_url="https://creativecommons.org/licenses/by/3.0/" if lic == "by" else "https://creativecommons.org/publicdomain/zero/1.0/")
        for v, (lo, hi, tau, p) in enumerate([(110, 650, 0.14, 1.0), (90, 520, 0.18, 0.9)]):
            t = T(len(y))
            body = dsp.butter(dsp.butter(y, "high", lo, order=2), "low", hi, order=4) * np.exp(-t / tau)
            pop = dsp.butter(y, "high", 1500, order=2) * np.exp(-t / 0.012) * 0.6
            z = body / (np.max(np.abs(body)) + 1e-9) + pop / (np.max(np.abs(body)) + 1e-9)
            if p != 1.0:
                z = signal.resample(z, int(len(z) / p))
            n = len(z) + int(0.6 * SR)
            out = np.zeros(n)
            out[: len(z)] += z
            out += rolling_echo(z[: int(0.3 * SR)], n, 0.12, lp=900, t_peak=0.12, tau=0.45, seed=len(files) + 40)
            files.append(write("weapons", "mortar_launch", len(files) + 1, fade_end(out, 0.3), [src], -16))
    MAN["mortar_launch"]["files"] = files
    MAN["mortar_launch"]["note"] = "82/120 mm mortar launch: hollow tube 'thunk' + pop (reshaped M224 / range recordings)"


def male_voices():
    """Hit / death cries: keep only the low adult-male takes.  The 'slight scream' set (pain_01..15, F0 300-450 Hz),
    pain_23 / pain_25 (~300-350 Hz) and death_04 (a 470-670 Hz tonal 'dying breath') read as shrill / female in game."""
    drop = {f"human/pain_{i:02d}.mp3" for i in list(range(1, 16)) + [23, 25]} | {"human/death_04.mp3"}
    for k in ("pain", "death"):
        MAN[k]["files"] = [f for f in MAN[k]["files"] if f not in drop]
        print(k, len(MAN[k]["files"]), "files kept")


if __name__ == "__main__":
    for fn in (howitzer, artillery_far, impacts, shell_incoming, mortar_incoming, mortar_launch, male_voices):
        fn()
        print("ok", fn.__name__)
    json.dump(MAN, open(A / "manifest.json", "w"), indent=1, ensure_ascii=False)
    json.dump(CRED, open(A / "credits.json", "w"), indent=1, ensure_ascii=False)
