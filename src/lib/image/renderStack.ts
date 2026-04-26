import { matchExposureToReference } from "./luminance";

export type TransformState = {
  /** pixels from center */
  tx: number;
  ty: number;
  /** degrees */
  rotDeg: number;
  /** 1 = default fit */
  scale: number;
};

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = src;
  });
}

function drawLayerToCanvas(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  t: TransformState,
  outW: number,
  outH: number
) {
  const cx = outW / 2 + t.tx;
  const cy = outH / 2 + t.ty;
  const rad = (t.rotDeg * Math.PI) / 180;
  const s = t.scale;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  ctx.scale(s, s);
  const r = Math.min(outW / iw, outH / ih, 1);
  const dw = iw * r;
  const dh = ih * r;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/**
 * Renders a single layer to ImageData in output dimensions (for accumulation).
 */
export function rasterizeLayer(
  img: HTMLImageElement,
  t: TransformState,
  outW: number,
  outH: number
): ImageData {
  const c = document.createElement("canvas");
  c.width = outW;
  c.height = outH;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return new ImageData(outW, outH);
  }
  ctx.clearRect(0, 0, outW, outH);
  drawLayerToCanvas(ctx, img, t, outW, outH);
  return ctx.getImageData(0, 0, outW, outH);
}

/** Horizontal strip composite: column k of n uses the k-th image (1/n width each, left to right). */
export function buildComposite(
  order: { id: string; img: HTMLImageElement; t: TransformState }[],
  outW: number,
  outH: number,
  options: { exposureToRef: number | null } | null
): ImageData {
  const n = order.length;
  if (n === 0) {
    return new ImageData(outW, outH);
  }

  const out = new ImageData(outW, outH);
  const od = out.data;
  for (let k = 0; k < n; k++) {
    const { img, t } = order[k]!;
    let im = rasterizeLayer(img, t, outW, outH);
    if (options?.exposureToRef != null) {
      im = matchExposureToReference(im, options.exposureToRef).data;
    }
    const src = im.data;
    const x0 = Math.floor((k * outW) / n);
    const x1 = k === n - 1 ? outW : Math.floor(((k + 1) * outW) / n);
    for (let y = 0; y < outH; y++) {
      const row = y * outW * 4;
      for (let x = x0; x < x1; x++) {
        const s = row + x * 4;
        od[s] = src[s]!;
        od[s + 1] = src[s + 1]!;
        od[s + 2] = src[s + 2]!;
        od[s + 3] = 255;
      }
    }
  }
  return out;
}

export function imageDataToPngBlob(data: ImageData): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = data.width;
  c.height = data.height;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("2d context"));
  }
  ctx.putImageData(data, 0, 0);
  return new Promise((res, rej) => {
    c.toBlob(
      (b) => (b ? res(b) : rej(new Error("toBlob"))),
      "image/png",
      1
    );
  });
}
