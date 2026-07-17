"""Temporal smoothing + in-frame clamping shared by every detection tier.

Turns a list of possibly-gappy RawSample points into a fully-populated,
jitter-free, decisively-snapping TrackSample list that a downstream ffmpeg
crop can follow directly. Every tier (Light-ASD, face-only, center-fallback)
funnels its raw per-timestamp detections through here so the temporal
behavior — hold through gaps, denoise single-frame spikes, glide on jitter,
snap on a real speaker switch, never leave the crop frame — is identical
regardless of which tier produced the numbers.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

from .schema import RawSample, TrackSample


def _fill_gaps(values: List[Optional[float]]) -> List[float]:
    """Hold the last known value forward; back-fill any leading gap from the first known value."""
    out: List[Optional[float]] = list(values)
    last: Optional[float] = None
    for i, v in enumerate(out):
        if v is None:
            out[i] = last
        else:
            last = v
    first_known = next((v for v in out if v is not None), None)
    if first_known is None:
        return [0.5] * len(out)  # nothing was ever detected across the whole window
    for i, v in enumerate(out):
        if v is None:
            out[i] = first_known
        else:
            break
    return out  # type: ignore[return-value]


def _median_filter(values: List[float], window: int) -> List[float]:
    if window < 3 or len(values) < 3:
        return list(values)
    if window % 2 == 0:
        window += 1
    half = window // 2
    n = len(values)
    out = []
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        chunk = sorted(values[lo:hi])
        out.append(chunk[len(chunk) // 2])
    return out


def _adaptive_ema(
    values: List[float],
    fps: float,
    snap_threshold: float,
    min_snap_run_sec: float,
    alpha_slow: float,
    alpha_fast: float,
) -> List[float]:
    """EMA whose smoothing factor jumps up once a deviation looks like a real
    speaker switch (sustained for `min_snap_run_sec`) rather than one noisy frame,
    so the crop glides through jitter but snaps decisively on a real switch.
    """
    if not values:
        return []
    min_run = max(1, round(min_snap_run_sec * fps))
    out = []
    state = values[0]
    run = 0
    for v in values:
        diff = abs(v - state)
        run = run + 1 if diff > snap_threshold else 0
        alpha = alpha_fast if run >= min_run else alpha_slow
        state = state + alpha * (v - state)
        out.append(state)
    return out


def smooth_axis(
    raw_values: List[Optional[float]],
    fps: float,
    snap_threshold: float = 0.12,
    min_snap_run_sec: float = 0.4,
    alpha_slow: float = 0.20,
    alpha_fast: float = 0.55,
    median_window: int = 5,
) -> List[float]:
    filled = _fill_gaps(raw_values)
    denoised = _median_filter(filled, median_window)
    return _adaptive_ema(denoised, fps, snap_threshold, min_snap_run_sec, alpha_slow, alpha_fast)


def crop_clamp_bounds(source_w: int, source_h: int, target_aspect: float = 9 / 16) -> Tuple[float, float]:
    """cx bounds so a full-height `target_aspect` crop never runs off the left/right edges.

    crop_w = source_h * target_aspect (full-height vertical crop out of a landscape
    source); half of that in normalized x is how far cx must stay from either edge.
    """
    if source_w <= 0 or source_h <= 0:
        return 0.5, 0.5
    crop_w = source_h * target_aspect
    half = (crop_w / 2.0) / source_w
    if half >= 0.5:
        return 0.5, 0.5  # source isn't wide enough for a full-height crop; nothing sensible but center
    return half, 1.0 - half


def build_track(
    raw: List[RawSample], fps: float, source_w: int, source_h: int, target_aspect: float = 9 / 16
) -> List[TrackSample]:
    """Full pipeline: gap-fill -> median filter -> adaptive EMA -> clamp, for cx and cy independently."""
    if not raw:
        return []
    ts = [s.t for s in raw]
    cx_raw = [s.cx for s in raw]
    cy_raw = [s.cy for s in raw]

    cx_smooth = smooth_axis(cx_raw, fps)
    cy_smooth = smooth_axis(cy_raw, fps, snap_threshold=0.20)  # vertical moves less/rarer; less snap-happy

    lo, hi = crop_clamp_bounds(source_w, source_h, target_aspect)
    out = []
    for t, cx, cy in zip(ts, cx_smooth, cy_smooth):
        cx_clamped = min(max(cx, lo), hi)
        cy_clamped = min(max(cy, 0.0), 1.0)
        out.append(TrackSample(t=t, cx=cx_clamped, cy=cy_clamped))
    return out
