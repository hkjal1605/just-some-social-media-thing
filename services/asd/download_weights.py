#!/usr/bin/env python3
"""Fetch pretrained weights for the Light-ASD detection tier.

    python services/asd/download_weights.py [--force] [--skip-s3fd]

Downloads two files into services/asd/weights/ (gitignored -- binaries don't
belong in git history):

  weights/light_asd/finetuning_TalkSet.model  (~4MB)
      The Light-ASD model, fine-tuned on TalkSet. Stored directly in the
      upstream GitHub repo (no LFS, no auth), so this is a plain HTTPS GET.

  weights/s3fd/sfd_face.pth  (~86MB)
      The S3FD face-detector backbone Light-ASD relies on for finding faces
      before scoring who's speaking. Hosted on Google Drive by upstream (see
      third_party/light_asd/model/faceDetector/s3fd/__init__.py's docstring)
      rather than committed to GitHub, so this needs `gdown`.

Both files are optional at runtime: if either is missing, detect.py's
Light-ASD tier simply reports itself unavailable and the CLI falls back to
face-only detection (see README.md). Run this script once during deploy
setup; there's nothing to re-run afterwards unless you pass --force.
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_DIR = os.path.join(HERE, "weights")

LIGHT_ASD_WEIGHTS_URL = "https://raw.githubusercontent.com/Junhua-Liao/Light-ASD/main/weight/finetuning_TalkSet.model"
LIGHT_ASD_WEIGHTS_DEST = os.path.join(WEIGHTS_DIR, "light_asd", "finetuning_TalkSet.model")

S3FD_GDRIVE_ID = "1KafnHz7ccT-3IyddBsL5yi2xGtxAKypt"
S3FD_WEIGHTS_DEST = os.path.join(WEIGHTS_DIR, "s3fd", "sfd_face.pth")


def _download(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    print(f"downloading {url}\n  -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    total = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
    os.replace(tmp, dest)
    print(f"  done ({total / 1e6:.1f} MB)")


def fetch_light_asd_weights(force: bool) -> bool:
    if os.path.isfile(LIGHT_ASD_WEIGHTS_DEST) and not force:
        print(f"already have {LIGHT_ASD_WEIGHTS_DEST} (use --force to re-download)")
        return True
    try:
        _download(LIGHT_ASD_WEIGHTS_URL, LIGHT_ASD_WEIGHTS_DEST)
        return True
    except Exception as err:
        print(f"FAILED to download Light-ASD weights: {err}", file=sys.stderr)
        print(f"  manual fallback: curl -L {LIGHT_ASD_WEIGHTS_URL} -o {LIGHT_ASD_WEIGHTS_DEST}", file=sys.stderr)
        return False


def fetch_s3fd_weights(force: bool) -> bool:
    if os.path.isfile(S3FD_WEIGHTS_DEST) and not force:
        print(f"already have {S3FD_WEIGHTS_DEST} (use --force to re-download)")
        return True
    os.makedirs(os.path.dirname(S3FD_WEIGHTS_DEST), exist_ok=True)
    try:
        import gdown  # optional dependency; see requirements.txt
    except ImportError:
        print("gdown not installed -- install it (`pip install gdown`) or fetch manually:", file=sys.stderr)
        print(f"  gdown --id {S3FD_GDRIVE_ID} -O {S3FD_WEIGHTS_DEST}", file=sys.stderr)
        print(f"  (or open https://drive.google.com/uc?id={S3FD_GDRIVE_ID} in a browser)", file=sys.stderr)
        return False
    try:
        print(f"downloading S3FD weights (Google Drive id {S3FD_GDRIVE_ID})\n  -> {S3FD_WEIGHTS_DEST}")
        gdown.download(id=S3FD_GDRIVE_ID, output=S3FD_WEIGHTS_DEST, quiet=False)
        if not os.path.isfile(S3FD_WEIGHTS_DEST):
            raise RuntimeError("gdown reported success but the output file is missing")
        return True
    except Exception as err:
        print(f"FAILED to download S3FD weights via gdown: {err}", file=sys.stderr)
        print(f"  manual fallback: gdown --id {S3FD_GDRIVE_ID} -O {S3FD_WEIGHTS_DEST}", file=sys.stderr)
        print(f"  (or open https://drive.google.com/uc?id={S3FD_GDRIVE_ID} in a browser)", file=sys.stderr)
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="re-download even if the file already exists")
    parser.add_argument(
        "--skip-s3fd", action="store_true",
        help="skip the S3FD face-detector weights (e.g. if Google Drive is unreachable from this network)",
    )
    args = parser.parse_args()

    ok_light_asd = fetch_light_asd_weights(args.force)
    ok_s3fd = True if args.skip_s3fd else fetch_s3fd_weights(args.force)

    print()
    if ok_light_asd and ok_s3fd:
        print("done -- both weight files are in place. detect.py will use the Light-ASD tier.")
        return 0
    print("one or more downloads failed or were skipped -- detect.py will still run correctly,")
    print("it just falls back to face-only detection until both files are present.")
    return 0 if (ok_light_asd and args.skip_s3fd) else 1


if __name__ == "__main__":
    sys.exit(main())
