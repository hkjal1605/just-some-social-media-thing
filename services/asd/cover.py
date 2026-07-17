#!/usr/bin/env python3
"""Best-MOMENT cover-frame selector for a short vertical clip.

    python services/asd/cover.py <video> --out <json> --frames-dir <dir> \
        [--fps 2] [--shortlist 6] [--skip-edge 0.5]

Samples frames across the clip, scores each on cheap CV quality metrics
(Laplacian sharpness, exposure, contrast, Hasler-Süsstrunk colorfulness),
applies a local non-max + blur gate to kill motion/transition frames, dedups
near-in-time picks, and writes a SHORTLIST of the strongest candidate frames
(as JPEGs) plus a JSON manifest. A downstream Gemini call picks the single most
*expressive* frame from that shortlist — this stage just guarantees every
candidate is sharp, well-exposed and visually strong (the objective gates CV is
good at; the subjective "which face reads best" is left to the vision model).

Design constraint (mirrors detect.py): never hang; on ANY failure exit non-zero
so the caller falls back to a naive frame grab. Reuses the services/asd venv
(opencv-python + numpy already present); needs no model weights.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys


def log(*a):
    print(*a, file=sys.stderr)


def colorfulness(bgr) -> float:
    """Hasler-Süsstrunk colorfulness metric (higher = more vivid)."""
    b = bgr[:, :, 0].astype("float")
    g = bgr[:, :, 1].astype("float")
    r = bgr[:, :, 2].astype("float")
    rg = r - g
    yb = 0.5 * (r + g) - b
    std = math.sqrt(rg.std() ** 2 + yb.std() ** 2)
    mean = math.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    return std + 0.3 * mean


def exposure_score(b: float) -> float:
    """Plateau at 1.0 for well-exposed mids; falls off toward crushed/blown."""
    if 0.35 <= b <= 0.75:
        return 1.0
    if b < 0.35:
        return max(0.0, (b - 0.10) / 0.25)
    return max(0.0, (0.95 - b) / 0.20)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--fps", type=float, default=2.0, help="candidate sampling rate")
    ap.add_argument("--shortlist", type=int, default=6)
    ap.add_argument("--skip-edge", type=float, default=0.5, help="trim first/last N sec")
    ap.add_argument("--max-samples", type=int, default=300)
    args = ap.parse_args()

    import cv2  # noqa: E402  (heavy import guarded by the top-level try in __main__)

    os.makedirs(args.frames_dir, exist_ok=True)
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        log("cover: cannot open video")
        sys.exit(1)

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if not math.isfinite(src_fps) or src_fps <= 0:
        src_fps = 30.0
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = n_frames / src_fps if n_frames > 0 else 0.0
    step = max(1, int(round(src_fps / max(0.1, args.fps))))

    cands = []  # {idx, t, ms, sharp, bright, contrast, color, file}
    fidx = -1
    while len(cands) < args.max_samples:
        if not cap.grab():  # advance without decoding (cheap for skipped frames)
            break
        fidx += 1
        if fidx % step != 0:
            continue
        t = fidx / src_fps
        if duration and (t < args.skip_edge or t > duration - args.skip_edge):
            continue
        ok, frame = cap.retrieve()
        if not ok or frame is None:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        bright = float(gray.mean()) / 255.0
        contrast = float(gray.std()) / 128.0
        color = colorfulness(frame)
        # write the frame now (one at a time keeps memory flat); prune non-shortlisted later
        fpath = os.path.join(args.frames_dir, f"s_{fidx:06d}.jpg")
        cv2.imwrite(fpath, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        cands.append(
            {
                "idx": fidx,
                "t": t,
                "ms": int(round(t * 1000)),
                "sharp": sharp,
                "bright": bright,
                "contrast": contrast,
                "color": color,
                "file": fpath,
            }
        )
    cap.release()

    if not cands:
        log("cover: no candidate frames")
        sys.exit(1)

    # local non-max on sharpness within 0.5s windows → the sharpest frame of each beat wins,
    # so motion/transition (blurry) frames lose to their still neighbours automatically.
    best_in_win: dict[int, dict] = {}
    for c in cands:
        w = int(c["t"] / 0.5)
        if w not in best_in_win or c["sharp"] > best_in_win[w]["sharp"]:
            best_in_win[w] = c
    kept = list(best_in_win.values())

    # hard blur gate: drop frames well below the clip's peak sharpness (relative → resolution-safe)
    max_sharp = max((c["sharp"] for c in kept), default=1.0) or 1.0
    gated = [c for c in kept if c["sharp"] >= 0.18 * max_sharp]
    kept = gated or kept

    # normalize the two unbounded metrics per-clip, then weighted-sum (no-face cheap recipe)
    def make_norm(vals):
        lo, hi = min(vals), max(vals)
        return (lambda v: (v - lo) / (hi - lo)) if hi > lo else (lambda v: 0.5)

    n_sharp = make_norm([c["sharp"] for c in kept])
    n_color = make_norm([c["color"] for c in kept])
    for c in kept:
        c["score"] = (
            0.35 * n_sharp(c["sharp"])
            + 0.25 * n_color(c["color"])
            + 0.20 * min(1.0, c["contrast"])
            + 0.20 * exposure_score(c["bright"])
        )
    kept.sort(key=lambda c: c["score"], reverse=True)

    # dedup near-in-time picks so the shortlist is temporally diverse
    shortlist: list[dict] = []
    used_t: list[float] = []
    for c in kept:
        if any(abs(c["t"] - ut) < 0.6 for ut in used_t):
            continue
        shortlist.append(c)
        used_t.append(c["t"])
        if len(shortlist) >= args.shortlist:
            break

    # keep only shortlisted frames on disk; rename to stable cand_<i>.jpg
    keep = {c["file"] for c in shortlist}
    for c in cands:
        if c["file"] not in keep and os.path.exists(c["file"]):
            try:
                os.remove(c["file"])
            except OSError:
                pass
    out_cands = []
    for i, c in enumerate(shortlist):
        dst = os.path.join(args.frames_dir, f"cand_{i}.jpg")
        os.replace(c["file"], dst)
        out_cands.append(
            {
                "index": i,
                "ms": c["ms"],
                "t": round(c["t"], 3),
                "file": dst,
                "score": round(c["score"], 4),
                "sharpness": round(c["sharp"], 2),
                "brightness": round(c["bright"], 3),
            }
        )

    result = {
        "ok": True,
        "durationSec": round(duration, 2),
        "sourceFps": round(src_fps, 3),
        "cvBest": out_cands[0],
        "candidates": out_cands,
    }
    with open(args.out, "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # never hang / never traceback-crash the worker
        log("cover: fatal", repr(e))
        sys.exit(1)
