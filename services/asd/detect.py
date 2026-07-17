#!/usr/bin/env python3
"""Active-speaker reframing CLI.

    python services/asd/detect.py <video_path> --out <output.json> [--start S] [--end E] [--fps 5]

Given a landscape talking-head/podcast video, figures out where the active
speaker's face is over time and writes a JSON track so a downstream ffmpeg
step can crop a 9:16 window that follows/switches to whoever is talking.
See services/asd/README.md for the full contract and setup instructions.

Design constraint that shapes this entire file: NEVER crash, NEVER emit an
empty track. Detection runs through a tiered fallback chain — Light-ASD
(audio-visual active speaker detection) -> face-only (largest/most-central
face, no audio) -> center-fallback (fixed center point) — and every tier
above the last is allowed to fail for any reason (missing weights, missing
torch, no face found, corrupt video, ...). Even the imports below are
individually guarded: this script must still produce a valid center-fallback
JSON in a completely bare Python environment with none of requirements.txt
installed, as long as the ffmpeg/ffprobe binaries are reachable (and even
without those, via hardcoded defaults).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Pure-stdlib; always safe to import.
from asd_engine.schema import (  # noqa: E402
    DetectResult,
    METHOD_CENTER_FALLBACK,
    METHOD_FACE_ONLY,
    METHOD_LIGHT_ASD,
    RawSample,
    TrackSample,
)

# Everything past this point needs opencv-python (and, transitively, the heavier
# stack for Light-ASD). Guard each import individually so a missing dependency
# only disables that tier instead of taking the whole CLI down.
try:
    from asd_engine.sampling import (  # noqa: E402
        VideoInfo,
        iter_sample_frames,
        make_sample_schedule,
        probe_video,
    )
    from asd_engine.smoothing import build_track  # noqa: E402

    _SAMPLING_AVAILABLE = True
    _SAMPLING_IMPORT_ERROR: Optional[BaseException] = None
except Exception as _err:  # pragma: no cover - exercised only in a bare env
    _SAMPLING_AVAILABLE = False
    _SAMPLING_IMPORT_ERROR = _err

try:
    from asd_engine.face_fallback import TieredFaceDetector, pick_best_face  # noqa: E402

    _FACE_FALLBACK_AVAILABLE = True
    _FACE_FALLBACK_IMPORT_ERROR: Optional[BaseException] = None
except Exception as _err:  # pragma: no cover
    _FACE_FALLBACK_AVAILABLE = False
    _FACE_FALLBACK_IMPORT_ERROR = _err

_LIGHT_ASD_IMPORT_ERROR: Optional[BaseException] = None
try:
    from asd_engine.light_asd_pipeline import LightAsdUnavailable, run_light_asd  # noqa: E402

    _LIGHT_ASD_IMPORTABLE = True
except Exception as _err:  # pragma: no cover

    class LightAsdUnavailable(Exception):  # type: ignore[no-redef]
        pass

    _LIGHT_ASD_IMPORTABLE = False
    _LIGHT_ASD_IMPORT_ERROR = _err


DEFAULT_SOURCE_W = 1920
DEFAULT_SOURCE_H = 1080
DEFAULT_DURATION_SEC = 10.0


def log(msg: str, verbose: bool = True) -> None:
    if verbose:
        sys.stderr.write(f"[asd-detect] {msg}\n")
        sys.stderr.flush()


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Active-speaker reframing: emit a smoothed face-center track.")
    p.add_argument("video_path", help="path to the source landscape video")
    p.add_argument("--out", required=True, help="path to write the output JSON track")
    p.add_argument("--start", type=float, default=0.0, help="analysis window start, seconds (default: 0)")
    p.add_argument("--end", type=float, default=None, help="analysis window end, seconds (default: full duration)")
    p.add_argument("--fps", type=float, default=5.0, help="output samples per second (default: 5)")
    # Additive knobs beyond the calling contract -- useful for ops/debugging, never required.
    p.add_argument(
        "--device", default="auto", choices=["auto", "cpu", "cuda", "mps"],
        help="torch device for the Light-ASD path (default: auto-detect)",
    )
    p.add_argument(
        "--analysis-fps", type=int, default=25,
        help="internal frame rate Light-ASD analyzes at (default: 25, matches the pretrained weights)",
    )
    p.add_argument(
        "--force-method", default=None, choices=["light-asd", "face-only", "center-fallback"],
        help="skip the fallback chain and force one tier (debugging/testing only)",
    )
    p.add_argument(
        "--weights-dir", default=None,
        help="override the weights/ directory (default: services/asd/weights next to this script)",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="log tier/progress info to stderr")
    return p.parse_args(argv)


def default_weights_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights")


def _stdlib_probe_dimensions(video_path: str):
    """ffprobe-only probe (stdlib subprocess + json, no cv2/numpy) -- the very last
    resort for real dimensions when opencv-python itself isn't installed."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate",
                "-show_entries", "format=duration",
                "-of", "json", video_path,
            ],
            capture_output=True, text=True, timeout=20,
        )
        data = json.loads(result.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        w = int(stream.get("width") or 0)
        h = int(stream.get("height") or 0)
        rate = str(stream.get("r_frame_rate") or "25/1")
        num, _, den = rate.partition("/")
        fps = (float(num) / float(den)) if den and float(den) != 0 else float(num or 25.0)
        duration = float((data.get("format") or {}).get("duration") or 0.0)
        if w > 0 and h > 0:
            return w, h, (fps or 25.0), duration
    except Exception:
        pass
    return None


def _fallback_schedule(start: float, end: float, fps: float) -> List[float]:
    """Dependency-free reimplementation of make_sample_schedule's trivial math,
    used only when asd_engine.sampling (which needs cv2) failed to import."""
    if fps <= 0:
        fps = 5.0
    span = max(0.0, end - start)
    n = int(span * fps + 1e-6)
    if n < 1:
        n = 1
    return [start + i / fps for i in range(n)]


def try_light_asd(args, video_info, start: float, end: float, verbose: bool) -> Optional[List[RawSample]]:
    if not _LIGHT_ASD_IMPORTABLE:
        log(f"light-asd: module unavailable ({_LIGHT_ASD_IMPORT_ERROR})", verbose)
        return None
    try:
        samples = run_light_asd(
            video_path=args.video_path,
            start=start,
            end=end,
            out_fps=args.fps,
            analysis_fps=args.analysis_fps,
            device=args.device,
            weights_dir=args.weights_dir or default_weights_dir(),
            video_info=video_info,
            log=lambda m: log(f"light-asd: {m}", verbose),
        )
        if samples and any(s.cx is not None for s in samples):
            return samples
        log("light-asd: produced no usable samples", verbose)
        return None
    except LightAsdUnavailable as err:
        log(f"light-asd unavailable: {err}", verbose)
        return None
    except Exception as err:  # defensive: a bug in the heavy path must not crash the CLI
        log(f"light-asd failed unexpectedly: {err!r}", verbose)
        return None


def try_face_only(args, video_info, start: float, end: float, verbose: bool) -> Optional[List[RawSample]]:
    if not (_SAMPLING_AVAILABLE and _FACE_FALLBACK_AVAILABLE):
        log(
            f"face-only: unavailable (sampling_ok={_SAMPLING_AVAILABLE}, face_ok={_FACE_FALLBACK_AVAILABLE})",
            verbose,
        )
        return None
    detector = None
    try:
        detector = TieredFaceDetector(log=lambda m: log(f"face-only: {m}", verbose))
        log(f"face-only: using backend '{detector.backend_name}'", verbose)
        samples: List[RawSample] = []
        for t, frame in iter_sample_frames(args.video_path, start, end, args.fps, video_info):
            h, w = frame.shape[:2]
            faces = detector.detect(frame)
            best = pick_best_face(faces, w, h)
            if best is None:
                samples.append(RawSample(t=t, cx=None, cy=None))
            else:
                cx = ((best.x1 + best.x2) / 2.0) / w
                cy = ((best.y1 + best.y2) / 2.0) / h
                samples.append(RawSample(t=t, cx=cx, cy=cy, weight=best.conf))
        if samples and any(s.cx is not None for s in samples):
            return samples
        log("face-only: no face detected in any sampled frame", verbose)
        return None
    except Exception as err:
        log(f"face-only failed unexpectedly: {err!r}", verbose)
        return None
    finally:
        if detector is not None:
            detector.close()


def center_fallback_samples(start: float, end: float, fps: float) -> List[RawSample]:
    schedule = make_sample_schedule(start, end, fps) if _SAMPLING_AVAILABLE else _fallback_schedule(start, end, fps)
    return [RawSample(t=t, cx=0.5, cy=0.4) for t in schedule]


def run(args: argparse.Namespace) -> DetectResult:
    verbose = args.verbose
    source_w, source_h, video_fps = DEFAULT_SOURCE_W, DEFAULT_SOURCE_H, 25.0
    start = max(0.0, args.start)
    end = args.end
    video_info = None
    duration = 0.0

    if _SAMPLING_AVAILABLE:
        try:
            video_info = probe_video(args.video_path)
            source_w, source_h, video_fps = video_info.width, video_info.height, video_info.fps
            duration = video_info.duration_sec
        except Exception as err:
            log(f"probe (opencv) failed: {err!r}", verbose)

    if video_info is None:
        probed = _stdlib_probe_dimensions(args.video_path)
        if probed is not None:
            source_w, source_h, video_fps, duration = probed
            log("probe: recovered dimensions via ffprobe (opencv path unavailable)", verbose)
        else:
            log("probe: no usable video info from any source; using hardcoded defaults", verbose)

    if end is None or end <= 0:
        end = duration if duration > 0 else (start + DEFAULT_DURATION_SEC)
    if duration > 0:
        end = min(end, duration)
    if end <= start:
        end = start + max(1.0 / max(args.fps, 0.1), 0.2)

    forced = args.force_method
    raw: Optional[List[RawSample]] = None
    method = METHOD_CENTER_FALLBACK

    if raw is None and forced in (None, "light-asd"):
        raw = try_light_asd(args, video_info, start, end, verbose)
        if raw is not None:
            method = METHOD_LIGHT_ASD

    if raw is None and forced in (None, "face-only"):
        raw = try_face_only(args, video_info, start, end, verbose)
        if raw is not None:
            method = METHOD_FACE_ONLY

    if raw is None:
        raw = center_fallback_samples(start, end, args.fps)
        method = METHOD_CENTER_FALLBACK

    if _SAMPLING_AVAILABLE:
        track = build_track(raw, args.fps, source_w, source_h)
    else:
        # No cv2 -> no smoothing module either; center-fallback values are already
        # constant so passing them straight through is exactly equivalent.
        track = [TrackSample(t=s.t, cx=s.cx if s.cx is not None else 0.5, cy=s.cy if s.cy is not None else 0.4) for s in raw]

    if not track:  # structurally shouldn't happen, but the contract is absolute
        track = [TrackSample(t=start, cx=0.5, cy=0.4)]
        method = METHOD_CENTER_FALLBACK

    return DetectResult(source_w=int(source_w), source_h=int(source_h), fps=float(args.fps), method=method, track=track)


def synthesize_last_resort(args: argparse.Namespace) -> DetectResult:
    """Absolute floor: no video reads, no optional dependencies, cannot fail
    short of the Python interpreter itself being broken."""
    start = max(0.0, getattr(args, "start", 0.0) or 0.0)
    end = getattr(args, "end", None) or (start + DEFAULT_DURATION_SEC)
    fps = getattr(args, "fps", 5.0) or 5.0
    schedule = _fallback_schedule(start, end, fps)
    track = [TrackSample(t=t, cx=0.5, cy=0.4) for t in schedule]
    return DetectResult(
        source_w=DEFAULT_SOURCE_W, source_h=DEFAULT_SOURCE_H, fps=float(fps),
        method=METHOD_CENTER_FALLBACK, track=track,
    )


def write_output(result: DetectResult, out_path: str, verbose: bool) -> None:
    payload = result.to_dict()
    try:
        out_dir = os.path.dirname(os.path.abspath(out_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
    except Exception as err:
        log(f"could not write --out ({err!r}); dumping JSON to stdout instead", True)
        print(json.dumps(payload))
        raise

    summary = {
        "ok": True,
        "method": payload["method"],
        "sourceW": payload["sourceW"],
        "sourceH": payload["sourceH"],
        "fps": payload["fps"],
        "samples": len(payload["track"]),
        "out": out_path,
    }
    print(json.dumps(summary))


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    t0 = time.time()
    try:
        result = run(args)
    except Exception as err:  # the outermost guard: truly anything above this is non-fatal
        log(f"unexpected top-level failure ({err!r}); synthesizing center-fallback output", True)
        result = synthesize_last_resort(args)

    try:
        write_output(result, args.out, args.verbose)
    except Exception:
        # write_output already printed the JSON to stdout as a last resort; a
        # filesystem-level failure to write --out is the one thing this CLI
        # cannot paper over, so it's the only case that exits non-zero.
        return 1

    log(f"done in {time.time() - t0:.2f}s", args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
