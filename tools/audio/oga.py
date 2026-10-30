#!/usr/bin/env python3
"""OpenGameArt.org helper: search sound-effect submissions and parse submission pages.

Usage:
  python3 tools/audio/oga.py search "<keywords>" [--lic cc0,ccby3,ccby4,ccbysa3,ccbysa4,ogaby3,ogaby4]
  python3 tools/audio/oga.py page <content-slug-or-url>        # prints JSON: title, author, licences, files, body

Licence IDs are OGA taxonomy term IDs (see the advanced-search form).
Only permissive licences are offered here (no GPL); GPL must be opted in explicitly.
"""
import html
import json
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://opengameart.org"
LIC = {
    "cc0": "4", "ccby3": "2", "ccby4": "17981", "ccbysa3": "3", "ccbysa4": "17982",
    "ogaby3": "10310", "ogaby4": "31772", "gpl2": "5", "gpl3": "6",
}
DEFAULT_LIC = ["cc0", "ccby3", "ccby4", "ccbysa3", "ccbysa4", "ogaby3", "ogaby4"]


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (audio-import script)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def search(keys, lics=DEFAULT_LIC, per_page=144, page=0):
    q = [("keys", keys), ("field_art_type_tid[]", "13"), ("sort_by", "count"),
         ("sort_order", "DESC"), ("items_per_page", str(per_page)), ("page", str(page))]
    q += [("field_art_licenses_tid[]", LIC[l]) for l in lics]
    s = fetch(BASE + "/art-search-advanced?" + urllib.parse.urlencode(q))
    out = []
    for m in re.finditer(r'<span class="art-preview-title"><a href="/content/([^"]+)">([^<]+)</a>', s):
        if m.group(1) not in [o[0] for o in out]:
            out.append((m.group(1), html.unescape(m.group(2))))
    return out


def _field(s, name):
    m = re.search(r'field-name-%s.*?<div class="field-items">(.*?)</div></div></div>' % name, s, re.S)
    return m.group(1) if m else ""


def text(h):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def page(slug):
    url = slug if slug.startswith("http") else BASE + "/content/" + slug
    s = fetch(url)
    title = text(re.search(r"<h2[^>]*>(.*?)</h2>", re.search(r'<div id="content".*', s, re.S).group(0), re.S).group(1)) \
        if re.search(r'<div id="content"', s) else ""
    m = re.search(r'<title>(.*?)\|', s, re.S)
    if m:
        title = text(m.group(1))
    lic_html = _field(s, "field-art-licenses")
    lics = re.findall(r"<div class='license-name'>([^<]+)</div>", lic_html)
    lic_urls = re.findall(r"<a href='([^']+)'", lic_html)
    author = text(_field(s, "author-submitter"))
    files = []
    for m in re.finditer(r'<a href="(https://opengameart.org/sites/default/files/[^"]+)"[^>]*length=(\d+)', _field(s, "field-art-files")):
        files.append({"url": html.unescape(m.group(1)), "size": int(m.group(2))})
    body = text(_field(s, "body"))
    attrib = text(_field(s, "field-copyright-notice"))
    return {"url": url, "title": title, "author": author, "licenses": lics, "license_urls": lic_urls,
            "files": files, "body": body[:3000], "attribution_notice": attrib}


if __name__ == "__main__":
    if sys.argv[1] == "search":
        lics = DEFAULT_LIC
        if "--lic" in sys.argv:
            lics = sys.argv[sys.argv.index("--lic") + 1].split(",")
        for slug, t in search(sys.argv[2], lics):
            print(slug, "|", t)
    elif sys.argv[1] == "page":
        print(json.dumps(page(sys.argv[2]), indent=1))
