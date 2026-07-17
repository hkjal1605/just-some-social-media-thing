# services/asd — active-speaker reframing

Given a landscape (16:9-ish) talking-head/podcast video, figure out **where
the active speaker's face is over time**, so a downstream ffmpeg step can
crop a 9:16 vertical window that follows/switches to whoever is talking
instead of a static center crop.

This is a standalone Python service. It is not part of the Bun/TS build —
nothing here touches `package.json`, `tsconfig.json`, or any TS source. The
Bun render pipeline (`packages/media`, `apps/workers/src/engines/factory/render.ts`)
calls `detect.py` as a subprocess and reads the JSON it writes.

## Contract

```
python services/asd/detect.py <video_path> --out <output.json> [--start S] [--end E] [--fps 5]
```

- `--start` / `--end` (seconds, optional): analyze only that window of the
  source video. Output timestamps are **absolute** (relative to the source),
  not relative to the window.
- `--fps` (default 5): output samples per second.

Output JSON (written to `--out`; a one-line JSON summary also goes to stdout,
everything else — progress, warnings, tier fallbacks — goes to stderr):

```json
{
  "sourceW": 1920,
  "sourceH": 960,
  "fps": 5.0,
  "method": "light-asd",
  "track": [
    { "t": 0.0, "cx": 0.4861, "cy": 0.3223 },
    { "t": 0.2, "cx": 0.4861, "cy": 0.3223 }
  ]
}
```

- `cx`/`cy`: normalized (0..1) center of the active speaker's face at time `t`.
- `method`: whichever tier actually produced the track — `"light-asd"`,
  `"talknet"` (reserved by the contract; not implemented by this build),
  `"face-only"`, or `"center-fallback"`.
- The track is temporally smoothed (median filter + adaptive EMA — see
  "Smoothing" below) and `cx` is clamped so a full-height 9:16 crop centered
  on it never runs off the left/right edge of the frame.
- **The track is never empty and this CLI never raises/crashes.** If every
  detection tier fails for any reason (missing weights, missing torch, no
  face found, an unreadable video, even a completely bare Python environment
  with none of `requirements.txt` installed), it falls all the way back to
  `center-fallback`: `cx=0.5, cy=0.4` for every sample. Exit code is `0`
  in every case except a genuine filesystem failure to write `--out`.

## How it works: three tiers

```
Light-ASD (audio-visual)  --fails-->  face-only (visual-only)  --fails-->  center-fallback
```

Each tier is tried in order; any exception at any point (missing dependency,
missing weights, no face/track found, a bug) is caught and logged to stderr,
and the CLI moves to the next tier. Every raw per-timestamp detection —
regardless of which tier produced it — is run through the **same** smoothing
and clamping pipeline (`asd_engine/smoothing.py`), so the temporal behavior
is consistent no matter which tier ends up winning on a given input.

### 1. Light-ASD (primary)

Audio-visual active speaker detection using [Light-ASD](https://github.com/Junhua-Liao/Light-ASD)
(CVPR 2023, MIT license), vendored under `third_party/light_asd/`. Pipeline
(`asd_engine/light_asd_pipeline.py`), adapted from upstream's `Columbia_test.py`:

1. `ffmpeg` extracts audio (16kHz mono wav) and a constant-25fps frame
   sequence for the analysis window.
2. S3FD (a CNN face detector, vendored alongside Light-ASD) detects faces in
   every frame.
3. A greedy IOU tracker links per-frame detections into face tracks (the
   whole window is treated as one continuous shot — see "Deliberate
   simplifications" below).
4. Each track's face crops (grayscale, center-cropped to 112x112) and the
   matching MFCC audio slice are fed through the Light-ASD dual-stream model,
   producing a per-frame "is this face talking" score, averaged across
   upstream's 11-way multi-duration ensemble (unchanged from upstream).
5. At each output timestamp, whichever track has the highest smoothed score
   wins; its face bbox center is the raw sample for that timestamp.

Requires `torch`, `scipy`, `python_speech_features`, and two weight files
(see "Weights setup"). If any of these aren't available, this tier reports
itself unavailable and the CLI falls through — it never crashes the process.

### 2. Face-only fallback

No audio, no "who's talking" — just **the largest, most-central detected
face** per sampled frame (`asd_engine/face_fallback.py`), smoothed the same
way. Three backends tried in order, each using a model file vendored in
`asd_engine/data/` (no runtime network access, no dependency on what a given
`opencv-python`/`mediapipe` release happens to bundle — see "Compatibility
findings" below for why that matters):

1. **mediapipe** (`BlazeFace short-range`, Apache 2.0) via mediapipe's
   current Tasks API, if `mediapipe` is installed.
2. **YuNet** (`cv2.FaceDetectorYN`, ONNX, MIT license) — works with just
   `opencv-python`, no extra install.
3. **Haar cascade** (`cv2.CascadeClassifier`, Intel/OpenCV license) —
   last-resort, weaker across angles/lighting, but the most universally
   supported OpenCV API.

This tier requires only `numpy` + `opencv-python` (mediapipe is optional,
for better quality). It's the tier that runs in production if Light-ASD's
heavier dependencies/weights aren't set up.

### 3. Center-fallback

`cx=0.5, cy=0.4` for every sample. Requires nothing — not even
`opencv-python` (dimensions come from `ffprobe` via plain `subprocess`, or a
hardcoded 1920x1080 if even that fails). This is the floor the whole system
degrades to; see `detect.py`'s `synthesize_last_resort()` for the literal
last-resort path.

## Smoothing

`asd_engine/smoothing.py`, applied uniformly to every tier's raw output:

1. **Gap-fill**: timestamps with no detection hold the last known value
   forward (or back-fill from the first known value at the very start).
2. **Median filter** (5-sample window): rejects single-frame outlier spikes.
3. **Adaptive EMA**: normally glides slowly (`alpha=0.20`) to kill jitter, but
   escalates to a fast EMA (`alpha=0.55`) once a deviation from the current
   smoothed position has been *sustained* for several consecutive samples —
   i.e. a real speaker switch, not one noisy frame. This is what gives a
   "smoothed but decisive transition, not a slow drift across the whole
   frame" (verified: a synthetic hard left→right speaker switch settles to
   within 0.05 of the new position in ~1 second at 5fps, while staying
   essentially flat under ±0.01 jitter before the switch — see the repo's
   test notes / git history for the exact script).
4. **Clamp**: `cx` is bounded to `[cropHalfW/sourceW, 1 - cropHalfW/sourceW]`
   where `cropHalfW = sourceH * 9/16 / 2`, so a full-height 9:16 crop
   centered on `cx` always stays inside the frame. If the source is too
   narrow for a full-height 9:16 crop at all, `cx` degenerates to `0.5`
   rather than producing an inverted/nonsensical range.

## Setup

```bash
cd services/asd
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt        # see requirements.txt for the tiered breakdown
python download_weights.py             # fetches the two Light-ASD weight files
```

`requirements.txt` is tiered — `numpy` + `opencv-python` alone gets you
center-fallback + the YuNet/Haar face-only tiers; add `mediapipe` for the
better face-only backend; add `torch`/`scipy`/`python_speech_features` (and
run `download_weights.py`) for the primary Light-ASD tier. Nothing above
tier 1 is required for the CLI to run correctly — it just runs a weaker tier.

### Weights setup

```bash
python download_weights.py            # both files
python download_weights.py --skip-s3fd  # if Google Drive is unreachable from this network
```

Downloads into `services/asd/weights/` (gitignored):

| File | Size | Source |
|---|---|---|
| `weights/light_asd/finetuning_TalkSet.model` | ~4MB | Committed directly in the upstream GitHub repo — plain HTTPS GET. |
| `weights/s3fd/sfd_face.pth` | ~86MB | Hosted on Google Drive by upstream (not in git) — fetched via `gdown`. |

Both are required for the Light-ASD tier; either missing makes that tier
report itself unavailable (not a crash) and the CLI runs face-only instead.
If `gdown` can't reach Google Drive from your deploy network, download
`sfd_face.pth` manually (the script prints the exact `gdown`/browser command)
and place it at that path.

GPU is optional. `--device auto` (default) picks CUDA, then Apple Silicon
MPS, then CPU. Verified end-to-end on CPU/MPS in this repo's dev environment
(Apple M-series) at roughly 2s of wall-clock per analyzed second of video for
S3FD detection + scoring on a single face track — a real CUDA GPU in
production will be considerably faster and is recommended for anything
beyond short clips.

## Usage example

```bash
python services/asd/detect.py ~/Downloads/podcast.mp4 \
  --out /tmp/track.json --start 30 --end 75 --fps 5 --verbose
```

```
[asd-detect] light-asd: S3FD face detection over 1125 frames on device=mps
[asd-detect] light-asd: 2 face track(s) found across 1125 analyzed frames
[asd-detect] done in 94.32s
{"ok": true, "method": "light-asd", "sourceW": 1920, "sourceH": 960, "fps": 5.0, "samples": 225, "out": "/tmp/track.json"}
```

Extra flags beyond the calling contract (all optional, additive, safe
defaults): `--device {auto,cpu,cuda,mps}`, `--analysis-fps` (Light-ASD's
internal frame rate, default 25 — matches the pretrained weights, changing
it is untested), `--force-method {light-asd,face-only,center-fallback}`
(skip the fallback chain, for debugging), `--weights-dir`, `-v/--verbose`.

## Layout

```
services/asd/
  detect.py                    CLI entry point / fallback orchestration
  download_weights.py          fetches the two Light-ASD weight files
  requirements.txt
  asd_engine/
    schema.py                  RawSample / TrackSample / DetectResult
    sampling.py                 video probing, frame sampling, ffmpeg helpers
    smoothing.py                gap-fill + median filter + adaptive EMA + clamp
    face_fallback.py            tiered face-only detector (mediapipe/YuNet/Haar)
    light_asd_pipeline.py       Light-ASD orchestration (detect/track/score)
    data/                       vendored model files for the face-only tiers
      blaze_face_short_range.tflite       (mediapipe BlazeFace, Apache 2.0)
      face_detection_yunet_2023mar.onnx   (OpenCV Zoo YuNet, MIT)
      haarcascade_frontalface_default.xml (OpenCV, Intel license)
  third_party/light_asd/       vendored Light-ASD model + S3FD code (MIT)
  weights/                     gitignored; populated by download_weights.py
```

## Deliberate simplifications vs. upstream Light-ASD

- **No PySceneDetect shot segmentation.** Upstream runs scene-cut detection
  before face tracking, mainly to avoid matching faces across a hard cut in
  hours-long movies. Our inputs are short candidate-clip windows (seconds to
  low tens of seconds), and the IOU tracker already terminates a track the
  moment a face's position jumps too far to match — which is exactly what a
  hard cut does — so a new track starts right where a cut would be anyway.
  Skipped to avoid a dependency on PySceneDetect's video-seeking API, which
  has churned across versions.
- **In-memory feature extraction**, not upstream's intermediate
  `.avi`/`.wav` crop files. Upstream needed literal cropped video files for
  its debug visualization; we only need face-crop arrays and MFCC features,
  computed directly from the already-decoded frames/audio.
- **Corrected a unit mismatch** in upstream's multi-duration score
  normalization (`min(audioSeconds, videoFrameCount)` compares a duration in
  seconds against a raw frame count — off by `analysis_fps`; only "worked" in
  upstream because the frame-count term is normally far larger and never
  binds). Fixed to compare like units; identical result in the normal case,
  more graceful on a pathologically short/mismatched track. See the comment
  in `light_asd_pipeline.py::_score_track`.

## Compatibility findings (why some vendored files are patched, not verbatim)

Found while building and testing this service against current dependency
versions — documented here since they're non-obvious and could bite a future
upgrade:

- **`opencv-python` 5.0 removed `cv2.CascadeClassifier` and its bundled Haar
  cascade data files entirely** (`cv2.data.haarcascades` still exists but is
  an empty directory). The Haar tier now vendors its own copy of
  `haarcascade_frontalface_default.xml` instead of relying on the package,
  and the YuNet tier (`cv2.FaceDetectorYN`, available since ~4.5.4) is the
  one actually expected to run when mediapipe isn't installed.
- **mediapipe 0.10.35 has no `mp.solutions.face_detection`** — that API is
  gone. `_MediapipeDetector` targets the current Tasks API
  (`mp.tasks.python.vision.FaceDetector`) with a vendored BlazeFace model
  instead.
- **Light-ASD's own code only ever ran on `.cuda()`** (no CPU/MPS path) and
  loaded checkpoints via bare `torch.load(path)` (fails off-GPU if the
  checkpoint was saved from CUDA tensors). Patched in `third_party/light_asd/ASD.py`
  and `.../s3fd/__init__.py` to take an explicit `device` and pass
  `map_location`.
- **`np.int`** (removed in numpy>=1.24) in `s3fd/box_utils.py`, fixed to
  plain `int`.
- **A deprecated `torch.index_select(..., out=preallocated)` pattern** in
  `s3fd/box_utils.py`'s NMS floods stderr with resize-deprecation warnings on
  modern PyTorch (confirmed: ~90 warning lines per analyzed frame). Replaced
  with direct assignment — provably behavior-identical (verified
  byte-for-byte identical output JSON before/after the fix on the same
  input), since the preallocated tensors were discarded and reassigned every
  iteration regardless.
- **The S3FD weight loader used to auto-`gdown` on import** if its weight
  file was missing — a network call as an `import` side effect, with
  failures silently swallowed. Removed; `download_weights.py` is now the
  only thing that fetches weights, and `S3FD.__init__` raises a clear
  `FileNotFoundError` if they're not there yet.

Every vendored file carries a header comment naming exactly what changed and
why; `third_party/light_asd/LICENSE` and the MIT/Apache/Intel notices above
are preserved per each source's license.

## Verification performed

All of the following were run end-to-end in this repo's dev environment
(macOS, Apple M-series, Python 3.12 venv) against both a real video
(`~/Downloads/mkbhd-1.mp4`, 1920x960, ~15min, h264/aac) and a synthetic one
(generated with two colored regions + a drawn face-like pattern per an
animated mouth, muxed with a sine-tone audio track):

- Light-ASD tier: real weights downloaded, real face track(s) found and
  scored, valid smoothed/clamped output (`method: "light-asd"`), on windows
  from 8s up to the full first 60s of the real video (the task's suggested
  verification input) — 3 face tracks found across 1500 analyzed frames,
  300 correctly-spaced output samples, in 128.84s wall-clock on CPU/MPS.
- Face-only tier, all three backends individually (mediapipe, YuNet, Haar) —
  forced dependency availability up/down to exercise each one.
- Center-fallback: forced via `--force-method`, via a video with no
  detectable face, via a `--start` far beyond the video's duration, and via
  running with **zero pip packages installed** (bare system Python) — all
  produced valid, non-empty, correctly-shaped JSON with exit code 0.
- Clamping at the frame edge, and with a source too narrow for any 9:16 crop
  (degenerates to center rather than an inverted range).
- The adaptive-EMA "decisive but not jittery" transition behavior, directly
  against `asd_engine.smoothing.build_track` with a synthetic hard speaker
  switch.

## Production deploy checklist

1. `pip install -r requirements.txt` (all tiers, or a subset — see above).
2. `python download_weights.py` for the Light-ASD tier. If your network
   can't reach Google Drive, mirror `sfd_face.pth` (Google Drive id
   `1KafnHz7ccT-3IyddBsL5yi2xGtxAKypt`, ~86MB) somewhere reachable and place
   it at `weights/s3fd/sfd_face.pth` yourself.
3. `ffmpeg`/`ffprobe` must be on `PATH` (already a dependency of the Bun
   render pipeline this service feeds).
4. GPU is optional but recommended for throughput on long/many videos — set
   `--device cuda` explicitly if auto-detection picks wrong, otherwise leave
   it on `auto`.
5. Nothing here needs network access at request time — only
   `download_weights.py` (a one-time setup step) touches the network.
6. **Memory scales with `--end - --start`, not with the source video's total
   length**: the Light-ASD tier decodes every analyzed frame into memory at
   once (simplest correct implementation; upstream's own demo does the same
   via its `pyframes/` directory). A 60s window at 1920x960 held ~1500
   decoded frames comfortably in this repo's dev environment; if this is ever
   pointed at multi-minute windows in production, either raise available
   memory or add frame-chunking to `light_asd_pipeline.py` (not needed for
   this service's actual use case of scoring short candidate clips, so not
   implemented). Verified timing: a 60s window took ~129s wall-clock on
   CPU/MPS (no CUDA) in this repo's environment — call this per-tier, not
   per-request, budget for a production capacity plan.
