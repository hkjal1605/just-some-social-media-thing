"""
Vendored (with modifications) from https://github.com/Junhua-Liao/Light-ASD
(MIT License, Copyright (c) 2023 Liao Junhua; see LICENSE in this directory),
itself adapted from https://github.com/cs-giung/face-detection-pytorch.
Original file: model/faceDetector/s3fd/__init__.py.

Modifications from upstream:
  1. Removed the import-time auto-download side effect. Upstream shelled out
     to `gdown` the moment this module was imported, if the weight file
     wasn't already present at a path relative to the process's current
     working directory -- a network call as an import side effect, run
     unconditionally and with failures silently swallowed. Weight fetching is
     now solely download_weights.py's job; this module just requires an
     explicit weights_path and raises a clear FileNotFoundError if it's not
     there yet.
  2. S3FD.__init__ takes `weights_path` explicitly instead of a hardcoded
     `model/faceDetector/s3fd/sfd_face.pth` (relative to CWD).

No changes to the detection math/architecture.
"""
import os

import cv2
import numpy as np
import torch

from .box_utils import nms_
from .nets import S3FDNet

img_mean = np.array([104., 117., 123.])[:, np.newaxis, np.newaxis].astype('float32')


class S3FD():

    def __init__(self, device='cpu', weights_path=None):
        self.device = device
        self.net = S3FDNet(device=self.device).to(self.device)
        if not weights_path or not os.path.isfile(weights_path):
            raise FileNotFoundError(
                f"S3FD weights not found at {weights_path!r} -- run services/asd/download_weights.py"
            )
        state_dict = torch.load(weights_path, map_location=self.device)
        self.net.load_state_dict(state_dict)
        self.net.eval()

    def detect_faces(self, image, conf_th=0.8, scales=[1]):

        w, h = image.shape[1], image.shape[0]

        bboxes = np.empty(shape=(0, 5))

        with torch.no_grad():
            for s in scales:
                scaled_img = cv2.resize(image, dsize=(0, 0), fx=s, fy=s, interpolation=cv2.INTER_LINEAR)

                scaled_img = np.swapaxes(scaled_img, 1, 2)
                scaled_img = np.swapaxes(scaled_img, 1, 0)
                scaled_img = scaled_img[[2, 1, 0], :, :]
                scaled_img = scaled_img.astype('float32')
                scaled_img -= img_mean
                scaled_img = scaled_img[[2, 1, 0], :, :]
                x = torch.from_numpy(scaled_img).unsqueeze(0).to(self.device)
                y = self.net(x)

                detections = y.data
                scale = torch.Tensor([w, h, w, h])

                for i in range(detections.size(1)):
                    j = 0
                    while detections[0, i, j, 0] > conf_th:
                        score = detections[0, i, j, 0]
                        pt = (detections[0, i, j, 1:] * scale).cpu().numpy()
                        bbox = (pt[0], pt[1], pt[2], pt[3], score)
                        bboxes = np.vstack((bboxes, bbox))
                        j += 1

            keep = nms_(bboxes, 0.1)
            bboxes = bboxes[keep]

        return bboxes
