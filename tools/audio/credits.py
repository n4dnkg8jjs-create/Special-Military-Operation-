#!/usr/bin/env python3
"""Generate docs/AUDIO_CREDITS.md from assets/audio/credits.json (written by build.py)."""
import collections
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
cred = json.load(open(ROOT / "assets/audio/credits.json"))
manifest = json.load(open(ROOT / "assets/audio/manifest.json"))

LIC_NOTE = {
    "CC0": "Public domain dedication - no attribution required (credited anyway).",
    "CC-BY 3.0": "Attribution required. Licence: https://creativecommons.org/licenses/by/3.0/",
    "CC-BY 4.0": "Attribution required. Licence: https://creativecommons.org/licenses/by/4.0/",
    "CC-BY-SA 3.0": "Attribution + ShareAlike (applies to the sound files themselves and modified versions of them, "
                    "not to the game code). Licence: https://creativecommons.org/licenses/by-sa/3.0/",
    "CC-BY-SA 4.0": "Attribution + ShareAlike (applies to the sound files themselves and modified versions of them, "
                    "not to the game code). Licence: https://creativecommons.org/licenses/by-sa/4.0/",
    "OGA-BY 3.0": "Attribution required. Licence: https://static.opengameart.org/OGA-BY-3.0.txt",
}

lines = []
w = lines.append
w("# Audio credits\n")
w("All sounds in `assets/audio/` are derived from openly licensed recordings. **No non-commercial, no-derivatives, "
  "GPL-only or ripped commercial material is used.** Every shipped file was modified: cut/trimmed, mixed to mono "
  "(positional sounds), loudness-normalised, some low-pass/reverb-processed to simulate distance, some pitch-shifted "
  "or layered into composites, then encoded to MP3 by `tools/audio/build.py`. Rebuild with "
  "`nice -n 10 python3 tools/audio/build.py --clean && python3 tools/audio/credits.py`.\n")
w("Sources: OpenGameArt.org submissions (licence as stated on each submission page), Freesound.org clips "
  "obtained through the FSD50K dataset (Fonseca et al., 2021, https://zenodo.org/records/4060432; only clips whose "
  "per-clip licence is CC0 or CC-BY 3.0 were used - CC-BY-NC and Sampling+ clips were excluded), and The Free "
  "Firearm Sound Library (CC0).\n")
w("FSD50K compilation credit (dataset licence CC BY 4.0): E. Fonseca, X. Favory, J. Pons, F. Font, X. Serra, "
  "\"FSD50K: an Open Dataset of Human-Labeled Sound Events\", IEEE/ACM TASLP 30, 2022. Clips retrieved from the "
  "Hugging Face mirror https://huggingface.co/datasets/Fhrozen/FSD50k. The individual Freesound authors and "
  "per-clip licences are listed below.\n")

# licence summary
lic_files = collections.Counter()
for f, v in cred.items():
    for s in v["sources"]:
        lic_files[s["license"]] += 1
w("## Licence summary\n")
w("| Licence | files using it | terms |\n|---|---|---|")
for l, n in lic_files.most_common():
    w(f"| {l} | {n} | {LIC_NOTE.get(l, '')} |")
w("")

# per-source attribution block (deduplicated)
w("## Attribution by source\n")
w("Attribution format: *Title* by Author, licence, URL. (Modified: see note above.)\n")
src = collections.OrderedDict()
for f, v in sorted(cred.items()):
    for s in v["sources"]:
        k = (s["url"], s.get("file", ""))
        src.setdefault(k, dict(s, used_in=[]))["used_in"].append(f)
by_lic = collections.defaultdict(list)
for k, s in src.items():
    by_lic[s["license"]].append(s)
for l in sorted(by_lic, key=lambda x: (x != "CC-BY-SA 3.0" and x != "CC-BY-SA 4.0", x)):
    w(f"### {l}\n")
    for s in sorted(by_lic[l], key=lambda s: (s["author"].lower(), s["title"])):
        extra = f" (file `{s['file']}`)" if s.get("file") else ""
        used = ", ".join(f"`{u}`" for u in sorted(set(s["used_in"])))
        w(f"- *{s['title']}*{extra} by **{s['author']}** - {s['license']} - <{s['url']}> - {s['source']}. "
          f"Used in: {used}")
        if s.get("notice"):
            w(f"  - Author's notice: {s['notice']}")
    w("")

# per-file table
w("## Per-file table\n")
w("| File | Event | Source(s) | Author(s) | Licence(s) |\n|---|---|---|---|---|")
file2key = {f: k for k, e in manifest.items() for f in e["files"]}
for f, v in sorted(cred.items()):
    if f not in file2key:
        continue
    titles = "; ".join(sorted({f"[{s['title']}]({s['url']})" for s in v["sources"]}))
    auth = "; ".join(sorted({s["author"] for s in v["sources"]}))
    lic = "; ".join(sorted({s["license"] for s in v["sources"]}))
    w(f"| `{f}` | {file2key[f]} | {titles} | {auth} | {lic} |")
w("")
w("## Licence texts\n")
w("- CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/legalcode")
w("- CC BY 3.0: https://creativecommons.org/licenses/by/3.0/legalcode")
w("- CC BY 4.0: https://creativecommons.org/licenses/by/4.0/legalcode")
w("- CC BY-SA 3.0: https://creativecommons.org/licenses/by-sa/3.0/legalcode")
w("- CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/legalcode")
w("- OGA-BY 3.0: https://static.opengameart.org/OGA-BY-3.0.txt")
w("")
w("Under CC BY/BY-SA these URIs satisfy the requirement to include the licence or its URI. Files under BY-SA must "
  "stay under BY-SA if redistributed or modified; they are kept as separate files so they do not affect the "
  "licensing of the rest of the game.")
(ROOT / "docs").mkdir(exist_ok=True)
(ROOT / "docs/AUDIO_CREDITS.md").write_text("\n".join(lines) + "\n")
print("wrote docs/AUDIO_CREDITS.md", len(cred), "files,", len(src), "source clips")
