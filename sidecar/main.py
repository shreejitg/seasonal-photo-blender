"""
Auto-align: ORB + BFMatcher + RANSAC (estimateAffinePartial2D) to estimate a
similarity transform of each image onto a reference, then map to {tx, ty, rotDeg, scale}.

Layout matches the app: all images are letterboxed into a common WxH, same as buildComposite
aspect (from the first / reference image frame).
"""
from __future__ import annotations

import io
import math
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI(title="season-photo-align")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MIN_INLIERS = 10
RANSAC_THRESH = 4.0
MAX_MATCHES = 4000
ORB_FEATURES = 3000
RATIO = 0.75


def letterbox_to_canvas(bgr: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Match drawLayerToCanvas: r = min(outW/iw, outH/ih, 1), centered, transparent→black."""
    h, w = bgr.shape[:2]
    if w <= 0 or h <= 0:
        return np.zeros((out_h, out_w, 3), dtype=np.uint8)
    r = min(out_w / w, out_h / h, 1.0)
    dw = int(round(w * r))
    dh = int(round(h * r))
    small = cv2.resize(bgr, (dw, dh), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    x0 = (out_w - dw) // 2
    y0 = (out_h - dh) // 2
    canvas[y0 : y0 + dh, x0 : x0 + dw] = small
    return canvas


def decompose_to_editor(
    m: np.ndarray, out_w: int, out_h: int
) -> dict[str, float]:
    """
    M is 2x3 similarity part from cv2, mapping src (other) pixel coords to dst (ref) coords.
    We emit tx,ty as offsets in *output* space (same convention as the React editor: from canvas center),
    and rotDeg, scale for the same layer.
    """
    a, b, tx_cv = float(m[0, 0]), float(m[0, 1]), float(m[0, 2])
    c, d, ty_cv = float(m[1, 0]), float(m[1, 1]), float(m[1, 2])
    s = math.hypot(a, c)
    if s < 1e-6:
        s = 1.0
    rot_rad = math.atan2(c, a)
    rot_deg = math.degrees(rot_rad)

    # Our editor translates by (tx,ty) *after* moving origin to (outW/2, outH/2).
    # OpenCV's partial affine is about the image origin (0,0). Map translation so that
    # rotation+scale is effectively about the canvas center, matching translate(cx+tx) in the app.
    cx, cy = out_w / 2.0, out_h / 2.0
    cos, sin_ = a / s, c / s
    # p_ref = s*R * p + t_cv (top-left). Pivot at center: p' = s*R*(p-c) + c + t_edit
    # => t_edit = t_cv - c + s*R @ c
    t_edit_x = tx_cv - cx + s * (cos * cx - sin_ * cy)
    t_edit_y = ty_cv - cy + s * (sin_ * cx + cos * cy)

    return {
        "tx": float(t_edit_x),
        "ty": float(t_edit_y),
        "rotDeg": float(rot_deg),
        "scale": float(s),
    }


def _resize_max_side(gray: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = gray.shape[:2]
    m = max(h, w, 1)
    if m <= max_side:
        return gray, 1.0
    s = max_side / float(m)
    nw, nh = int(round(w * s)), int(round(h * s))
    out = cv2.resize(gray, (nw, nh), interpolation=cv2.INTER_AREA)
    return out, 1.0 / s  # mul back = scale to full res


def align_pair_to_ref(
    gray_ref: np.ndarray,
    gray_other: np.ndarray,
    out_w: int,
    out_h: int,
) -> tuple[dict[str, float] | None, int, str]:
    s_ref, s_back = _resize_max_side(gray_ref, 500)
    s_oth, _ = _resize_max_side(gray_other, 500)

    det = cv2.ORB_create(nfeatures=ORB_FEATURES, scaleFactor=1.2, nlevels=8)
    k0, d0 = det.detectAndCompute(s_ref, None)
    k1, d1 = det.detectAndCompute(s_oth, None)
    if d0 is None or d1 is None or len(k0) < 4 or len(k1) < 4:
        return None, 0, "insufficient keypoints"

    # Match ref (query) to other (train): query=ref, train=other
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    raw = bf.knnMatch(d0, d1, k=2)
    good = []
    for x in raw:
        if len(x) < 2:
            continue
        m, n = x[0], x[1]
        if m.distance < RATIO * n.distance:
            good.append(m)
    good = sorted(good, key=lambda m: m.distance)[:MAX_MATCHES]
    if len(good) < 4:
        return None, 0, "insufficient good matches"

    # estimateAffinePartial2D: from src (other) to dst (ref)
    src_pts = np.float32([k1[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    dst_pts = np.float32([k0[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    if s_back != 1.0:
        src_pts = src_pts * s_back
        dst_pts = dst_pts * s_back

    m_est, inliers = cv2.estimateAffinePartial2D(
        src_pts,
        dst_pts,
        method=cv2.RANSAC,
        ransacReprojThreshold=RANSAC_THRESH,
        maxIters=2000,
        confidence=0.99,
    )
    if m_est is None:
        return None, 0, "RANSAC failed"
    inlier_count = int(inliers.sum()) if inliers is not None else 0
    if inlier_count < MIN_INLIERS:
        return None, inlier_count, f"only {inlier_count} inliers (need {MIN_INLIERS})"

    t = decompose_to_editor(m_est, out_w, out_h)
    t["scale"] = max(0.2, min(3.0, t["scale"]))
    t["rotDeg"] = max(-45.0, min(45.0, t["rotDeg"]))
    t["tx"] = max(-200.0, min(200.0, t["tx"]))
    t["ty"] = max(-200.0, min(200.0, t["ty"]))
    return t, inlier_count, "ok"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/align")
async def align(
    ref_index: int = Form(0, ge=0),
    work_width: int = Form(800, ge=200, le=5000),
    files: list[UploadFile] = File(...),
) -> JSONResponse:
    if not files:
        return JSONResponse(
            status_code=400, content={"ok": False, "error": "no files"}
        )
    bgrs: list[np.ndarray] = []
    for f in files:
        raw = await f.read()
        arr = np.frombuffer(raw, dtype=np.uint8)
        im = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if im is None:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": f"decode failed: {f.filename}"},
            )
        bgrs.append(im)

    ref_i = min(ref_index, len(bgrs) - 1)
    h0, w0 = bgrs[0].shape[:2]
    ar = h0 / max(w0, 1)
    out_w = int(work_width)
    out_h = max(1, int(round(out_w * ar)))

    canvases = [letterbox_to_canvas(b, out_w, out_h) for b in bgrs]
    grays = [cv2.cvtColor(c, cv2.COLOR_BGR2GRAY) for c in canvases]

    transforms: list[dict[str, Any]] = []
    for i, _ in enumerate(bgrs):
        if i == ref_i:
            transforms.append(
                {
                    "tx": 0.0,
                    "ty": 0.0,
                    "rotDeg": 0.0,
                    "scale": 1.0,
                    "inliers": None,
                    "note": "reference",
                }
            )
            continue
        t, n_inl, reason = align_pair_to_ref(grays[ref_i], grays[i], out_w, out_h)
        if t is None:
            transforms.append(
                {
                    "tx": 0.0,
                    "ty": 0.0,
                    "rotDeg": 0.0,
                    "scale": 1.0,
                    "inliers": 0,
                    "error": reason,
                }
            )
        else:
            transforms.append(
                {**t, "inliers": n_inl, "note": "aligned"}
            )

    return JSONResponse(
        {
            "ok": True,
            "out_w": out_w,
            "out_h": out_h,
            "ref_index": ref_i,
            "transforms": transforms,
        }
    )
