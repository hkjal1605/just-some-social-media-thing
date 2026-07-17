"""Video I/O: probing, cheap sequential frame sampling, and ffmpeg helpers.

Only cv2 + numpy are required for anything in this module. The ffmpeg helpers
shell out to the `ffmpeg`/`ffprobe` binaries (already a hard dependency of the
Bun render pipeline this service feeds) and are only used by the Light-ASD
path — the face-only fallback never needs them.
"""
from __future__ import annotations

import math
import os
import subprocess
from typing import Iterator, List, NamedTuple, Optional, Tuple

import cv2


class VideoInfo(NamedTuple):
    width: int
    height: int
    fps: float
    duration_sec: float


def probe_video(video_path: str) -> VideoInfo:
    """Read basic geometry/timing off the container via OpenCV.

    Raises on a genuinely unopenable file; callers should treat that as fatal
    for every non-fallback tier (there is no frame to look at) but detect.py's
    outermost guard still has a hardcoded-default escape hatch so the JSON
    contract is never violated even here.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {video_path}")
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
        if width <= 0 or height <= 0:
            raise RuntimeError(f"video reports zero dimensions: {video_path}")
        if fps <= 0.1:
            fps = 25.0  # sane default; some containers/codecs don't report fps via OpenCV
        duration = frame_count / fps if frame_count > 0 else 0.0
        if duration <= 0.0:
            # Fall back to walking the stream to find duration is too slow for large
            # files; ffprobe is more reliable for this so try it before giving up.
            duration = _ffprobe_duration(video_path) or 0.0
        return VideoInfo(width=width, height=height, fps=fps, duration_sec=duration)
    finally:
        cap.release()


def _ffprobe_duration(video_path: str) -> Optional[float]:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True, text=True, timeout=20,
        )
        val = result.stdout.strip()
        return float(val) if val else None
    except Exception:
        return None


def has_audio_stream(video_path: str) -> bool:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a",
                "-show_entries", "stream=index",
                "-of", "csv=p=0",
                video_path,
            ],
            capture_output=True, text=True, timeout=20,
        )
        return bool(result.stdout.strip())
    except Exception:
        return False


def make_sample_schedule(start: float, end: float, fps: float) -> List[float]:
    """Absolute timestamps to emit, spaced 1/fps apart, always non-empty."""
    if fps <= 0:
        fps = 5.0
    span = max(0.0, end - start)
    n = int(math.floor(span * fps + 1e-6))
    if n < 1:
        n = 1  # guarantee at least one sample even for a near-zero-length window
    return [start + i / fps for i in range(n)]


def iter_sample_frames(
    video_path: str, start: float, end: float, fps: float, video_info: Optional[VideoInfo] = None
) -> Iterator[Tuple[float, "cv2.typing.MatLike"]]:
    """Yield (timestamp, BGR frame) pairs at `fps` samples/sec across [start, end).

    Walks the video sequentially with cheap grab()-only skips between sampled
    frames (decode only happens on the frames we actually keep) instead of
    repeated random seeks, which are slow and occasionally inaccurate on
    variable-frame-rate footage.
    """
    info = video_info or probe_video(video_path)
    schedule = make_sample_schedule(start, end, fps)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {video_path}")
    try:
        if start > 0:
            cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
        current_frame_idx = int(round(cap.get(cv2.CAP_PROP_POS_FRAMES) or 0))
        for target_t in schedule:
            target_frame_idx = int(round(target_t * info.fps))
            # Cheap forward skip: grab() decodes nothing, just advances the read head.
            while current_frame_idx < target_frame_idx:
                if not cap.grab():
                    return  # ran out of stream before reaching this sample
                current_frame_idx += 1
            # read() == grab() + decode; this is the one frame per sample we actually pay for.
            ok, frame = cap.read()
            current_frame_idx += 1
            if not ok or frame is None:
                return  # ran out of stream exactly at/after this sample
            yield (target_t, frame)
    finally:
        cap.release()


def extract_audio_wav(video_path: str, start: float, end: float, out_wav: str, sr: int = 16000) -> bool:
    """Extract a mono 16-bit PCM wav for [start, end). Returns False (never raises) on any failure."""
    duration = max(0.05, end - start)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-vn", "-ac", "1", "-ar", str(sr), "-acodec", "pcm_s16le",
        out_wav, "-loglevel", "error",
    ]
    try:
        subprocess.run(cmd, check=True, timeout=120, capture_output=True)
        return os.path.isfile(out_wav) and os.path.getsize(out_wav) > 44
    except Exception:
        return False


def extract_frames_ffmpeg(video_path: str, start: float, end: float, out_dir: str, analysis_fps: int = 25) -> int:
    """Dump [start, end) as a constant-frame-rate jpg sequence (%06d.jpg). Returns frame count written."""
    os.makedirs(out_dir, exist_ok=True)
    pattern = os.path.join(out_dir, "%06d.jpg")
    duration = max(0.05, end - start)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-qscale:v", "2", "-r", str(analysis_fps), "-vsync", "cfr",
        pattern, "-loglevel", "error",
    ]
    subprocess.run(cmd, check=True, timeout=600, capture_output=True)
    return len([f for f in os.listdir(out_dir) if f.endswith(".jpg")])
