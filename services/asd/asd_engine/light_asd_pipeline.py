"""Primary detection tier: audio-visual active speaker detection via the
vendored Light-ASD model (services/asd/third_party/light_asd, MIT license,
from https://github.com/Junhua-Liao/Light-ASD).

This module's job is narrower than the upstream repo's own demo
(Columbia_test.py): we don't need a rendered debug video, just "which face is
talking, where is it" at each requested timestamp. The pipeline mirrors
Columbia_test.py step for step --

    ffmpeg audio+frame extraction @ 25fps
      -> S3FD face detection per frame (scale 0.25, conf_th 0.9)
      -> greedy IOU face tracking (whole window treated as one continuous
         shot -- see the module docstring note below on why we skip
         PySceneDetect's shot segmentation)
      -> per-track face-crop + MFCC features
      -> Light-ASD dual-stream scoring, averaged across upstream's 11-way
         multi-duration ensemble
      -> per-frame winning track -> face bbox center

-- except feature extraction happens in-memory against the already-decoded
frames/audio instead of writing+re-reading intermediate .avi/.wav crops per
track (upstream needed those files for its visualization output; we only
need the numbers).

Every import beyond the stdlib is deferred into run_light_asd() so this
module always imports cleanly even when torch/scipy/etc. aren't installed --
detect.py relies on that to distinguish "Light-ASD unavailable, fall back"
from "bug in this file, still fall back but log louder".

On shot segmentation: upstream calls PySceneDetect before tracking, mainly to
avoid the AVA/Columbia benchmark's multi-hour movies matching faces across a
hard cut. Our inputs are short candidate-clip windows (seconds to low tens of
seconds) rather than full movies, and the IOU tracker already terminates a
track the moment a face's position jumps too far to match (which is exactly
what a hard cut does), so a track naturally ends and a new one starts right
where a cut would be. We skip the extra PySceneDetect dependency (whose
video-seeking API has churned across versions) and treat the whole analyzed
window as one continuous shot, matching upstream's own no-scenes-found
fallback (`if sceneList == []: sceneList = [(start, end)]`).
"""
from __future__ import annotations

import math
import os
import shutil
import sys
import tempfile
from typing import List, Optional

from .schema import RawSample
from .sampling import extract_audio_wav, extract_frames_ffmpeg, has_audio_stream, make_sample_schedule

DURATION_SET = (1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6)  # upstream's 11-way multi-duration ensemble, unchanged
_THIRD_PARTY_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "third_party", "light_asd")
)


class LightAsdUnavailable(Exception):
    """Raised for every *expected* reason this tier can't run (missing deps,
    missing weights, no audio track, no faces found, ...). detect.py catches
    this specifically (and Exception generally, as a defensive backstop) and
    falls through to the next tier -- this exception type just makes the
    stderr log read more like "unavailable" than "broken"."""


def _resolve_device(torch_mod, requested: str) -> str:
    if requested and requested != "auto":
        return requested
    if torch_mod.cuda.is_available():
        return "cuda"
    mps = getattr(torch_mod.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def _iou(box_a, box_b) -> float:
    xa, ya = max(box_a[0], box_b[0]), max(box_a[1], box_b[1])
    xb, yb = min(box_a[2], box_b[2]), min(box_a[3], box_b[3])
    inter = max(0.0, xb - xa) * max(0.0, yb - ya)
    area_a = (box_a[2] - box_a[0]) * (box_a[3] - box_a[1])
    area_b = (box_b[2] - box_b[0]) * (box_b[3] - box_b[1])
    denom = area_a + area_b - inter
    return inter / denom if denom > 0 else 0.0


def _track_faces(frame_dets, num_failed_det: int, iou_thres: float, min_track: int, np_mod, interp1d):
    """Greedy IOU tracker, ported from Columbia_test.py's track_shot(). Repeatedly
    pulls the longest contiguous chain of IOU-matching detections out of the
    remaining pool until nothing is left, keeping chains longer than min_track
    and interpolating their bbox across any single-frame gaps (allowed up to
    num_failed_det frames apart)."""
    working = [list(f) for f in frame_dets]
    tracks = []
    while True:
        track = []
        for frame_faces in working:
            matched = None
            for face in frame_faces:
                if not track:
                    matched = face
                    break
                if face["frame"] - track[-1]["frame"] <= num_failed_det:
                    if _iou(face["bbox"], track[-1]["bbox"]) > iou_thres:
                        matched = face
                        break
                else:
                    matched = "stop"
                    break
            if matched == "stop":
                break
            if matched is not None:
                track.append(matched)
                frame_faces.remove(matched)
        if not track:
            break
        if len(track) > min_track:
            frame_nums = np_mod.array([f["frame"] for f in track])
            bboxes = np_mod.array([f["bbox"] for f in track])
            frame_i = np_mod.arange(frame_nums[0], frame_nums[-1] + 1)
            bboxes_i = []
            for k in range(4):
                fn = interp1d(frame_nums, bboxes[:, k])
                bboxes_i.append(fn(frame_i))
            tracks.append({"frame": frame_i, "bbox": np_mod.stack(bboxes_i, axis=1)})
    return tracks


def _safe_medfilt(arr, kernel: int, medfilt):
    n = len(arr)
    if n < 3:
        return arr
    k = min(kernel, n if n % 2 == 1 else n - 1)
    if k < 3:
        return arr
    return medfilt(arr, kernel_size=k)


def _build_track_features(
    track, frames_bgr, audio_i16, audio_sr, analysis_fps, crop_scale, video_size, face_size, cv2_mod, np_mod, medfilt
):
    """Per-track face crop (-> grayscale, center-cropped stack) and matching MFCC
    slice, computed in-memory. Mirrors Columbia_test.py's crop_video() +
    evaluate_network()'s feature prep, minus the intermediate .avi/.wav round trip."""
    import python_speech_features

    frame_idx = track["frame"]
    bbox = track["bbox"]

    sizes = np_mod.maximum(bbox[:, 3] - bbox[:, 1], bbox[:, 2] - bbox[:, 0]) / 2.0
    cx = (bbox[:, 0] + bbox[:, 2]) / 2.0
    cy = (bbox[:, 1] + bbox[:, 3]) / 2.0

    sizes_s = _safe_medfilt(sizes, 13, medfilt)
    cx_s = _safe_medfilt(cx, 13, medfilt)
    cy_s = _safe_medfilt(cy, 13, medfilt)

    video_feature = []
    for i, fidx in enumerate(frame_idx):
        fi = max(0, min(len(frames_bgr) - 1, int(round(float(fidx)))))
        frame = frames_bgr[fi]
        bs = max(1.0, float(sizes_s[i]))
        cs = crop_scale
        bsi = int(bs * (1 + 2 * cs)) + 1
        padded = cv2_mod.copyMakeBorder(frame, bsi, bsi, bsi, bsi, cv2_mod.BORDER_CONSTANT, value=(110, 110, 110))
        my, mx = float(cy_s[i]) + bsi, float(cx_s[i]) + bsi
        y0, y1 = int(my - bs), int(my + bs * (1 + 2 * cs))
        x0, x1 = int(mx - bs * (1 + cs)), int(mx + bs * (1 + cs))
        face = padded[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
        if face.size == 0:
            face = padded  # degenerate guard; should not normally trigger
        face = cv2_mod.resize(face, (video_size, video_size))
        gray = cv2_mod.cvtColor(face, cv2_mod.COLOR_BGR2GRAY)
        half = face_size // 2
        c = video_size // 2
        video_feature.append(gray[c - half:c + half, c - half:c + half])
    video_feature = np_mod.array(video_feature)

    track_start_sec = float(frame_idx[0]) / analysis_fps
    track_end_sec = float(frame_idx[-1] + 1) / analysis_fps
    a0 = max(0, int(round(track_start_sec * audio_sr)))
    a1 = min(len(audio_i16), int(round(track_end_sec * audio_sr)))
    audio_slice = audio_i16[a0:a1] if a1 > a0 else audio_i16[0:1]
    audio_feature = python_speech_features.mfcc(audio_slice, audio_sr, numcep=13, winlen=0.025, winstep=0.010)

    return video_feature, audio_feature, cx_s, cy_s, frame_idx


def _score_track(model, video_feature, audio_feature, device, analysis_fps, torch_mod, np_mod):
    audio_seconds = (audio_feature.shape[0] - audio_feature.shape[0] % 4) / 100.0
    video_seconds = video_feature.shape[0] / float(analysis_fps)
    # Upstream computes min(audioFrames/100, videoFrames) -- a duration in
    # seconds compared against a raw frame COUNT, off by ~analysis_fps. It only
    # "works" because the frame-count term is normally far larger and never
    # binds. We compare like units (both in seconds) so a short/mismatched
    # track degrades gracefully instead of slicing on the wrong axis.
    length = min(audio_seconds, video_seconds)
    if length <= 0:
        return None
    audio_feature = audio_feature[: int(round(length * 100))]
    video_feature = video_feature[: int(round(length * analysis_fps))]

    all_scores = []
    for duration in DURATION_SET:
        batch_size = int(math.ceil(length / duration))
        scores: list = []
        with torch_mod.no_grad():
            for i in range(batch_size):
                a_chunk = audio_feature[i * duration * 100:(i + 1) * duration * 100]
                v_chunk = video_feature[i * duration * analysis_fps:(i + 1) * duration * analysis_fps]
                if len(a_chunk) == 0 or len(v_chunk) == 0:
                    continue
                input_a = torch_mod.FloatTensor(a_chunk).unsqueeze(0).to(device)
                input_v = torch_mod.FloatTensor(v_chunk).unsqueeze(0).to(device)
                embed_a = model.model.forward_audio_frontend(input_a)
                embed_v = model.model.forward_visual_frontend(input_v)
                out = model.model.forward_audio_visual_backend(embed_a, embed_v)
                score = model.lossAV.forward(out, labels=None)
                scores.extend(score)
        if scores:
            all_scores.append(scores)
    if not all_scores:
        return None
    min_len = min(len(s) for s in all_scores)
    if min_len == 0:
        return None
    return np_mod.mean(np_mod.array([s[:min_len] for s in all_scores]), axis=0)


def _boxcar_smooth(scores, np_mod, half_window: int = 2):
    n = len(scores)
    out = [0.0] * n
    for i in range(n):
        lo, hi = max(0, i - half_window), min(n, i + half_window + 1)
        out[i] = float(np_mod.mean(scores[lo:hi]))
    return out


def run_light_asd(
    video_path: str,
    start: float,
    end: float,
    out_fps: float,
    analysis_fps: int,
    device: str,
    weights_dir: str,
    video_info,
    log,
) -> List[RawSample]:
    if not has_audio_stream(video_path):
        raise LightAsdUnavailable("source has no audio stream (Light-ASD needs audio+video)")

    try:
        import cv2
        import numpy as np
    except Exception as err:
        raise LightAsdUnavailable(f"opencv/numpy unavailable: {err}") from err
    try:
        import torch
    except Exception as err:
        raise LightAsdUnavailable(f"torch not installed: {err}") from err
    try:
        from scipy.interpolate import interp1d
        from scipy.io import wavfile
        from scipy.signal import medfilt
    except Exception as err:
        raise LightAsdUnavailable(f"scipy not installed: {err}") from err
    try:
        import python_speech_features  # noqa: F401  (imported lazily inside _build_track_features too)
    except Exception as err:
        raise LightAsdUnavailable(f"python_speech_features not installed: {err}") from err

    if _THIRD_PARTY_DIR not in sys.path:
        sys.path.insert(0, _THIRD_PARTY_DIR)
    try:
        from ASD import ASD as LightAsdNet
        from model.faceDetector.s3fd import S3FD
    except Exception as err:
        raise LightAsdUnavailable(f"vendored Light-ASD code failed to import: {err}") from err

    resolved_device = _resolve_device(torch, device)
    asd_weights = os.path.join(weights_dir, "light_asd", "finetuning_TalkSet.model")
    s3fd_weights = os.path.join(weights_dir, "s3fd", "sfd_face.pth")
    if not os.path.isfile(asd_weights):
        raise LightAsdUnavailable(f"missing Light-ASD weights at {asd_weights} (run download_weights.py)")
    if not os.path.isfile(s3fd_weights):
        raise LightAsdUnavailable(f"missing S3FD weights at {s3fd_weights} (run download_weights.py)")

    tmp_dir = tempfile.mkdtemp(prefix="asd-light-")
    try:
        wav_path = os.path.join(tmp_dir, "audio.wav")
        if not extract_audio_wav(video_path, start, end, wav_path, sr=16000):
            raise LightAsdUnavailable("audio extraction failed")

        frames_dir = os.path.join(tmp_dir, "frames")
        n_written = extract_frames_ffmpeg(video_path, start, end, frames_dir, analysis_fps=analysis_fps)
        if n_written < 5:
            raise LightAsdUnavailable(f"too few frames extracted ({n_written}) to analyze")

        frame_files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".jpg"))
        frames_bgr = []
        for fname in frame_files:
            img = cv2.imread(os.path.join(frames_dir, fname))
            if img is not None:
                frames_bgr.append(img)
        if len(frames_bgr) < 5:
            raise LightAsdUnavailable("failed to decode extracted frames")
        frame_h, frame_w = frames_bgr[0].shape[:2]

        audio_sr, audio_i16 = wavfile.read(wav_path)

        log(f"S3FD face detection over {len(frames_bgr)} frames on device={resolved_device}")
        detector = S3FD(device=resolved_device, weights_path=s3fd_weights)
        frame_dets = []
        for idx, frame in enumerate(frames_bgr):
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            bboxes = detector.detect_faces(rgb, conf_th=0.9, scales=[0.25])
            frame_dets.append(
                [{"frame": idx, "bbox": bbox[:4].tolist(), "conf": float(bbox[4])} for bbox in bboxes]
            )
        if sum(len(d) for d in frame_dets) == 0:
            raise LightAsdUnavailable("S3FD found no faces in the analyzed window")

        min_track = max(5, int(analysis_fps * 0.3))
        num_failed_det = max(5, analysis_fps // 2)
        tracks = _track_faces(frame_dets, num_failed_det, 0.5, min_track, np, interp1d)
        if not tracks:
            raise LightAsdUnavailable("no stable face track survived (faces too brief/erratic)")
        log(f"{len(tracks)} face track(s) found across {len(frames_bgr)} analyzed frames")

        model = LightAsdNet(device=resolved_device)
        model = model.to(resolved_device)
        model.loadParameters(asd_weights)
        model.eval()

        per_track = []
        for track in tracks:
            video_feature, audio_feature, cx_s, cy_s, frame_idx = _build_track_features(
                track, frames_bgr, audio_i16, audio_sr, analysis_fps, 0.40, 224, 112, cv2, np, medfilt
            )
            raw_scores = _score_track(model, video_feature, audio_feature, resolved_device, analysis_fps, torch, np)
            if raw_scores is None or len(raw_scores) == 0:
                continue
            smoothed = _boxcar_smooth(raw_scores, np)
            n = min(len(smoothed), len(frame_idx))
            per_track.append((frame_idx[:n], smoothed[:n], cx_s[:n], cy_s[:n]))

        if not per_track:
            raise LightAsdUnavailable("no track produced a usable ASD score")

        winners = {}
        for frame_idx_arr, scores_arr, cx_arr, cy_arr in per_track:
            for i, fidx in enumerate(frame_idx_arr):
                fi = int(round(float(fidx)))
                score = float(scores_arr[i])
                prev = winners.get(fi)
                if prev is None or score > prev[2]:
                    winners[fi] = (float(cx_arr[i]) / frame_w, float(cy_arr[i]) / frame_h, score)

        schedule = make_sample_schedule(start, end, out_fps)
        samples = []
        for t in schedule:
            fi = int(round((t - start) * analysis_fps))
            hit = winners.get(fi)
            if hit is None:
                samples.append(RawSample(t=t, cx=None, cy=None))
            else:
                samples.append(RawSample(t=t, cx=hit[0], cy=hit[1], weight=hit[2]))
        return samples
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
