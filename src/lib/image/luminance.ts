/** Simple sRGB → perceived luminance (0–1), per pixel. */
export function meanLuminanceFromImageData(data: ImageData): number {
  const d = data.data;
  const n = data.width * data.height;
  if (n === 0) return 0.5;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]! / 255;
    const g = d[i + 1]! / 255;
    const b = d[i + 2]! / 255;
    s += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return s / n;
}

export function applyGlobalGain(
  data: ImageData,
  gain: number,
  offset = 0
): void {
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, Math.max(0, d[i]! * gain + offset));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1]! * gain + offset));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2]! * gain + offset));
  }
}

export function matchExposureToReference(
  data: ImageData,
  refMean: number
): {
  data: ImageData;
  beforeMean: number;
} {
  const copy = new ImageData(
    new Uint8ClampedArray(data.data),
    data.width,
    data.height
  );
  const before = meanLuminanceFromImageData(copy);
  if (before < 1e-4) {
    return { data: copy, beforeMean: before };
  }
  const gain = refMean / before;
  applyGlobalGain(copy, gain);
  return { data: copy, beforeMean: before };
}

/** Per-channel mean & stdev in 0–255 space (for simple appearance matching). */
export type PerChannelStats = {
  mean: [number, number, number];
  std: [number, number, number];
};

const MIN_CH_STD = 1.5;
const MAX_SCALE_RATIO = 2.4;

export function perChannelStatsFromImageData(data: ImageData): PerChannelStats {
  const w = data.width;
  const h = data.height;
  const d = data.data;
  const n = w * h;
  if (n === 0) {
    return { mean: [128, 128, 128], std: [40, 40, 40] };
  }
  const inv = 1 / n;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < d.length; i += 4) {
    sr += d[i]!;
    sg += d[i + 1]!;
    sb += d[i + 2]!;
  }
  const mr = sr * inv;
  const mg = sg * inv;
  const mb = sb * inv;
  let vr = 0;
  let vg = 0;
  let vb = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i]! - mr;
    const dg = d[i + 1]! - mg;
    const db = d[i + 2]! - mb;
    vr += dr * dr;
    vg += dg * dg;
    vb += db * db;
  }
  return {
    mean: [mr, mg, mb],
    std: [
      Math.sqrt(vr * inv) + 1e-6,
      Math.sqrt(vg * inv) + 1e-6,
      Math.sqrt(vb * inv) + 1e-6,
    ],
  };
}

/**
 * Match each R/G/B channel to the reference: same mean and std (brightness, contrast, color).
 * The reference image applied to its own stats is a no-op. Very flat regions: gain is capped.
 */
export function matchAppearanceToReference(
  data: ImageData,
  ref: PerChannelStats
): ImageData {
  const copy = new ImageData(
    new Uint8ClampedArray(data.data),
    data.width,
    data.height
  );
  const src = perChannelStatsFromImageData(copy);
  const d = copy.data;
  for (let c = 0; c < 3; c++) {
    const ssd = Math.max(src.std[c]!, MIN_CH_STD);
    const rsd = ref.std[c]!;
    const sm = src.mean[c]!;
    const rm = ref.mean[c]!;
    const scale = Math.min(MAX_SCALE_RATIO, rsd / ssd);
    for (let i = 0; i < d.length; i += 4) {
      const j = i + c;
      d[j] = Math.min(255, Math.max(0, (d[j]! - sm) * scale + rm));
    }
  }
  return copy;
}
