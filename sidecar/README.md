# Auto-align sidecar (Python + OpenCV)

Estimates **similarity transforms** (translation, rotation, uniform scale) so each image lines up with a **reference** image. The app uses **ORB** features, **Hamming** matching, and **RANSAC** (`estimateAffinePartial2D`).

## Setup (Windows / macOS / Linux)

```bash
cd sidecar
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt
```

## Run

```bash
uvicorn main:app --host 127.0.0.1 --port 8765
```

Default URL: `http://127.0.0.1:8765`. Check `GET /health` returns `{"status":"ok"}`.

## Wire the Next.js app

In `.env.local` (same folder as your app, not only `sidecar`):

```
ALIGN_SERVICE_URL=http://127.0.0.1:8765
```

Restart `next dev`. In the editor, use **Auto-align layers (ORB)**. The first layer in the list is the reference frame; `work_width` matches your **Max width** export setting.

## Deploying

Run the sidecar on a private host or in the same VPC as your app; point `ALIGN_SERVICE_URL` at that base URL (no trailing path; the app calls `POST /align`). Do not expose the service publicly without authentication in front of it.
