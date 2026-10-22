#!/usr/bin/env python3
"""Detect systems and measures in an engraved score PDF and print a draft
MuLoo map (muloo.json) on stdout. Mirrors js/scores/detect.js in the app.

Usage: detect_layout.py score.pdf [--title T] [--time-sig 4/4] [--tempo 90]
Requires: pymupdf, numpy
"""
import argparse
import json

import pymupdf as fitz
import numpy as np

SCALE = 2.0  # pixels per point
DARK = 128


def staff_lines(dark):
    counts = dark.sum(axis=1)
    thresh = max(dark.shape[1] * 0.25, counts.max() * 0.5)
    rows = np.where(counts >= thresh)[0]
    lines = []
    for y in rows:
        if lines and y - lines[-1][1] <= 1:
            lines[-1][1] = y
        else:
            lines.append([y, y])
    return [(a + b) / 2 for a, b in lines]


def staves(lines):
    out, i = [], 0
    while i < len(lines):
        found = None
        for size in (6, 5):
            g = lines[i:i + size]
            if len(g) < size:
                continue
            gaps = np.diff(g)
            mean = gaps.mean()
            if mean >= 3 and np.all(np.abs(gaps - mean) <= mean * 0.25):
                found = {"top": g[0], "bottom": g[-1], "spacing": mean, "n": size}
                break
        if found:
            out.append(found)
            i += found["n"]
        else:
            i += 1
    return out


def extent(dark, st):
    y = int(round(st["top"]))
    row = dark[max(0, y - 1):y + 2].any(axis=0)
    xs = np.where(row)[0]
    return int(xs.min()), int(xs.max())


def col_dark(dark, x, y0, y1):
    seg = dark[int(round(y0)):int(round(y1)) + 1, x]
    return seg.mean() if len(seg) else 0


def systems(dark, sts):
    out = []
    for st in sts:
        x0, x1 = extent(dark, st)
        prev = out[-1] if out else None
        joined = False
        if prev:
            last = prev["staves"][-1]
            if st["top"] - last["bottom"] < 12 * st["spacing"]:
                for x in range(max(0, min(x0, prev["x0"]) - 2), max(x0, prev["x0"]) + 3):
                    if col_dark(dark, x, last["bottom"], st["top"]) > 0.9:
                        joined = True
                        break
        if joined:
            prev["staves"].append(st)
            prev["x0"], prev["x1"] = min(prev["x0"], x0), max(prev["x1"], x1)
        else:
            out.append({"staves": [st], "x0": x0, "x1": x1})
    return out


def barlines(dark, sys):
    sp = sys["staves"][0]["spacing"]
    xs = [x for x in range(sys["x0"], sys["x1"] + 1)
          if all(col_dark(dark, x, s["top"], s["bottom"]) >= 0.95 for s in sys["staves"])]
    merged = []
    for x in xs:
        if merged and x - merged[-1][1] <= sp:
            merged[-1][1] = x
        else:
            merged.append([x, x])
    return [(a + b) / 2 for a, b in merged]


def detect_page(page):
    pix = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), colorspace=fitz.csGRAY, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    dark = img < DARK
    result = []
    for sys in systems(dark, staves(staff_lines(dark))):
        sp = sys["staves"][0]["spacing"]
        top, bottom = sys["staves"][0]["top"], sys["staves"][-1]["bottom"]
        bars = [x for x in barlines(dark, sys) if x > sys["x0"] + sp]
        edges = [sys["x0"], *bars]
        if not bars or sys["x1"] - bars[-1] > 2 * sp:
            edges.append(sys["x1"])
        measures = [{"x0": round(a / SCALE, 1), "x1": round(b / SCALE, 1)}
                    for a, b in zip(edges, edges[1:]) if b - a > 2 * sp]
        if not measures:
            measures = [{"x0": round(sys["x0"] / SCALE, 1), "x1": round(sys["x1"] / SCALE, 1)}]
        result.append({"y0": round(max(0, top - 3 * sp) / SCALE, 1),
                       "y1": round(min(img.shape[0] - 1, bottom + 3 * sp) / SCALE, 1),
                       "measures": measures})
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--title", default=None)
    ap.add_argument("--time-sig", default="4/4")
    ap.add_argument("--tempo", type=int, default=90)
    args = ap.parse_args()
    doc = fitz.open(args.pdf)
    pages, n = [], 1
    for page in doc:
        systems_ = detect_page(page)
        for s in systems_:
            for m in s["measures"]:
                m["n"] = n
                n += 1
        if systems_:
            pages.append({"page": page.number + 1, "systems": systems_})
    title = args.title or (doc.metadata or {}).get("title") or args.pdf.rsplit("/", 1)[-1].removesuffix(".pdf")
    print(json.dumps({"muloo": 1, "title": title, "timeSig": args.time_sig, "tempo": args.tempo, "pages": pages}, indent=2))


if __name__ == "__main__":
    main()
