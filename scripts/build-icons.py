#!/usr/bin/env python3
"""
Builds public/fonts/material-symbols{,-fill}.woff2: static subsets of
Material Symbols Rounded (outlined and filled) with only the icons the app
uses, found by scanning src/ for string literals that are icon names.

Run after using a new icon:  npm run icons   (needs: pip install fonttools brotli)
"""
import json, pathlib, re, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

root = pathlib.Path(__file__).resolve().parent.parent
src_font = root / "node_modules/material-symbols/material-symbols-rounded.woff2"
out_font = root / "public/fonts/material-symbols.woff2"
out_list = root / "public/fonts/material-symbols.json"

font = TTFont(src_font)
# Icon names are ligatures ("location_on" → glyph "place"): read them from GSUB.
char_of = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
ligatures: dict[str, str] = {}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for st in lookup.SubTable:
        st = getattr(st, "ExtSubTable", st)
        for first, ligs in getattr(st, "ligatures", {}).items():
            for lig in ligs:
                text = "".join(char_of.get(g, "?") for g in [first, *lig.Component])
                ligatures[text] = lig.LigGlyph
names = set(ligatures)

literals = set()
for f in (root / "src").rglob("*.ts*"):
    literals |= set(re.findall(r"[\"'`]([a-z0-9_]{2,40})[\"'`]", f.read_text()))
    literals |= set(re.findall(r"content:\s*\"([a-z0-9_]+)\"", f.read_text()))
for f in (root / "src").rglob("*.css"):
    literals |= set(re.findall(r"content:\s*\"([a-z0-9_]+)\"", f.read_text()))
icons = sorted(literals & names)

def build(fill: int, out: pathlib.Path):
    f = instancer.instantiateVariableFont(TTFont(src_font), {"FILL": fill, "GRAD": 0, "opsz": 24, "wght": 400})
    cmap = f.getBestCmap()
    keep = {ligatures[i] for i in icons} | {cmap[ord(c)] for c in "abcdefghijklmnopqrstuvwxyz0123456789_" if ord(c) in cmap}
    opts = subset.Options()
    opts.layout_closure = False
    opts.layout_features = ["*"]
    opts.flavor = "woff2"
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    sub = subset.Subsetter(opts)
    sub.populate(glyphs=sorted(keep))
    sub.subset(f)
    f.flavor = "woff2"
    f.save(out)
    print(f"{len(icons)} icons → {out.relative_to(root)} ({out.stat().st_size // 1024} KB)")


build(0, out_font)
build(1, root / "public/fonts/material-symbols-fill.woff2")
out_list.write_text(json.dumps(icons, indent=0))
if "--check" in sys.argv:
    print(" ".join(icons))
