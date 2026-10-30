#!/usr/bin/env python3
"""Objective "listen-test proxy" for audio files.

  python3 tools/audio/analyze.py stats <files...>             # table of metrics
  python3 tools/audio/analyze.py sheet out.png <files...>     # spectrogram contact sheet (view the PNG)

Metrics: duration, peak dBFS, RMS dBFS (active part), crest, spectral centroid,
low-energy ratio (<250 Hz), spectral flatness (noisiness 0..1), onset count, clipped-sample fraction.
"""
import subprocess
import sys

import numpy as np

SR = 22050


def load(path, sr=SR, mono=True):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ar", str(sr)]
    if mono:
        cmd += ["-ac", "1"]
    cmd += ["-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def db(x):
    return 20 * np.log10(max(float(x), 1e-9))


def stats(path):
    x = load(path)
    n = len(x)
    if n == 0:
        return dict(file=path, dur=0)
    peak = np.max(np.abs(x))
    hop = 512
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(x, (0, 2048)), 2048)[::hop]
    rmsf = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    active = rmsf > (rmsf.max() * 0.05)
    rms_active = np.sqrt(np.mean(rmsf[active] ** 2)) if active.any() else 0
    win = np.hanning(2048)
    spec = np.abs(np.fft.rfft(frames[active] * win, axis=1)) if active.any() else np.zeros((1, 1025))
    freqs = np.fft.rfftfreq(2048, 1 / SR)
    p = spec.sum(axis=0) + 1e-12
    centroid = float((freqs * p).sum() / p.sum())
    low = float(p[freqs < 250].sum() / p.sum())
    flat = float(np.mean(np.exp(np.mean(np.log(spec + 1e-9), axis=1)) / (np.mean(spec, axis=1) + 1e-9)))
    # onsets: rises of > 9 dB in frame energy
    e = 20 * np.log10(rmsf + 1e-9)
    rise = e[2:] - e[:-2]
    on = np.where((rise > 9) & (e[2:] > e.max() - 30))[0]
    onsets = 0
    last = -100
    for i in on:
        if i - last > 3:
            onsets += 1
        last = i
    clipped = float(np.mean(np.abs(x) > 0.999))
    return dict(file=path, dur=n / SR, peak=db(peak), rms=db(rms_active), crest=db(peak) - db(rms_active),
                centroid=centroid, low=low, flat=flat, onsets=onsets, clip=clipped)


def sheet(out, files, cols=4):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    rows = (len(files) + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 4, rows * 2.2), squeeze=False)
    for ax in axes.flat:
        ax.axis("off")
    for ax, f in zip(axes.flat, files):
        x = load(f)
        if len(x) < 1024:
            continue
        ax.specgram(x, NFFT=1024, Fs=SR, noverlap=768, cmap="magma", vmin=-120)
        t = np.arange(len(x)) / SR
        env = np.abs(x)
        ax.plot(t[::64], 8000 + env[::64] * 3000, color="cyan", lw=0.4)
        ax.set_title(f.split("/")[-1][:40] + f" {len(x)/SR:.1f}s", fontsize=7)
        ax.set_ylim(0, 11000)
    plt.tight_layout()
    plt.savefig(out, dpi=60)


if __name__ == "__main__":
    if sys.argv[1] == "stats":
        print(f"{'dur':>6} {'peak':>6} {'rms':>6} {'crest':>5} {'cent':>6} {'low':>5} {'flat':>5} {'ons':>3} {'clip':>6}  file")
        for f in sys.argv[2:]:
            try:
                s = stats(f)
                print(f"{s['dur']:6.2f} {s['peak']:6.1f} {s['rms']:6.1f} {s['crest']:5.1f} {s['centroid']:6.0f} {s['low']:5.2f} {s['flat']:5.2f} {s['onsets']:3d} {s['clip']:6.4f}  {f}")
            except Exception as e:
                print("ERR", f, e)
    elif sys.argv[1] == "sheet":
        sheet(sys.argv[2], sys.argv[3:])
