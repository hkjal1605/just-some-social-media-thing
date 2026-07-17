"""
Vendored (with modifications) from https://github.com/Junhua-Liao/Light-ASD
(MIT License, Copyright (c) 2023 Liao Junhua; see LICENSE in this directory).
Original file: ASD.py.

Modifications from upstream:
  1. __init__ takes a `device` argument and uses `.to(device)` instead of a
     hardcoded `.cuda()` -- upstream only ever ran on a CUDA GPU. This lets
     the model run on CPU or Apple Silicon (MPS) too.
  2. loadParameters passes `map_location=self.device` so a checkpoint saved
     from CUDA tensors can be restored on a machine with no GPU at all
     (upstream's bare `torch.load(path)` raises RuntimeError in that case).
  3. Dropped train_network/evaluate_network (AVA-CSV training/eval-only code
     that pulled in pandas plus a separate eval script we don't need for
     inference) and the stdout print in __init__ (this service's CLI
     contract reserves stdout for a single JSON summary line -- see
     services/asd/detect.py).

No changes to the model architecture, math, or the meaning of the pretrained
weights.
"""
import sys

import torch
import torch.nn as nn

from loss import lossAV, lossV
from model.Model import ASD_Model


class ASD(nn.Module):
    def __init__(self, lr=0.001, lrDecay=0.95, device="cpu", **kwargs):
        super(ASD, self).__init__()
        self.device = device
        self.model = ASD_Model().to(device)
        self.lossAV = lossAV().to(device)
        self.lossV = lossV().to(device)
        self.optim = torch.optim.Adam(self.parameters(), lr=lr)
        self.scheduler = torch.optim.lr_scheduler.StepLR(self.optim, step_size=1, gamma=lrDecay)

    def saveParameters(self, path):
        torch.save(self.state_dict(), path)

    def loadParameters(self, path):
        selfState = self.state_dict()
        loadedState = torch.load(path, map_location=self.device)
        for name, param in loadedState.items():
            origName = name
            if name not in selfState:
                name = name.replace("module.", "")
                if name not in selfState:
                    sys.stderr.write("%s is not in the model.\n" % origName)
                    continue
            if selfState[name].size() != loadedState[origName].size():
                sys.stderr.write(
                    "Wrong parameter length: %s, model: %s, loaded: %s\n"
                    % (origName, selfState[name].size(), loadedState[origName].size())
                )
                continue
            selfState[name].copy_(param)
