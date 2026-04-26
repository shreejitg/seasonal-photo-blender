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
