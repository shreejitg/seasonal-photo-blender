"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Classifier = any;

let classifierLoad: Promise<Classifier> | null = null;

/**
 * Load CLIP only on demand (dynamic import) so Next/Turbopack does not execute
 * @xenova/transformers at module top level — that can throw Object.keys on null in the client bundle.
 */
export function isClipModelLoading() {
  return !!classifierLoad;
}

/**
 * Returns the zero-shot classifier, downloading weights on first use.
 */
export async function getClipClassifier(
  onProgress?: (f: { progress: number }) => void
): Promise<Classifier> {
  if (!classifierLoad) {
    classifierLoad = (async () => {
      const { env, pipeline } = await import("@xenova/transformers");
      if (env) {
        env.allowLocalModels = false;
        env.useBrowserCache = true;
      }
      return (await pipeline(
        "zero-shot-image-classification",
        "Xenova/clip-vit-base-patch32",
        { progress_callback: onProgress }
      )) as Classifier;
    })();
  }
  return classifierLoad;
}

export type ScoreRow = { id: string; score: number };

/**
 * Scores a single image URL against the user prompt. Returns 0..1 (confidence-style).
 */
export async function scoreImageUrl(
  imageUrl: string,
  userPrompt: string,
  onProgress?: (f: { progress: number }) => void
): Promise<number> {
  const cl = await getClipClassifier(onProgress);
  const labels = [userPrompt.trim() || "photo"];
  const out = (await cl(imageUrl, labels)) as
    | { label: string; score: number }[]
    | { label: string; score: number };
  if (Array.isArray(out)) {
    const row = out[0];
    return row?.score ?? 0;
  }
  return (out as { score: number }).score ?? 0;
}

export async function scoreManyByUrl(
  items: { id: string; url: string }[],
  prompt: string,
  opts: {
    concurrency?: number;
    onProgress?: (f: { progress: number }) => void;
    onEach?: (id: string, score: number) => void;
  } = {}
): Promise<ScoreRow[]> {
  const conc = Math.max(1, opts.concurrency ?? 2);
  const results: ScoreRow[] = [];
  for (let start = 0; start < items.length; start += conc) {
    const chunk = items.slice(start, start + conc);
    const part = await Promise.all(
      chunk.map(async (it, j) => {
        const isFirst = start + j === 0;
        const score = await scoreImageUrl(
          it.url,
          prompt,
          isFirst ? opts.onProgress : undefined
        );
        const row = { id: it.id, score };
        opts.onEach?.(it.id, score);
        return row;
      })
    );
    results.push(...part);
  }
  return results.sort((a, b) => b.score - a.score);
}
