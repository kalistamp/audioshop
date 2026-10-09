"""python -m audioshop_extract JOB_DIR

Reads JOB_DIR/job.json, writes JOB_DIR/text.txt (the body to be read aloud) and JOB_DIR/extract.json
(title, word count, kind, pages, warnings). On failure exits with status 2 after printing
`AUDIOSHOP_ERROR: <message for the user>` as the last line on stderr.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from audioshop_extract import netguard
from audioshop_extract.readers import (
    IMAGE_EXTS,
    Document,
    ExtractError,
    drop_leading_title,
    read_file,
    read_images,
    read_text,
    read_url,
    tidy,
)


def extract(job: dict, job_dir: Path) -> Document:
    source = job["source"]
    kind = source["type"]
    if kind == "url":
        return read_url(source["url"])
    if kind == "text":
        doc = read_text(source["text"].encode("utf-8"), "pasted.txt")
        doc.kind = "pasted text"
        return doc
    if kind == "files":
        files = [(job_dir / f["path"], f["name"]) for f in source["files"]]
        if not files:
            raise ExtractError("No files arrived with that request.")
        if all(Path(name).suffix.lower() in IMAGE_EXTS for _, name in files):
            return read_images([p for p, _ in files])  # several photos = pages of one article
        if len(files) > 1:
            parts = [read_file(p, n) for p, n in files]
            doc = Document(parts[0].title, tidy("\n\n".join(d.text for d in parts)), "documents",
                           sum(d.pages for d in parts), [w for d in parts for w in d.warnings])
            return doc
        return read_file(*files[0])
    raise ExtractError(f"Unknown source type {kind!r}.")


def fallback_title(job: dict, body: str) -> str:
    """A label for a source with no title of its own: the document's file name, otherwise its
    opening words. It names the recording in the library but is never read aloud."""
    files = job["source"].get("files") or []
    if files and Path(files[0]["name"]).suffix.lower() not in IMAGE_EXTS:
        return Path(files[0]["name"]).stem
    first = body.strip().split("\n", 1)[0]
    sentence = re.split(r"(?<=[.!?])\s", first, maxsplit=1)[0].rstrip(".")
    if len(sentence) <= 60:
        return sentence or "Untitled"
    return sentence[:60].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def main() -> int:
    job_dir = Path(sys.argv[1])
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    try:
        doc = extract(job, job_dir)
    except (ExtractError, netguard.FetchError) as exc:
        print(f"AUDIOSHOP_ERROR: {exc}", file=sys.stderr)
        return 2
    title = (job.get("title") or "").strip() or doc.title
    found = bool(title)  # a real title is announced before the article; a fallback label is not
    body = drop_leading_title(doc.text, title) if found else doc.text
    if not found:
        title = fallback_title(job, body)
    if not body.strip():
        print("AUDIOSHOP_ERROR: No text to read was found.", file=sys.stderr)
        return 2
    (job_dir / "text.txt").write_text(body + "\n", encoding="utf-8")
    meta = {"title": title[:200], "titleFound": found, "words": len(body.split()), "chars": len(body), "kind": doc.kind,
            "pages": doc.pages, "warnings": doc.warnings[:6], "preview": body[:280]}
    (job_dir / "extract.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
