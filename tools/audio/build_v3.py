#!/usr/bin/env python3
"""Audio pass v3: artillery / mortar sounds made from real CC0 recordings. Offline, no downloads.

    nice -n 10 python3 tools/audio/build_v3.py && python3 tools/audio/credits.py

Run after tools/audio/build.py; it merges three events into that build's manifest/credits.  Sources come from the
build.py cache ($AUDIO_CACHE, default /tmp/audio_src) and are all CC0.

  howitzer        2S3 / 2S19 / M777 report: qubodup's close howitzer recordings (FSD50K 67505..67514), a touch
                  pitched down for the 152 mm bore, with a long rolling echo off the terrain (delayed, darkened copies).
  shell_incoming  152/155 mm incoming: a tearing "freight-train" rush, 1.7 s, ending at the burst.  Made from
                  qubodup's rocket-motor recording slowed to half speed, swelling, with ripping turbulence.  No
                  falling whistle.
  mortar_incoming 82/120 mm bomb arrival: a short rising whoosh with fin flutter, 0.9 s, ending at the burst.  From
                  pyranostudios' air whoosh.  The game plays it only some of the time; often a mortar round is not heard
                  at all before it lands.
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


def howitzer():
    shots = [("67505", "howitzer_gun_shot_1.flac"), ("67506", "howitzer_gun_shot_2.flac"), ("67508", "howitzer_gun_shot_3.flac"),
             ("67510", "howitzer_gun_shot_4.flac"), ("67514", "howitzer_gun_shot_6.flac")]
    files = []
    for i, (fid, title) in enumerate(shots, 1):
        x = dsp.load(CACHE / "fsd" / f"{fid}.wav")
        p = [0.86, 0.9, 0.84, 0.88, 0.87][i - 1]
        y = signal.resample(x, int(len(x) / p))           # slightly lower: 152 mm, not 105 mm
        y[-int(0.2 * SR):] *= np.linspace(1, 0, int(0.2 * SR)) ** 2   # the recordings stop dead; the echoes carry on
        n = len(y) + int(3.2 * SR)
        out = np.zeros(n)
        out[: len(y)] += y
        low = dsp.butter(y, "low", 900, order=4)
        for d, g in [(0.35, 0.5), (0.8, 0.38), (1.3, 0.28), (1.9, 0.2), (2.6, 0.12)]:   # rolling echo off tree lines / hills
            k = int((d + rng.uniform(-0.06, 0.06)) * SR)
            ir = dsp.reverb_ir(rt=0.35, lp=1000, seed=int(rng.integers(1e6)), predelay=0)
            seg = signal.fftconvolve(low, ir)[: n - k]       # each echo smeared, not a slap
            seg *= g * np.max(np.abs(low)) / (np.max(np.abs(seg)) + 1e-9)
            out[k:k + len(seg)] += seg
        tail = signal.fftconvolve(low, dsp.reverb_ir(rt=2.4, lp=1200, seed=i, predelay=0.05))[:n]
        out[: len(tail)] += tail * 0.35 * np.max(np.abs(low)) / (np.max(np.abs(tail)) + 1e-9)
        f = int(0.5 * SR)
        out[-f:] *= np.linspace(1, 0, f) ** 2
        files.append(write("weapons", "howitzer", i, dsp.butter(out, "high", 30), [fsd(fid, title)], -15))
    event("howitzer", files, "weapons", 60, 6000, "152/155 mm howitzer report: real howitzer recordings, slightly lowered, + rolling echo")


def shell_incoming():
    x = dsp.load(CACHE / "oga/rocket-launch/launch/launch.wav")
    files = []
    for i in range(1, 5):
        a = rng.uniform(1.9, 3.2)
        seg = x[int(a * SR): int((a + 1.0) * SR)]
        y = signal.resample(seg, int(len(seg) / rng.uniform(0.48, 0.56)))    # half speed: deep rush
        dur = 1.7
        n = int(dur * SR)
        y = y[:n]
        t = T(n)
        u = t / dur
        y = dsp.butter(dsp.butter(y, "high", 100, order=2), "low", rng.uniform(1800, 2400), order=4)
        rip = 1 + 0.55 * np.clip(smooth_noise(n, 35), -1.5, 1.5) + 0.25 * smooth_noise(n, 9)   # tearing turbulence
        y = y * np.clip(rip, 0.1, None)
        y *= (0.03 + u ** 2.4) * (1 - np.exp(-(dur - t) / 0.01))
        files.append(write("explosions", "shell_incoming", i, y, [ROCKET], -14))
    event("shell_incoming", files, "explosions", 40, 900, "152/155 mm incoming: tearing rush, 1.7 s ending at the burst (rocket-motor recording at half speed); no whistle")


def mortar_incoming():
    x = dsp.mono(dsp.load(CACHE / "oga/air-whoosh/whoosh2_0.wav", channels=2))
    files = []
    for i, a in enumerate([0.55, 1.6, 2.65, 3.7], 1):          # the clip is a train of whooshes ~1.05 s apart
        seg = x[int(a * SR): int((a + 0.8) * SR)]
        y = signal.resample(seg, int(len(seg) / rng.uniform(0.82, 0.92)))
        dur = 0.9
        n = int(dur * SR)
        y = np.pad(y, (0, max(0, n - len(y))))[:n]
        t = T(n)
        u = t / dur
        y = dsp.butter(y, "low", 4200)
        y *= 1 + 0.3 * np.sin(2 * np.pi * rng.uniform(13, 19) * t)   # fin flutter
        y *= (0.02 + u ** 2.0) * (1 - np.exp(-(dur - t) / 0.008))
        files.append(write("explosions", "mortar_incoming", i, y, [WHOOSH], -18))
    event("mortar_incoming", files, "explosions", 25, 500, "82/120 mm bomb arrival: short rising whoosh / flutter, 0.9 s ending at the burst; played only some of the time")


def male_voices():
    """Hit / death cries: keep only the low adult-male takes.  The 'slight scream' set (pain_01..15, F0 300-450 Hz),
    pain_23 / pain_25 (~300-350 Hz) and death_04 (a 470-670 Hz tonal 'dying breath') read as shrill / female in game."""
    drop = {f"human/pain_{i:02d}.mp3" for i in list(range(1, 16)) + [23, 25]} | {"human/death_04.mp3"}
    for k in ("pain", "death"):
        MAN[k]["files"] = [f for f in MAN[k]["files"] if f not in drop]
        print(k, len(MAN[k]["files"]), "files kept")


if __name__ == "__main__":
    for fn in (howitzer, shell_incoming, mortar_incoming, male_voices):
        fn()
        print("ok", fn.__name__)
    json.dump(MAN, open(A / "manifest.json", "w"), indent=1, ensure_ascii=False)
    json.dump(CRED, open(A / "credits.json", "w"), indent=1, ensure_ascii=False)
