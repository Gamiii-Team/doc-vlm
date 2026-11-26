#!/usr/bin/env python3
"""PyMuPDF worker: renders/analyses PDF pages for the full-VLM pipeline.

Commands:
  render-all <pdf> <outdir> [dpi]          -> JSON array of PNG paths (default 150 DPI)
  analyze <pdf>                            -> JSON document analysis (pages, lines, tables, images)
  crop <pdf> <page> <x0> <y0> <x1> <y1> <dpi> <out.png>
  render <pdf> <page> <dpi> <out.png>
  hide-empty-slides <src.pptx> <dst.pptx>  -> hides shape-less slides in a COPY
  pptx-to-pdf <src.pptx> <out.pdf>         -> approximate local render (no-Docker mode)

PyMuPDF 1.24.0 exposes its API as `fitz`; the alias keeps the rest of the code
readable. All machine-readable output goes to stdout as a single JSON value.
"""

import argparse
import io
import json
import os
import re
import sys
import zipfile

try:
    import fitz as pymupdf
except ImportError:  # PyMuPDF >= 1.24.8 also ships the new module name
    import pymupdf

MAX_PAGES = 25
DEFAULT_RENDER_DPI = 150


def load_doc(path):
    return pymupdf.open(path)


# ---------------------------------------------------------------------------
# render-all: the entry point used by the full-VLM pipeline.
# ---------------------------------------------------------------------------
def cmd_render_all(pdf_path, out_dir, dpi=DEFAULT_RENDER_DPI):
    """Render every page to PNG at `dpi` (default 150); print a JSON path array."""
    os.makedirs(out_dir, exist_ok=True)
    doc = load_doc(pdf_path)
    paths = []
    try:
        for i in range(doc.page_count):
            page = doc[i]
            out_path = os.path.join(out_dir, f"page-{i + 1:03d}.png")
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            pix.save(out_path)
            paths.append(out_path)
    finally:
        doc.close()
    sys.stdout.write(json.dumps(paths))
    return paths


# ---------------------------------------------------------------------------
# analyze: text/table/image geometry used for figure crops and native PPTX hints.
# ---------------------------------------------------------------------------
def get_tables(page):
    tables = []
    try:
        raw = list(page.find_tables())
    except Exception:
        return tables
    for t in raw:
        try:
            bbox = getattr(t, "bbox", None)
            if isinstance(bbox, tuple):
                bb = list(bbox)
            else:
                bb = [bbox.x0, bbox.y0, bbox.x1, bbox.y1] if bbox else None
            if not bb:
                continue
            raw_cells = t.extract() or []
            if not raw_cells:
                continue
            n_rows = len(raw_cells)
            n_cols = max((len(r) if r else 0) for r in raw_cells)
            words = page.get_text("words", clip=pymupdf.Rect(*bb)) or []
            if not words:
                cells = [[(c or "").strip() for c in row] for row in raw_cells]
            else:
                rows = []
                buf_y = []
                buf_words = []
                for w in sorted(words, key=lambda w: (float(w[1]), float(w[0]))):
                    y0, y1 = float(w[1]), float(w[3])
                    if not buf_y:
                        buf_y = [y0, y1]
                        buf_words = [w]
                        continue
                    if y0 <= buf_y[1] + 3:
                        buf_y[0] = min(buf_y[0], y0)
                        buf_y[1] = max(buf_y[1], y1)
                        buf_words.append(w)
                        continue
                    rows.append((buf_y[0], buf_y[1], sorted(buf_words, key=lambda w: float(w[0]))))
                    buf_y = [y0, y1]
                    buf_words = [w]
                if buf_words:
                    rows.append((buf_y[0], buf_y[1], sorted(buf_words, key=lambda w: float(w[0]))))

                grid_rows = []
                for (_y0, _y1, ws) in rows:
                    cells_out = []
                    cur = []
                    last_x1 = None
                    for w in ws:
                        x0, x1 = float(w[0]), float(w[2])
                        if last_x1 is not None and x0 - last_x1 > 8.0:
                            cells_out.append(" ".join(t_ for t_ in cur).strip())
                            cur = []
                        cur.append(w[4])
                        last_x1 = x1
                    if cur:
                        cells_out.append(" ".join(t_ for t_ in cur).strip())
                    while len(cells_out) < n_cols:
                        cells_out.append("")
                    grid_rows.append(cells_out[:n_cols])
                cells = grid_rows[:n_rows] if len(grid_rows) >= n_rows else grid_rows
                while len(cells) < n_rows:
                    cells.append([""] * n_cols)
            tables.append({
                "bbox": bb,
                "num_rows": len(cells),
                "num_cols": n_cols,
                "cells": cells,
            })
        except Exception:
            continue
    return tables


def page_info(doc, page_num_1based):
    page = doc[page_num_1based - 1]
    d = page.get_text("dict", sort=True) or {}
    flat_spans = []
    lines = []
    tables = get_tables(page)
    table_bboxes = [t["bbox"] for t in tables if t.get("bbox")]

    def span_in_table(s):
        for tb in table_bboxes:
            sb = s["bbox"]
            if sb[0] < tb[2] and sb[2] > tb[0] and sb[1] < tb[3] and sb[3] > tb[1]:
                return True
        return False

    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            line_bb = line.get("bbox") or [0, 0, 0, 0]
            spans = []
            for span in line.get("spans", []):
                text = span.get("text", "")
                if not text.strip() or span_in_table(span):
                    continue
                spans.append({
                    "text": text,
                    "fontSize": float(span.get("size") or 0),
                    "bold": bool(int(span.get("flags") or 0) & 16),
                    "italic": bool(int(span.get("flags") or 0) & 2),
                    "color": int(span.get("color") or 0),
                    "bbox": list(span.get("bbox")),
                })
            if spans:
                lines.append({
                    "text": "".join(s["text"] for s in spans),
                    "spans": spans,
                    "bbox": list(line_bb),
                })
                flat_spans.extend(spans)

    images = []
    try:
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                for r in page.get_image_rects(xref):
                    images.append({"bbox": [r.x0, r.y0, r.x1, r.y1], "xref": xref})
            except Exception:
                pass
    except Exception:
        pass

    drawings = []
    try:
        for d in page.get_drawings():
            r = d.get("rect")
            if r:
                drawings.append({"bbox": [r.x0, r.y0, r.x1, r.y1]})
    except Exception:
        pass

    text_chars = sum(len(s["text"]) for s in flat_spans)
    try:
        total_text_chars = len(page.get_text("text") or "")
    except Exception:
        total_text_chars = text_chars

    return {
        "page": page_num_1based,
        "width": page.rect.width,
        "height": page.rect.height,
        "text_chars": text_chars,
        "text_chars_total": total_text_chars,
        "image_cover_frac": 0.0,
        "lines": lines,
        "spans": flat_spans,
        "tables": tables,
        "images": images,
        "drawings": drawings,
    }


def page_image_cover(doc, page_num_1based):
    page = doc[page_num_1based - 1]
    total = max(1.0, page.rect.width * page.rect.height)
    area = 0.0
    try:
        for img in page.get_images(full=True):
            try:
                for r in page.get_image_rects(img[0]):
                    area += (r.x1 - r.x0) * (r.y1 - r.y0)
            except Exception:
                pass
    except Exception:
        pass
    return round(area / total, 4)


def cmd_analyze(pdf_path):
    doc = load_doc(pdf_path)
    pages = []
    for i in range(doc.page_count):
        info = page_info(doc, i + 1)
        info["image_cover_frac"] = page_image_cover(doc, i + 1)
        pages.append(info)
    doc.close()
    sys.stdout.write(json.dumps({"num_pages": len(pages), "pages": pages, "max_pages": MAX_PAGES}))


def cmd_crop(pdf_path, page_num, x0, y0, x1, y1, dpi, out_path):
    doc = load_doc(pdf_path)
    try:
        page = doc[page_num - 1]
        pix = page.get_pixmap(dpi=dpi, clip=pymupdf.Rect(x0, y0, x1, y1))
        pix.save(out_path)
    finally:
        doc.close()


def cmd_render(pdf_path, page_num, dpi, out_path):
    doc = load_doc(pdf_path)
    try:
        pix = doc[page_num - 1].get_pixmap(dpi=dpi)
        pix.save(out_path)
    finally:
        doc.close()


def cmd_hide_empty_slides(src_path, dst_path):
    """Mark shape-less slides hidden in a COPY so LibreOffice skips them."""
    slide_re = re.compile(r"^ppt/slides/slide\d+\.xml$", re.IGNORECASE)
    shape_re = re.compile(r"<p:(sp|pic|graphicFrame|grpSp|cxnSp|contentPart)\b")
    hidden_re = re.compile(r"<p:sld\b[^>]*\bshow\s*=\s*[\"']0[\"']", re.IGNORECASE)

    with zipfile.ZipFile(src_path, "r") as zin:
        entries = [(info, zin.read(info.filename)) for info in zin.infolist()]

    hidden_count = 0
    with zipfile.ZipFile(dst_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for info, data in entries:
            if slide_re.match(info.filename):
                text = data.decode("utf-8", errors="ignore")
                if not hidden_re.search(text) and not shape_re.search(text):
                    text = re.sub(r"<p:sld\b", '<p:sld show="0" ', text, count=1)
                    data = text.encode("utf-8")
                    hidden_count += 1
            zout.writestr(info, data)

    print(json.dumps({"ok": True, "hidden": hidden_count}))


def cmd_pptx_to_pdf(src_path, out_path, dpi=150):
    """Approximate PPTX -> PDF without LibreOffice (used by --no-docker mode).

    python-pptx supplies slide geometry/text/images, Pillow draws each slide,
    and PyMuPDF wraps the PNGs into a real PDF so the rest of the pipeline is
    unchanged. This is intentionally best-effort, not a pixel-perfect render.
    """
    from PIL import Image, ImageDraw, ImageFont
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    prs = Presentation(src_path)
    emu_per_px = 914400.0 / float(dpi)
    page_w = max(320, int(round(float(prs.slide_width) / emu_per_px)))
    page_h = max(240, int(round(float(prs.slide_height) / emu_per_px)))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    def px(value):
        return int(round(float(value or 0) / emu_per_px))

    def font(size_pt, bold=False):
        pt = max(8, min(int(size_pt or 18), 96))
        candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
            else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        ]
        for c in candidates:
            try:
                return ImageFont.truetype(c, max(10, int(pt * dpi / 72)))
            except OSError:
                continue
        return ImageFont.load_default()

    def draw_frame(draw, shape, image=None):
        x, y, w, h = px(shape.left), px(shape.top), px(shape.width), px(shape.height)
        if w <= 0 or h <= 0:
            return
        if image is not None:
            image = image.convert("RGB")
            image.thumbnail((w, h))
            paste_x = x + max(0, (w - image.width) // 2)
            paste_y = y + max(0, (h - image.height) // 2)
            canvas.paste(image, (paste_x, paste_y))
            return
        try:
            if shape.fill.type is not None and shape.fill.fore_color.type is not None:
                rgb = shape.fill.fore_color.rgb
                if rgb:
                    draw.rectangle([x, y, x + w, y + h], fill=tuple(rgb))
        except (AttributeError, TypeError, ValueError):
            pass

    pngs = []
    tmp_png_dir = os.path.join(os.path.dirname(os.path.abspath(out_path)), ".pptx-render")
    os.makedirs(tmp_png_dir, exist_ok=True)

    try:
        for index, slide in enumerate(prs.slides):
            canvas = Image.new("RGB", (page_w, page_h), "white")
            draw = ImageDraw.Draw(canvas)

            for shape in slide.shapes:
                image = None
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    try:
                        image = Image.open(io.BytesIO(shape.image.blob))
                    except Exception:
                        image = None
                draw_frame(draw, shape, image)

                if not getattr(shape, "has_text_frame", False):
                    continue
                x, y = px(shape.left), px(shape.top)
                for para in shape.text_frame.paragraphs:
                    text = "".join(run.text for run in para.runs).strip()
                    if not text:
                        continue
                    size = next((r.font.size.pt for r in para.runs if r.font.size), 18)
                    bold = any(bool(r.font.bold) for r in para.runs)
                    draw.text((x + 4, y + 4), text, fill=(20, 20, 20), font=font(size, bold))
                    y += max(18, int(size * dpi / 72) + 6)

            png = os.path.join(tmp_png_dir, f"slide-{index + 1:03d}.png")
            canvas.save(png)
            pngs.append(png)

        doc = pymupdf.open()
        try:
            for png in pngs:
                page = doc.new_page(width=page_w * 72.0 / dpi, height=page_h * 72.0 / dpi)
                page.insert_image(page.rect, filename=png)
            doc.save(out_path, garbage=3, deflate=True)
        finally:
            doc.close()
    finally:
        for png in pngs:
            try:
                os.remove(png)
            except OSError:
                pass
        try:
            os.rmdir(tmp_png_dir)
        except OSError:
            pass

    print(json.dumps({"ok": True, "slides": len(pngs), "approximate": True}))


def main():
    p = argparse.ArgumentParser(description="PyMuPDF worker for full-vlm-parser")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr_all = sub.add_parser("render-all", help="render every page to PNG and print a JSON array of paths")
    pr_all.add_argument("pdf")
    pr_all.add_argument("outdir")
    pr_all.add_argument("dpi", type=int, nargs="?", default=DEFAULT_RENDER_DPI)

    pa = sub.add_parser("analyze")
    pa.add_argument("pdf")

    pc = sub.add_parser("crop")
    pc.add_argument("pdf")
    pc.add_argument("page", type=int)
    pc.add_argument("x0", type=float)
    pc.add_argument("y0", type=float)
    pc.add_argument("x1", type=float)
    pc.add_argument("y1", type=float)
    pc.add_argument("dpi", type=int)
    pc.add_argument("out_path")

    pr = sub.add_parser("render")
    pr.add_argument("pdf")
    pr.add_argument("page", type=int)
    pr.add_argument("dpi", type=int)
    pr.add_argument("out_path")

    ph = sub.add_parser("hide-empty-slides")
    ph.add_argument("src_pptx")
    ph.add_argument("dst_pptx")

    pp = sub.add_parser("pptx-to-pdf", help="approximate local render for --no-docker mode")
    pp.add_argument("src_pptx")
    pp.add_argument("out_pdf")
    pp.add_argument("dpi", type=int, nargs="?", default=DEFAULT_RENDER_DPI)

    ns = p.parse_args()

    if ns.cmd == "render-all":
        cmd_render_all(ns.pdf, ns.outdir, ns.dpi)
    elif ns.cmd == "analyze":
        cmd_analyze(ns.pdf)
    elif ns.cmd == "crop":
        cmd_crop(ns.pdf, ns.page, ns.x0, ns.y0, ns.x1, ns.y1, ns.dpi, ns.out_path)
    elif ns.cmd == "render":
        cmd_render(ns.pdf, ns.page, ns.dpi, ns.out_path)
    elif ns.cmd == "hide-empty-slides":
        cmd_hide_empty_slides(ns.src_pptx, ns.dst_pptx)
    elif ns.cmd == "pptx-to-pdf":
        cmd_pptx_to_pdf(ns.src_pptx, ns.out_pdf, ns.dpi)


if __name__ == "__main__":
    main()
