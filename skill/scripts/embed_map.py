#!/usr/bin/env python3
"""Embed (or replace) muloo.json in a PDF.

Usage: embed_map.py in.pdf muloo.json out.pdf
Requires: pymupdf
"""
import json
import sys

import pymupdf as fitz

NAME = "muloo.json"


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    src, map_path, out = sys.argv[1:]
    with open(map_path, "rb") as f:
        data = f.read()
    json.loads(data)  # fail early on invalid JSON
    doc = fitz.open(src)
    if NAME in doc.embfile_names():
        doc.embfile_del(NAME)
    doc.embfile_add(NAME, data, filename=NAME, desc="MuLoo score map")
    doc.save(out, garbage=3, deflate=True)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
