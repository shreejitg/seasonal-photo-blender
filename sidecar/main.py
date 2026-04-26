"""
Auto-align: left column = reference (ref_index, default 0).

Pipeline per layer: optional phase correlation (translation prior on CLAHE) →
SIFT+ORB on *structure* images (CLAHE + edges; lighting-invariant) → RANSAC similarity
→ optional ECC on gradient magnitudes in the bottom 75% of the frame (ignore sky) to
snap horizons/buildings, then project affine → similarity. Wider tx/ty caps vs fixed px.
"""
from __future__ import annotations

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

MIN_INLIERS = 8
RANSAC_THRESH = 3.0
MAX_MATCHES = 8000
RATIO = 0.75
# Higher = finer keypoints for tall scenes (e.g. skyscrapers + distant bridge)
KEYPOINT_MAX_SIDE = 1000
ORB_FEATURES = 5000
# Phase correlation on downsampled structure (rough translation when lighting differs a lot)
PHASE_MAX_SIDE = 512
# ECC refinement: only accept if gradient-L1 improves vs RANSAC init
ECC_WORST_FACTOR = 1.03


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
    M is 2x3, mapping src (other) -> dst (ref), similarity or near-similarity.
    """
    a, b, tx_cv = float(m[0, 0]), float(m[0, 1]), float(m[0, 2])
    c, d, ty_cv = float(m[1, 0]), float(m[1, 1]), float(m[1, 2])
    s = math.hypot(a, c)
    if s < 1e-6:
        s = 1.0
    rot_rad = math.atan2(c, a)
    rot_deg = math.degrees(rot_rad)

    cx, cy = out_w / 2.0, out_h / 2.0
    cos, sin_ = a / s, c / s
    t_edit_x = tx_cv - cx + s * (cos * cx - sin_ * cy)
    t_edit_y = ty_cv - cy + s * (sin_ * cx + cos * cy)

    return {
        "tx": float(t_edit_x),
        "ty": float(t_edit_y),
        "rotDeg": float(rot_deg),
        "scale": float(s),
    }


def affine_2x3_to_similarity(w: np.ndarray) -> np.ndarray:
    """Project 2x2 to uniform scale * rotation; keep third column (ECC affine → editor)."""
    a, b, e = float(w[0, 0]), float(w[0, 1]), float(w[0, 2])
    c, d, f = float(w[1, 0]), float(w[1, 1]), float(w[1, 2])
    s0 = math.hypot(a, c)
    s1 = math.hypot(b, d)
    s = 0.5 * (s0 + s1) if s0 + s1 > 1e-6 else 1.0
    th = math.atan2(c, a)
    co, sn = math.cos(th), math.sin(th)
    return np.array(
        [[s * co, -s * sn, e], [s * sn, s * co, f]], dtype=np.float64
    )


def structure_u8(gray: np.ndarray) -> np.ndarray:
    """Edges + local contrast: more stable than raw gray across season / exposure."""
    if gray.size == 0:
        return gray
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    c = clahe.apply(gray)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    g = cv2.magnitude(gx, gy)
    gmax = float(g.max()) or 1.0
    g8 = (255.0 * (g / gmax)).clip(0, 255).astype(np.uint8)
    lap = cv2.Laplacian(gray, cv2.CV_32F)
    lap = np.abs(lap)
    lmax = float(lap.max()) or 1.0
    l8 = (255.0 * (lap / lmax)).clip(0, 255).astype(np.uint8)
    a = cv2.addWeighted(c, 0.45, g8, 0.35, 0)
    return cv2.addWeighted(a, 0.88, l8, 0.12, 0)


def _resize_max_side(gray: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = gray.shape[:2]
    m = max(h, w, 1)
    if m <= max_side:
        return gray, 1.0
    s = max_side / float(m)
    nw, nh = int(round(w * s)), int(round(h * s))
    out = cv2.resize(gray, (nw, nh), interpolation=cv2.INTER_AREA)
    return out, 1.0 / s


def _match_sift(
    s_ref: np.ndarray, s_oth: np.ndarray, s_back: float
) -> tuple[np.ndarray | None, np.ndarray | None, str]:
    det = cv2.SIFT_create(
        nfeatures=8000, contrastThreshold=0.02, edgeThreshold=12, sigma=1.4
    )
    k0, d0 = det.detectAndCompute(s_ref, None)
    k1, d1 = det.detectAndCompute(s_oth, None)
    if d0 is None or d1 is None or len(k0) < 4 or len(k1) < 4:
        return None, None, "insufficient SIFT"
    bf = cv2.BFMatcher(cv2.NORM_L2, crossCheck=False)
    raw = bf.knnMatch(d0, d1, k=2)
    good: list = []
    for x in raw:
        if len(x) < 2:
            continue
        m, n = x[0], x[1]
        if m.distance < RATIO * n.distance:
            good.append(m)
    good = sorted(good, key=lambda m: m.distance)[:MAX_MATCHES]
    if len(good) < 4:
        return None, None, "insufficient SIFT matches"
    src = np.float32([k1[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([k0[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    if s_back != 1.0:
        src *= s_back
        dst *= s_back
    return src, dst, "ok"


def _match_orb(
    s_ref: np.ndarray, s_oth: np.ndarray, s_back: float
) -> tuple[np.ndarray | None, np.ndarray | None, str]:
    det = cv2.ORB_create(nfeatures=ORB_FEATURES, scaleFactor=1.2, nlevels=8)
    k0, d0 = det.detectAndCompute(s_ref, None)
    k1, d1 = det.detectAndCompute(s_oth, None)
    if d0 is None or d1 is None or len(k0) < 4 or len(k1) < 4:
        return None, None, "insufficient ORB"
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    raw = bf.knnMatch(d0, d1, k=2)
    good: list = []
    for x in raw:
        if len(x) < 2:
            continue
        m, n = x[0], x[1]
        if m.distance < RATIO * n.distance:
            good.append(m)
    good = sorted(good, key=lambda m: m.distance)[:MAX_MATCHES]
    if len(good) < 4:
        return None, None, "insufficient ORB matches"
    src = np.float32([k1[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([k0[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    if s_back != 1.0:
        src *= s_back
        dst *= s_back
    return src, dst, "ok"


def _dedupe_point_pairs(
    src: np.ndarray, dst: np.ndarray, q: float = 0.5
) -> tuple[np.ndarray, np.ndarray]:
    if src is None or len(src) < 1:
        return src, dst
    seen: set[tuple[float, float, float, float]] = set()
    keep_s: list = []
    keep_d: list = []
    for i in range(len(src)):
        sx, sy = float(src[i, 0, 0]), float(src[i, 0, 1])
        dx, dy = float(dst[i, 0, 0]), float(dst[i, 0, 1])
        key = (round(sx / q) * q, round(sy / q) * q, round(dx / q) * q, round(dy / q) * q)
        if key in seen:
            continue
        seen.add(key)
        keep_s.append(src[i : i + 1])
        keep_d.append(dst[i : i + 1])
    if not keep_s:
        return src, dst
    return np.vstack(keep_s), np.vstack(keep_d)


def _collect_matches_resized(
    gray_ref: np.ndarray, gray_oth: np.ndarray, s_back: float
) -> tuple[np.ndarray | None, np.ndarray | None, str]:
    """
    Merge SIFT/ORB on structure (edges + CLAHE) and plain CLAHE to survive
    strong lighting changes (snow vs sun vs overcast on the same scene).
    """
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    c_ref = clahe.apply(gray_ref)
    c_oth = clahe.apply(gray_oth)
    st_ref = structure_u8(gray_ref)
    st_oth = structure_u8(gray_oth)
    all_src: list[np.ndarray] = []
    all_dst: list[np.ndarray] = []
    for a, b in (st_ref, st_oth), (c_ref, c_oth):
        s, d, re = _match_sift(a, b, s_back)
        if s is not None and d is not None:
            all_src.append(s)
            all_dst.append(d)
    s, d, re = _match_orb(st_ref, st_oth, s_back)
    if s is not None and d is not None:
        all_src.append(s)
        all_dst.append(d)
    if not all_src:
        return None, None, "no SIFT/ORB on structure or CLAHE"
    src = np.vstack(all_src)
    dst = np.vstack(all_dst)
    src, dst = _dedupe_point_pairs(src, dst)
    if len(src) < 4:
        return None, None, f"insufficient unique matches ({len(src)})"
    return src, dst, "ok"


def refine_ecc_on_gradient(
    gray_ref: np.ndarray,
    gray_oth: np.ndarray,
    m_init: np.ndarray,
) -> np.ndarray:
    """
    Affine ECC on **gradient magnitudes** with a bottom mask (ignore sky, weight buildings / horizon).
    """
    h, w = gray_ref.shape[:2]
    gx0 = cv2.Sobel(gray_ref, cv2.CV_32F, 1, 0, ksize=3)
    gy0 = cv2.Sobel(gray_ref, cv2.CV_32F, 0, 1, ksize=3)
    m0 = cv2.magnitude(gx0, gy0)
    gx1 = cv2.Sobel(gray_oth, cv2.CV_32F, 1, 0, ksize=3)
    gy1 = cv2.Sobel(gray_oth, cv2.CV_32F, 0, 1, ksize=3)
    m1 = cv2.magnitude(gx1, gy1)
    for g in (m0, m1):
        mx = float(g.max()) or 1.0
        g *= 1.0 / mx
    y0 = int(0.12 * h)
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[y0:, :] = 255
    w0 = m_init.astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 120, 1e-6)

    def l1err(M2: np.ndarray) -> float:
        w1 = cv2.warpAffine(
            m1, M2.astype(np.float32), (w, h), borderValue=0.0, flags=cv2.INTER_LINEAR
        )
        return float(np.sum(np.abs(m0 - w1) * (mask > 0)))

    e0 = l1err(w0)
    try:
        _, w_aff = cv2.findTransformECC(
            m0,
            m1,
            w0,
            cv2.MOTION_AFFINE,
            crit,
            inputMask=mask,
            gaussFiltSize=5,
        )
    except (cv2.error, ValueError, TypeError):
        return m_init
    w_aff = np.asarray(w_aff, dtype=np.float64)
    m_s = affine_2x3_to_similarity(w_aff)
    e1 = l1err(m_s)
    if e1 < e0 * ECC_WORST_FACTOR:
        return m_s
    return m_init


def _clamp_to_editor(t: dict[str, float], out_w: int, out_h: int) -> dict[str, float]:
    lim_x = max(600.0, 0.3 * out_w)
    lim_y = max(700.0, 0.38 * out_h)
    t["scale"] = max(0.2, min(3.0, t["scale"]))
    t["rotDeg"] = max(-45.0, min(45.0, t["rotDeg"]))
    t["tx"] = max(-lim_x, min(lim_x, t["tx"]))
    t["ty"] = max(-lim_y, min(lim_y, t["ty"]))
    return t


def align_pair_to_ref(
    gray_ref: np.ndarray,
    gray_other: np.ndarray,
    out_w: int,
    out_h: int,
) -> tuple[dict[str, float] | None, int, str]:
    s_ref, s_back = _resize_max_side(gray_ref, KEYPOINT_MAX_SIDE)
    s_oth, _ = _resize_max_side(gray_other, KEYPOINT_MAX_SIDE)

    src_pts, dst_pts, reason = _collect_matches_resized(s_ref, s_oth, s_back)
    if src_pts is None or dst_pts is None:
        return None, 0, reason

    m_est, inliers = cv2.estimateAffinePartial2D(
        src_pts,
        dst_pts,
        method=cv2.RANSAC,
        ransacReprojThreshold=RANSAC_THRESH,
        maxIters=5000,
        confidence=0.999,
    )
    if m_est is None:
        return None, 0, "RANSAC failed"
    inlier_count = int(inliers.sum()) if inliers is not None else 0
    if inlier_count < MIN_INLIERS:
        return None, inlier_count, f"only {inlier_count} inliers (need {MIN_INLIERS})"

    m_final = refine_ecc_on_gradient(gray_ref, gray_other, m_est)
    t = decompose_to_editor(m_final, out_w, out_h)
    t = _clamp_to_editor(t, out_w, out_h)
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
    href, wref = bgrs[ref_i].shape[:2]
    ar = href / max(wref, 1)
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
            transforms.append({**t, "inliers": n_inl, "note": "aligned"})

    return JSONResponse(
        {
            "ok": True,
            "out_w": out_w,
            "out_h": out_h,
            "ref_index": ref_i,
            "transforms": transforms,
        }
    )
