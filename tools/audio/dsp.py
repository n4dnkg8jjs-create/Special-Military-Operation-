"""Small DSP toolkit used by build.py (numpy/scipy only + ffmpeg for decode/encode)."""
import subprocess

import numpy as np
from scipy import signal

SR = 44100


# ---------------------------------------------------------------- I/O
def load(path, sr=SR, channels=1):
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le",
           "-ar", str(sr), "-ac", str(channels), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    if channels > 1:
        x = x.reshape(-1, channels)
    return x


def encode_mp3(x, path, sr=SR, quality=4):
    """VBR MP3 (LAME -V<quality>). x: (n,) mono or (n,2) stereo float."""
    ch = 1 if x.ndim == 1 else x.shape[1]
    data = np.clip(x, -1, 1).astype(np.float32).tobytes()
    cmd = ["nice", "-n", "10", "ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", str(ch),
           "-i", "-", "-c:a", "libmp3lame", "-q:a", str(quality), "-map_metadata", "-1", str(path)]
    subprocess.run(cmd, input=data, check=True)


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


# ---------------------------------------------------------------- analysis
def env_db(x, hop=220, win=441):
    m = mono(x)
    if len(m) < win:
        m = np.pad(m, (0, win - len(m)))
    fr = np.lib.stride_tricks.sliding_window_view(m, win)[::hop]
    return 10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-12), hop


_KF = None


def k_filter(x, sr=SR):
    """ITU-R BS.1770 K-weighting (pre-filter shelf + RLB high-pass), designed for sr."""
    # coefficients via bilinear transform of the analog prototypes (as in pyloudnorm)
    global _KF
    import pyloudnorm
    if _KF is None:
        _KF = pyloudnorm.Meter(sr)
    y = x.copy()
    for f in _KF._filters.values():
        y = signal.lfilter(f.b, f.a, y, axis=0)
    return y


def loudness_momentary_max(x, sr=SR):
    """Max momentary (400 ms) loudness in LUFS (channel-summed)."""
    y = k_filter(x, sr)
    ms = y ** 2 if y.ndim == 1 else (y ** 2).sum(axis=1)
    w = int(0.4 * sr)
    if len(ms) <= w:
        return -0.691 + 10 * np.log10(ms.mean() + 1e-12)
    c = np.cumsum(np.concatenate([[0], ms]))
    hop = int(0.05 * sr)
    vals = (c[w::hop] - c[:-w:hop][: len(c[w::hop])]) / w
    return -0.691 + 10 * np.log10(vals.max() + 1e-12)


def loudness_integrated(x, sr=SR):
    import pyloudnorm
    meter = pyloudnorm.Meter(sr)
    if len(x) < int(0.5 * sr):
        return loudness_momentary_max(x, sr)
    return meter.integrated_loudness(x)


def peak_db(x):
    return 20 * np.log10(np.max(np.abs(x)) + 1e-12)


# ---------------------------------------------------------------- editing
def fade(x, fin=0.003, fout=0.03, sr=SR):
    x = x.copy()
    n_in, n_out = int(fin * sr), int(fout * sr)
    n_in = min(n_in, len(x) // 4)
    n_out = min(n_out, len(x) // 2)
    shp = (slice(None),) + ((None,) if x.ndim > 1 else ())
    if n_in > 0:
        x[:n_in] *= np.linspace(0, 1, n_in)[shp]
    if n_out > 0:
        x[-n_out:] *= (np.cos(np.linspace(0, np.pi / 2, n_out)) ** 2)[shp]
    return x


def trim(x, start_db=-40, end_db=-55, pre=0.004, sr=SR):
    """Trim leading/trailing silence relative to peak frame level."""
    e, hop = env_db(x)
    pk = e.max()
    on = np.where(e > pk + start_db)[0]
    if len(on) == 0:
        return x[:0]
    s = max(0, on[0] * hop - int(pre * sr))
    tail = np.where(e > pk + end_db)[0]
    t = min(len(x), tail[-1] * hop + 441 + int(0.01 * sr))
    return x[s:t]


def segments(x, thr=-28, min_gap=0.15, tail_db=-50, pre=0.005, maxdur=None, min_dur=0.04, sr=SR):
    """Auto-split a take into separate events. Returns list of (start, end) sample indices."""
    e, hop = env_db(x)
    pk = e.max()
    act = e > pk + thr
    idx = np.where(act)[0]
    if len(idx) == 0:
        return []
    runs = []
    s0 = p = idx[0]
    gap = int(min_gap * sr / hop)
    for i in idx[1:]:
        if i - p > gap:
            runs.append((s0, p))
            s0 = i
        p = i
    runs.append((s0, p))
    out = []
    for k, (a, b) in enumerate(runs):
        nxt = runs[k + 1][0] if k + 1 < len(runs) else len(e)
        epk = e[a:b + 1].max()
        # extend attack backwards a little
        aa = a
        while aa > 0 and a - aa < int(0.03 * sr / hop) and e[aa - 1] > epk - 45:
            aa -= 1
        bb = b
        while bb + 1 < nxt and e[bb + 1] > epk + tail_db:
            bb += 1
        s = max(0, aa * hop - int(pre * sr))
        t = min(len(x), bb * hop + 441)
        if maxdur:
            t = min(t, s + int(maxdur * sr))
        if (t - s) / sr >= min_dur:
            out.append((s, t))
    return out


def resample_factor(x, f):
    """Pitch/speed change by factor f (>1 = higher/faster)."""
    if abs(f - 1) < 1e-6:
        return x
    n = int(round(len(x) / f))
    return signal.resample_poly(x, n, len(x), axis=0) if len(x) < 2_000_000 else signal.resample(x, n, axis=0)


def butter(x, kind, fc, order=2, sr=SR):
    sos = signal.butter(order, fc, btype=kind, fs=sr, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def reverb_ir(rt=1.2, sr=SR, lp=3000, seed=1, predelay=0.02):
    rng = np.random.default_rng(seed)
    n = int(rt * sr)
    t = np.arange(n) / sr
    ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt)
    ir = butter(ir, "low", lp)
    ir = np.concatenate([np.zeros(int(predelay * sr)), ir])
    return ir / np.sqrt((ir ** 2).sum())


def distant(x, fc=2200, rt=1.6, wet=0.45, hp=60, seed=3, sr=SR):
    """Fake distance: air absorption low-pass, softened transient, diffuse tail."""
    m = mono(x)
    dry = butter(m, "low", fc, order=2)
    dry = butter(dry, "low", fc * 1.6, order=2)
    ir = reverb_ir(rt, lp=fc * 0.8, seed=seed, predelay=0.03)
    wetsig = signal.fftconvolve(dry, ir)[: len(dry) + len(ir)]
    out = np.zeros(len(wetsig))
    out[: len(dry)] += dry * (1 - wet)
    out += wetsig * wet * 3.0
    out = butter(out, "high", hp)
    return out


def make_loop(x, start, end, xfade=0.5, sr=SR):
    """Return a seamless periodic loop of length (end-start-xfade) built with an equal-power crossfade."""
    seg = x[int(start * sr): int(end * sr)]
    c = int(xfade * sr)
    L = len(seg) - c
    loop = seg[:L].copy()
    t = np.linspace(0, np.pi / 2, c)
    shp = (slice(None),) + ((None,) if seg.ndim > 1 else ())
    loop[:c] = seg[:c] * np.sin(t)[shp] + seg[L:L + c] * np.cos(t)[shp]
    return loop


def pad_loop(loop, pad=0.25, sr=SR):
    """Pad a periodic loop with its own wrap-around so loop points survive decoder priming offsets.
    Returns (signal, loopStart_s, loopEnd_s)."""
    p = int(pad * sr)
    out = np.concatenate([loop[-p:], loop, loop[:p]], axis=0)
    return out, p / sr, (p + len(loop)) / sr


def normalize(x, target_lufs, mode="momentary", ceiling_db=-1.0, sr=SR):
    lu = loudness_momentary_max(x, sr) if mode == "momentary" else loudness_integrated(x, sr)
    if not np.isfinite(lu):
        return x, 0.0
    g = 10 ** ((target_lufs - lu) / 20)
    pk = np.max(np.abs(x)) + 1e-12
    g = min(g, 10 ** (ceiling_db / 20) / pk)
    return x * g, 20 * np.log10(g)


def soft_limit(x, ceiling_db=-1.0):
    """Gentle tanh limiter used only where we deliberately push loudness (rare)."""
    c = 10 ** (ceiling_db / 20)
    return np.tanh(x / c) * c
