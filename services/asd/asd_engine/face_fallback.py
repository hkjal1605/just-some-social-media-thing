"""Face-only fallback: no audio, no ASD — just "largest, most-central face wins"
per sampled frame, per the task's explicit fallback design.

Three backends, tried in order, each requiring nothing beyond files already
vendored in this directory (no runtime network access, no separate install
beyond what's already needed for opencv-python itself, or mediapipe if used):

  1. mediapipe's FaceDetector task (vendored BlazeFace short-range model at
     asd_engine/data/blaze_face_short_range.tflite, Apache 2.0 license) —
     best recall/precision across angles and lighting, if mediapipe is
     installed. Uses mediapipe's current Tasks API (mp.tasks.python.vision);
     mediapipe removed the older mp.solutions.face_detection API that most
     existing tutorials reference (confirmed while building this service, on
     mediapipe 0.10.35 -- see README.md), so this targets the API that's
     actually there now.
  2. OpenCV's DNN face detector (YuNet, ONNX, vendored at
     asd_engine/data/face_detection_yunet_2023mar.onnx, MIT license) via
     cv2.FaceDetectorYN — good quality, works with just opencv-python.
  3. A vendored Haar cascade (asd_engine/data/haarcascade_frontalface_default.xml,
     Intel/OpenCV license) via cv2.CascadeClassifier — last-resort, weaker
     across angles/lighting, but the most universally supported OpenCV API.

Tiers 2 and 3 both exist because opencv-python versions vary: 5.x removed
cv2.CascadeClassifier and its bundled cascade data entirely, so tier 2 (not
tier 3) is the one actually expected to run when mediapipe isn't installed.
Vendoring every tier's model/data file directly, rather than relying on
whatever a package's wheel happens to bundle, is what makes this whole ladder
reliable across dependency versions instead of silently degrading further
than necessary.
"""
from __future__ import annotations

import os
from typing import List, NamedTuple, Optional

import cv2
import numpy as np


class FaceBox(NamedTuple):
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float


class _MediapipeDetector:
    """mediapipe's Tasks API (mp.tasks.python.vision.FaceDetector), not the
    older mp.solutions.face_detection -- see module docstring."""

    def __init__(self, min_confidence: float = 0.5) -> None:
        os.environ.setdefault("GLOG_minloglevel", "2")  # quiet mediapipe's C++ init/GL/XNNPACK chatter on stderr
        import mediapipe as mp  # deferred import; may not be installed
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions

        model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "blaze_face_short_range.tflite")
        if not os.path.isfile(model_path):
            raise FileNotFoundError(f"bundled mediapipe face model missing at {model_path}")
        self._mp = mp
        options = vision.FaceDetectorOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            min_detection_confidence=min_confidence,
        )
        self._detector = vision.FaceDetector.create_from_options(options)

    def detect(self, frame_bgr: np.ndarray) -> List[FaceBox]:
        h, w = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._detector.detect(mp_image)
        boxes = []
        for det in result.detections or []:
            bb = det.bounding_box  # pixel-space: origin_x, origin_y, width, height
            x1 = max(0.0, float(bb.origin_x))
            y1 = max(0.0, float(bb.origin_y))
            x2 = min(float(w), float(bb.origin_x + bb.width))
            y2 = min(float(h), float(bb.origin_y + bb.height))
            conf = float(det.categories[0].score) if det.categories else 0.5
            if x2 > x1 and y2 > y1:
                boxes.append(FaceBox(x1, y1, x2, y2, conf))
        return boxes

    def close(self) -> None:
        try:
            self._detector.close()
        except Exception:
            pass


class _YuNetDetector:
    """cv2.FaceDetectorYN (YuNet, ONNX) -- available on opencv-python >= 4.5.4,
    including the 5.x releases that dropped CascadeClassifier. Vendored model
    file, see the module docstring."""

    def __init__(self, min_confidence: float = 0.6) -> None:
        model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "face_detection_yunet_2023mar.onnx")
        if not os.path.isfile(model_path):
            raise FileNotFoundError(f"bundled YuNet model missing at {model_path}")
        if not hasattr(cv2, "FaceDetectorYN"):
            raise RuntimeError("this opencv-python build has no cv2.FaceDetectorYN")
        self._detector = cv2.FaceDetectorYN.create(
            model=model_path, config="", input_size=(320, 320),
            score_threshold=min_confidence, nms_threshold=0.3, top_k=5000,
        )
        self._last_size = (320, 320)

    def detect(self, frame_bgr: np.ndarray) -> List[FaceBox]:
        h, w = frame_bgr.shape[:2]
        if (w, h) != self._last_size:
            self._detector.setInputSize((w, h))
            self._last_size = (w, h)
        _, faces = self._detector.detect(frame_bgr)
        boxes = []
        if faces is not None:
            for f in faces:
                x1, y1 = max(0.0, float(f[0])), max(0.0, float(f[1]))
                x2 = min(float(w), float(f[0] + f[2]))
                y2 = min(float(h), float(f[1] + f[3]))
                conf = float(f[14])
                if x2 > x1 and y2 > y1:
                    boxes.append(FaceBox(x1, y1, x2, y2, conf))
        return boxes

    def close(self) -> None:
        pass


def _find_cascade_file() -> str:
    # Vendored copy first: opencv-python stopped bundling the haarcascades data
    # files as of its 5.x releases (cv2.data.haarcascades exists but is empty),
    # so relying solely on the package's own copy is no longer safe. Vendoring
    # ~900KB of BSD/Intel-licensed OpenCV data guarantees this tier works
    # regardless of which opencv-python version is installed.
    vendored = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "haarcascade_frontalface_default.xml")
    if os.path.isfile(vendored):
        return vendored
    legacy = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    if os.path.isfile(legacy):
        return legacy
    raise FileNotFoundError("no haarcascade_frontalface_default.xml found (vendored or package-bundled)")


class _HaarDetector:
    def __init__(self) -> None:
        cascade_path = _find_cascade_file()
        self._cascade = cv2.CascadeClassifier(cascade_path)
        if self._cascade.empty():
            raise RuntimeError(f"failed to load haar cascade at {cascade_path}")

    def detect(self, frame_bgr: np.ndarray) -> List[FaceBox]:
        h, w = frame_bgr.shape[:2]
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        min_size = max(24, int(min(w, h) * 0.08))
        detections = self._cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_size, min_size)
        )
        boxes = []
        for (x, y, fw, fh) in detections:
            # Haar gives no real confidence; normalized area stands in so "pick
            # largest" downstream works the same way regardless of backend.
            conf = (fw * fh) / float(w * h)
            boxes.append(FaceBox(float(x), float(y), float(x + fw), float(y + fh), conf))
        return boxes

    def close(self) -> None:
        pass


class TieredFaceDetector:
    """Picks the best available backend once at construction, then reuses it."""

    def __init__(self, log=None) -> None:
        self._log = log or (lambda msg: None)
        self._impl = None
        self.backend_name = "none"
        backends = (
            ("mediapipe", _MediapipeDetector),
            ("yunet", _YuNetDetector),
            ("haar-cascade", _HaarDetector),
        )
        for name, factory in backends:
            try:
                self._impl = factory()
                self.backend_name = name
                return
            except Exception as err:
                self._log(f"face detector backend '{name}' unavailable: {err}")
        raise RuntimeError("no face detection backend available (mediapipe, yunet, and haar cascade all failed)")

    def detect(self, frame_bgr: np.ndarray) -> List[FaceBox]:
        return self._impl.detect(frame_bgr)

    def close(self) -> None:
        if self._impl is not None:
            self._impl.close()


def pick_best_face(faces: List[FaceBox], frame_w: int, frame_h: int) -> Optional[FaceBox]:
    """Largest face, tie-broken toward whichever is closest to frame center."""
    if not faces:
        return None
    cx0, cy0 = frame_w / 2.0, frame_h / 2.0
    diag = (frame_w ** 2 + frame_h ** 2) ** 0.5 or 1.0

    def score(f: FaceBox) -> float:
        area = max(0.0, f.x2 - f.x1) * max(0.0, f.y2 - f.y1)
        fx, fy = (f.x1 + f.x2) / 2.0, (f.y1 + f.y2) / 2.0
        dist = ((fx - cx0) ** 2 + (fy - cy0) ** 2) ** 0.5
        centrality = 1.0 - min(1.0, dist / diag)  # 1 = dead center, 0 = corner
        return area * (0.5 + 0.5 * centrality)  # size dominates; centrality only breaks ties

    return max(faces, key=score)
