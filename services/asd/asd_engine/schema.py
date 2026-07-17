"""Shared data types for the ASD reframing pipeline.

Keeping these in one place means every detection tier (Light-ASD, face-only,
center-fallback) and the smoothing stage all speak the same simple structures,
right up until final JSON serialization in detect.py.
"""
from __future__ import annotations

from typing import List, Optional

METHOD_LIGHT_ASD = "light-asd"
METHOD_TALKNET = "talknet"  # not implemented by this build; reserved by the output contract
METHOD_FACE_ONLY = "face-only"
METHOD_CENTER_FALLBACK = "center-fallback"


class RawSample:
    """One timestamp's raw (pre-smoothing) detection.

    cx/cy are None when no face/track could be attributed to this timestamp —
    the smoothing stage fills these gaps by holding the nearest known value.
    `weight` is an optional confidence-ish score (face size, ASD margin, ...)
    that the smoother can use to decide how fast to "snap" vs. glide.
    """

    __slots__ = ("t", "cx", "cy", "weight")

    def __init__(
        self,
        t: float,
        cx: Optional[float],
        cy: Optional[float],
        weight: float = 0.0,
    ) -> None:
        self.t = t
        self.cx = cx
        self.cy = cy
        self.weight = weight


class TrackSample:
    """One finalized (smoothed + clamped) output sample."""

    __slots__ = ("t", "cx", "cy")

    def __init__(self, t: float, cx: float, cy: float) -> None:
        self.t = t
        self.cx = cx
        self.cy = cy

    def to_dict(self) -> dict:
        return {"t": round(self.t, 3), "cx": round(self.cx, 4), "cy": round(self.cy, 4)}


class DetectResult:
    """The full output contract written to --out."""

    __slots__ = ("source_w", "source_h", "fps", "method", "track")

    def __init__(
        self,
        source_w: int,
        source_h: int,
        fps: float,
        method: str,
        track: List[TrackSample],
    ) -> None:
        self.source_w = source_w
        self.source_h = source_h
        self.fps = fps
        self.method = method
        self.track = track

    def to_dict(self) -> dict:
        return {
            "sourceW": self.source_w,
            "sourceH": self.source_h,
            "fps": self.fps,
            "method": self.method,
            "track": [s.to_dict() for s in self.track],
        }
