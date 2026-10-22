---
name: muloo-score-map
description: Create a MuLoo score map (muloo.json) for a sheet-music PDF and embed it in the PDF, so the MuLoo practice app can auto-scroll the score measure by measure in playing order. Use when someone asks to prepare, map, or "MuLoo-ify" a score PDF, or wants auto-scroll / playing order for a guitar or ukulele score.
---

# MuLoo score map

MuLoo scrolls a score in time with its metronome. To do that it needs a **score map**: where each row of music (system) and each measure sits on the page, plus the **playing order** (repeats, endings, D.S., Coda). This skill writes that map and embeds it in the PDF as an attachment named `muloo.json`. Other PDF viewers ignore the attachment.

The format is defined by `muloo-map.schema.json` next to this file. Read it before writing a map.

## Steps

1. **Measure the layout.** Run the detector on the PDF:

   ```sh
   python3 scripts/detect_layout.py score.pdf > draft.json
   ```

   It needs PyMuPDF (`pip install pymupdf numpy`). It finds staff lines (groups of 5, or 6 for tab), joins staves connected at the left into one system (e.g. notation plus tab), and finds barlines that cross every staff of a system. Coordinates are PDF points from the top-left of each page. Measures are numbered 1..N in reading order.

2. **Check the draft against the pages.** Render pages to images (e.g. `python3 -c "import pymupdf; d=pymupdf.open('score.pdf'); [p.get_pixmap(dpi=100).save(f'p{p.number+1}.png') for p in d]"`) and look at them. Fix what detection gets wrong:
   - A system split in two (wide gap between notation and tab): merge them into one with the outer `y0`/`y1`.
   - Missed or extra barlines (stems, long slurs, pickup measures): adjust the `measures` of that system. Keep measures contiguous: each `x0` equals the previous `x1`.
   - A pickup (anacrusis) is its own short measure.
   Renumber `n` 1..N in reading order after any change.

3. **Read the navigation and write `order`.** Look for repeat barlines (𝄆 𝄇), 1st/2nd endings (volta brackets), Segno 𝄋, D.S., D.C., "To Coda", Coda 𝄌 and Fine. Write the playing order as measure ranges. Examples:
   - Repeat 1–8 with a 1st ending at 8 and a 2nd ending at 9: `"1-8, 1-7, 9-16"`.
   - D.S. al Coda (Segno at 5, To Coda at 12, D.S. at 16, Coda at 17): `"1-16, 5-12, 17-24"`.
   - D.C. al Fine (Fine at 8, D.C. at 16): `"1-16, 1-8"`.
   After a D.S./D.C. jump, repeats are normally not taken again and the last ending is played. Also record the marks on the measures (`marks`), so the order can be re-edited in MuLoo's map editor.

4. **Set time signature and tempo.** `timeSig` and `tempo` at the top level for the start; add `timeSig` or `tempo` on the measure where they change. In x/8 meters MuLoo clicks every eighth, so a 6/8 tempo is in eighths per minute.

5. **Validate** against `muloo-map.schema.json` (e.g. `python3 -m jsonschema -i muloo.json muloo-map.schema.json`, or check by hand): every `x1 > x0`, `y1 > y0`, and every number in `order` exists.

6. **Embed** the map in the PDF:

   ```sh
   python3 scripts/embed_map.py score.pdf muloo.json "score (MuLoo map).pdf"
   ```

   or with qpdf: `qpdf score.pdf --add-attachment muloo.json --mimetype=application/json -- "score (MuLoo map).pdf"`. Replace any older `muloo.json` attachment rather than adding a second one.

7. **Hand back** the new PDF and a one-line summary: pages, systems, measures and the playing order. The user opens it in MuLoo (Scores → +, or share it to MuLoo); the map is picked up automatically and can be fine-tuned in MuLoo's map editor.

## Notes

- Only engraved PDFs (exported from notation software) detect reliably. For scanned or handwritten scores, write the map by hand from the page images.
- Leave room above and below the staves in `y0`/`y1` (about 3 staff spaces) so notes and chord symbols stay visible when MuLoo zooms to one row.
- Don't guess the order from the measure count alone: read the marks on the page.
