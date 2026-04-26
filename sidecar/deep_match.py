"""
LoFTR (Kornia) dense correspondence → point pairs for RANSAC.

Optional: if torch/kornia are missing, `match_loftr` returns (None, None, reason) and
main.py falls back to SIFT+ORB. Disable with env SPB_USE_LOFTR=0.
"""
from __future__ import annotations

import os

import cv2
import numpy as np

_LOFTR_IMPORT_OK = False
try:  # pragma: no cover - import guard for minimal installs
    import torch
    from kornia.feature import LoFTR  # type: ignore[import-not-found]

    _LOFTR_IMPORT_OK = True
except ImportError:
    torch = None  # type: ignore[assignment, misc]
    LoFTR = None  # type: ignore[assignment, misc]

_LOFTR_MODEL: object | None = None

# Long side of LoFTR input; larger = better but slower + more RAM (CPU ok, GPU faster).
LOFTR_MAX_SIDE = 840
LOFTR_CONF_MIN = 0.12
LOFTR_MAX_PAIRS = 5000
RNG = np.random.default_rng(42)


def loftr_import_ok() -> bool:
    return _LOFTR_IMPORT_OK


def loftr_enabled() -> bool:
    return _LOFTR_IMPORT_OK and os.environ.get("SPB_USE_LOFTR", "1") != "0"


def get_loftr() -> object | None:
    """Lazy-load once (downloads weights on first use)."""
    global _LOFTR_MODEL
    if not loftr_enabled():
        return None
    if _LOFTR_MODEL is None and LoFTR is not None and torch is not None:
        _LOFTR_MODEL = LoFTR(pretrained="outdoor")
        _LOFTR_MODEL = _LOFTR_MODEL.eval()  # type: ignore[union-attr]
    return _LOFTR_MODEL


def match_loftr(
    gray_ref: np.ndarray,
    gray_oth: np.ndarray,
) -> tuple[np.ndarray | None, np.ndarray | None, str]:
    """
    Match other → ref using LoFTR on resized grayscale.
    Returns (src Nx1x2, dst Nx1x2) in **full-resolution** pixel coordinates:
    src = points in *other* image, dst = corresponding points in *ref* (OpenCV RANSAC convention).
    """
    model = get_loftr()
    if model is None:
        return None, None, "LoFTR disabled or not installed"

    if gray_ref.shape != gray_oth.shape:
        return None, None, "LoFTR: ref/other shape mismatch"

    h0, w0 = gray_ref.shape[:2]
    if h0 < 8 or w0 < 8:
        return None, None, "image too small"

    scale = LOFTR_MAX_SIDE / max(h0, w0, 1)
    nw = int(round(w0 * scale))
    nh = int(round(h0 * scale))
    nw = max(nw, 8)
    nh = max(nh, 8)

    r0 = cv2.resize(gray_ref, (nw, nh), interpolation=cv2.INTER_AREA)
    r1 = cv2.resize(gray_oth, (nw, nh), interpolation=cv2.INTER_AREA)
    t0 = torch.from_numpy(r0).float().div_(255.0).unsqueeze(0).unsqueeze(0)  # type: ignore[union-attr]
    t1 = torch.from_numpy(r1).float().div_(255.0).unsqueeze(0).unsqueeze(0)  # type: ignore[union-attr]

    try:
        with torch.inference_mode():  # type: ignore[union-attr]
            out = model({"image0": t0, "image1": t1})  # type: ignore[operator, misc]
    except (RuntimeError, Exception) as e:  # pragma: no cover
        return None, None, f"LoFTR inference: {e!s}"

    k0 = out["keypoints0"].cpu().numpy()
    k1 = out["keypoints1"].cpu().numpy()
    conf = out.get("confidence")
    if conf is not None:
        conf = conf.cpu().numpy()
        m = conf >= LOFTR_CONF_MIN
        k0, k1 = k0[m], k1[m]

    n = len(k0)
    if n < 4:
        return None, None, f"LoFTR too few matches ({n})"
    if n > LOFTR_MAX_PAIRS:
        pick = RNG.choice(n, size=LOFTR_MAX_PAIRS, replace=False)
        k0, k1 = k0[pick], k1[pick]

    sx = w0 / float(nw)
    sy = h0 / float(nh)
    k0 = k0.astype(np.float64)
    k1 = k1.astype(np.float64)
    k0[:, 0] *= sx
    k0[:, 1] *= sy
    k1[:, 0] *= sx
    k1[:, 1] *= sy

    # src = other, dst = ref
    src = k1.reshape(-1, 1, 2).astype(np.float32)
    dst = k0.reshape(-1, 1, 2).astype(np.float32)
    return src, dst, "ok"
