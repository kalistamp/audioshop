"""Photos of pages -> paragraphs, with RapidOCR (PP-OCR models on ONNX Runtime, CPU only).

OCR returns one box per text line fragment. Reading order is rebuilt here: fragments on the same
visual line are joined left to right, lines become paragraphs where the vertical gap opens up, words
broken with a hyphen at a line end are re-joined, and a page with two clear columns is read left
column first.
"""

from __future__ import annotations

import os
import statistics
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

MAX_SIDE = 2600  # larger photos are scaled down: slower, not more accurate
MIN_SCORE = 0.5
# The bundled recognizer is the Chinese PP-OCRv4 model: it reads English but often drops the spaces
# between words. `npm run setup` downloads the English PP-OCRv3 recognizer (Apache-2.0) to here.
EN_REC_MODEL = Path(os.environ.get("AUDIOSHOP_OCR_REC_MODEL",
                                   Path.home() / ".cache" / "audioshop" / "models" / "en_PP-OCRv3_rec_infer.onnx"))


@dataclass
class Line:
    left: float
    right: float
    top: float
    bottom: float
    text: str
    score: float

    @property
    def height(self) -> float:
        return self.bottom - self.top


@lru_cache(maxsize=1)
def _engine():
    from rapidocr_onnxruntime import RapidOCR

    # The per-line 180-degree classifier is off: on clean pages it flipped correct lines and lost
    # them. Upside-down photos are handled per page in ocr_image instead.
    if EN_REC_MODEL.is_file():
        return RapidOCR(rec_model_path=str(EN_REC_MODEL), use_cls=False)
    return RapidOCR(use_cls=False)


def english_model_present() -> bool:
    return EN_REC_MODEL.is_file()


def load_image(path) -> Image.Image:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()  # iPhone photos
    except ImportError:
        pass
    return fit(ImageOps.exif_transpose(Image.open(path)).convert("RGB"))


def fit(img: Image.Image) -> Image.Image:
    scale = MAX_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return img


def ocr_image(img: Image.Image) -> tuple[str, float, bool]:
    """Text of one page, its mean confidence, and whether it was read as two columns."""
    img = fit(img)
    result = _read(img)
    if _mean_score(result) < 0.75:  # maybe upside down: keep whichever reading is more confident
        flipped = _read(img.rotate(180))
        if _mean_score(flipped) > _mean_score(result):
            result = flipped
    fragments = []
    for box, text, score in result:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        if text.strip() and float(score) >= MIN_SCORE:
            fragments.append(Line(min(xs), max(xs), min(ys), max(ys), text.strip(), float(score)))
    if not fragments:
        return "", 0.0, False
    columns = _split_columns(fragments, img.width)
    paragraphs = [p for col in columns for p in _paragraphs(_merge_lines(col))]
    confidence = statistics.fmean(f.score for f in fragments)
    return "\n\n".join(paragraphs), confidence, len(columns) > 1


def _read(img: Image.Image) -> list:
    result, _ = _engine()(np.asarray(img))
    return result or []


def _mean_score(result: list) -> float:
    return statistics.fmean(float(r[2]) for r in result) if result else 0.0


def _split_columns(frags: list[Line], width: int) -> list[list[Line]]:
    """Two columns when the line starts form two groups separated by a wide empty band."""
    mid = width / 2
    left = [f for f in frags if f.right <= mid + width * 0.05]
    right = [f for f in frags if f.left >= mid - width * 0.05]
    spanning = [f for f in frags if f not in left and f not in right]
    if len(left) >= 4 and len(right) >= 4 and len(spanning) <= max(2, 0.1 * len(frags)):
        top = [f for f in spanning if f.bottom <= min(x.top for x in left + right) + 1]  # headline above both
        return [top, left, right] if top else [left, right]
    return [frags]


def _merge_lines(frags: list[Line]) -> list[Line]:
    lines: list[Line] = []
    for f in sorted(frags, key=lambda f: (f.top, f.left)):
        if lines:
            last = lines[-1]
            overlap = min(last.bottom, f.bottom) - max(last.top, f.top)
            if overlap > 0.5 * min(last.height, f.height):
                parts = sorted([last, f], key=lambda x: x.left)
                lines[-1] = Line(parts[0].left, max(last.right, f.right), min(last.top, f.top),
                                 max(last.bottom, f.bottom), f"{parts[0].text} {parts[1].text}",
                                 min(last.score, f.score))
                continue
        lines.append(f)
    return lines


def _paragraphs(lines: list[Line]) -> list[str]:
    if not lines:
        return []
    height = statistics.median(l.height for l in lines)
    left = statistics.median(l.left for l in lines)
    # Line pitch (centre to centre) survives a tilted photo; box heights and gaps do not, because a
    # tilted box grows with the length of its line. A break is a much wider pitch than usual, a gap,
    # an indent, or a change of print size (a headline).
    centre = [(l.top + l.bottom) / 2 for l in lines]
    pitches = [b - a for a, b in zip(centre, centre[1:])]
    # The usual pitch is the lower quartile: on a short page the breaks themselves skew the median.
    pitch = sorted(pitches)[len(pitches) // 4] if len(pitches) >= 3 else None
    paragraphs, current = [], [lines[0].text]
    for i, (prev, line) in enumerate(zip(lines, lines[1:])):
        gap = line.top - prev.bottom
        wide = pitch is not None and pitches[i] > 1.35 * pitch
        indented = line.left - left > 1.5 * height
        if gap > 0.8 * height or wide or indented or abs(line.height - prev.height) > 0.6 * height:
            paragraphs.append(_join(current))
            current = []
        current.append(line.text)
    paragraphs.append(_join(current))
    return [p for p in paragraphs if p]


def _join(lines: list[str]) -> str:
    out = ""
    for line in lines:
        if out.endswith("-") and line[:1].islower():
            out = out[:-1] + line  # re-join a hyphenated word
        else:
            out = f"{out} {line}" if out else line
    return out.strip()
