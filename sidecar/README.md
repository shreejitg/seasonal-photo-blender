# Auto-align sidecar (Python)

Estimates a **global similarity** (translation, rotation, uniform scale) from each *other* image to the **reference** (left column in the app). The app receives `tx`, `ty`, `rotDeg`, `scale` and applies them in the editor.

## What runs here

1. **LoFTR** (Kornia) on grayscale pairs, when `torch` and `kornia` import successfully and `SPB_USE_LOFTR` is not `0` — see `deep_match.py`. First run can **download** outdoor weights.
2. If that is skipped or returns too few points, **SIFT** + **ORB** on “structure” + CLAHE images (`main.py`).
3. **RANSAC** `estimateAffinePartial2D` (partial affine = similarity) on correspondences.
4. Optional **ECC** on gradient magnitudes (sky area masked) + projection to similarity + conversion to editor parameters.

`GET /health` returns `status`, and whether **LoFTR** is importable and enabled: `loftr`, `loftr_enabled`.

Set **`SPB_USE_LOFTR=0`** in the environment to force the classic SIFT+ORB path only (e.g. to debug or avoid torch).

## Setup (Windows / macOS / Linux)

```bash
cd sidecar
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

`requirements.txt` includes **PyTorch** and **Kornia** (large download) and **certifi** (so `torch.hub` can download LoFTR weights on Windows with a proper CA bundle). If you need to avoid them temporarily, you could maintain a local env without `torch`/`kornia`; the app will then use SIFT+ORB only.

### `SSL: CERTIFICATE_VERIFY_FAILED` when LoFTR downloads weights

1. Run `pip install certifi` (already in `requirements.txt`) and **restart the sidecar** so the process picks up the updated `deep_match` SSL setup.
2. If it still fails: on Windows, run the **“Install certificates”** script that ships with the Python.org installer, or set `SSL_CERT_FILE` to your org’s root CA.
3. If LoFTR init fails, alignment **automatically uses SIFT+ORB**; `GET /health` includes `loftr_init_error` with the last error message. To force SIFT+ORB only, set `SPB_USE_LOFTR=0`.

### If `pip install` tries to **compile** numpy (Meson, no compiler on Windows)

1. This repo uses **numpy 2.1+** (wheels for Python 3.13 on win_amd64). Upgrade pip: `python -m pip install --upgrade pip`.
2. To **force** wheels only: `pip install --only-binary :all: -r requirements.txt`

## Run

```bash
uvicorn main:app --host 127.0.0.1 --port 8765
```

Default: `http://127.0.0.1:8765` — `GET /health` should report `"status": "ok"`. On CPU, the first request that runs LoFTR may be slow while weights load.

## Wire the Next.js app

In `.env.local` at the **Next.js project root** (not only this folder):

```
ALIGN_SERVICE_URL=http://127.0.0.1:8765
```

Restart `next dev` (or use `npm run dev:all` from the repo root to start both processes).

## Deploying

Run the sidecar on a private host or the same private network as your app; set `ALIGN_SERVICE_URL` to that base URL. Do not expose the align service to the public internet without additional authentication in front of it.
