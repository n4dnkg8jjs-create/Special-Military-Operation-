"""Source resolution + licence metadata for the audio build.

Source specs used in recipes:
  fsd:<freesound id>          clip from FSD50K (HF mirror Fhrozen/FSD50k); licence/author from FSD50K metadata
  oga:<slug>/<path in pack>   file from an OpenGameArt.org submission (downloaded + extracted)
  ffsl:<path>                 The Free Firearm Sound Library (CC0), via OpenGameArt mirror

Everything is cached under $AUDIO_CACHE (default /tmp/audio_src).
"""
import json
import os
import pathlib
import urllib.parse
import urllib.request
import zipfile

CACHE = pathlib.Path(os.environ.get("AUDIO_CACHE", "/tmp/audio_src"))
HF = "https://huggingface.co/datasets/Fhrozen/FSD50k/resolve/main"
HERE = pathlib.Path(__file__).resolve().parent

# Preference when an OGA submission is multi-licensed (never pick GPL).
LIC_PREF = ["CC0", "CC-BY 4.0", "CC-BY 3.0", "OGA-BY 4.0", "OGA-BY 3.0", "CC-BY-SA 4.0", "CC-BY-SA 3.0"]
LIC_URL = {
    "CC0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "CC-BY 3.0": "https://creativecommons.org/licenses/by/3.0/",
    "CC-BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
    "CC-BY-SA 3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
    "CC-BY-SA 4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
    "OGA-BY 3.0": "https://static.opengameart.org/OGA-BY-3.0.txt",
    "OGA-BY 4.0": "https://static.opengameart.org/OGA-BY-4.0.txt",
}


def _get(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (audio-build)"})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
        f.write(r.read())


# ---------------------------------------------------------------- FSD50K
_FSD = None


def fsd_meta():
    global _FSD
    if _FSD is None:
        d = CACHE / "fsd_meta"
        info = {}
        for split in ("dev", "eval"):
            p = d / f"{split}_clips_info_FSD50K.json"
            if not p.exists():
                _get(f"{HF}/metadata/{split}_clips_info_FSD50K.json", p)
            for k, v in json.load(open(p)).items():
                v["split"] = split
                info[k] = v
        _FSD = info
    return _FSD


def fsd_license(url):
    if "zero" in url:
        return "CC0"
    if url.rstrip("/").endswith("/by/3.0"):
        return "CC-BY 3.0"
    raise ValueError("refusing licence " + url)  # by-nc / sampling+ are excluded


# ---------------------------------------------------------------- OGA
_OGA = None


def oga_meta():
    global _OGA
    if _OGA is None:
        p = HERE / "oga_meta.json"
        _OGA = json.load(open(p)) if p.exists() else {}
    return _OGA


def oga_pick_license(lics):
    for l in LIC_PREF:
        if l in lics:
            return l
    raise ValueError("no acceptable licence in %s" % lics)


def ensure_oga(slug):
    d = CACHE / "oga" / slug
    if d.exists() and any(d.iterdir()):
        return d
    meta = oga_meta().get(slug)
    if not meta:
        import oga  # tools/audio/oga.py
        meta = oga.page(slug)
        oga_meta()[slug] = meta
    dl = CACHE / "oga_dl" / slug
    for f in meta["files"]:
        name = urllib.parse.unquote(f["url"].rsplit("/", 1)[1])
        p = dl / name
        if not p.exists():
            _get(f["url"], p)
        d.mkdir(parents=True, exist_ok=True)
        if name.endswith(".zip"):
            zipfile.ZipFile(p).extractall(d)
        elif name.endswith(".7z"):
            import py7zr
            py7zr.SevenZipFile(p).extractall(d)
        else:
            (d / name).write_bytes(p.read_bytes())
    return d


# ---------------------------------------------------------------- resolve
def resolve(spec):
    """Return (local_path, credit dict)."""
    kind, rest = spec.split(":", 1)
    if kind == "fsd":
        v = fsd_meta()[rest]
        p = CACHE / "fsd" / f"{rest}.wav"
        if not p.exists():
            _get(f"{HF}/clips/{v['split']}/{rest}.wav", p)
        lic = fsd_license(v["license"])
        return p, {
            "source": "Freesound (via FSD50K dataset)",
            "title": v["title"], "author": v["uploader"],
            "url": f"https://freesound.org/s/{rest}/",
            "license": lic, "license_url": LIC_URL[lic],
        }
    if kind == "oga":
        slug, rel = rest.split("/", 1)
        d = ensure_oga(slug)
        meta = oga_meta()[slug]
        lic = oga_pick_license(meta["licenses"])
        author = meta["author"].split("(Submitted by")[0].strip()
        return d / rel, {
            "source": "OpenGameArt.org", "title": meta["title"], "author": author,
            "url": meta["url"], "license": lic, "license_url": LIC_URL[lic],
            "file": rel, "notice": meta.get("attribution_notice", ""),
        }
    if kind == "ffsl":
        d = ensure_oga("the-free-firearm-sound-library")
        return d / "Prepared SFX Library" / rest, {
            "source": "The Free Firearm Sound Library (mirrored on OpenGameArt.org)",
            "title": "The Free Firearm Sound Library", "author": "Ben Jaszczak et al.",
            "url": "https://opengameart.org/content/the-free-firearm-sound-library",
            "license": "CC0", "license_url": LIC_URL["CC0"], "file": rest,
        }
    raise ValueError(spec)
