import type { PoolFileRow } from "@/lib/poolFile";

const KEY = "spb:workingSet";

export type WorkingItem = {
  id: string;
  name: string;
  imageTime: string;
  thumbnailLink?: string | null;
  /** Where the image bytes come from (default drive for older sessions). */
  source?: "drive" | "photos";
  /** Google Photos Picker `baseUrl` for server-side image fetch. */
  pickerBaseUrl?: string;
};

export function loadWorkingSet(): WorkingItem[] {
  if (typeof window === "undefined") return [];
  try {
    const s = sessionStorage.getItem(KEY);
    if (!s) return [];
    return JSON.parse(s) as WorkingItem[];
  } catch {
    return [];
  }
}

export function saveWorkingSet(items: WorkingItem[]) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(KEY, JSON.stringify(items));
}

export function workingItemFromPool(f: PoolFileRow): WorkingItem {
  return {
    id: f.id,
    name: f.name,
    imageTime: f.imageTime,
    thumbnailLink: f.thumbnailLink,
    source: f.source,
    pickerBaseUrl: f.pickerBaseUrl,
  };
}

export function addToWorking(f: PoolFileRow, max = 40): WorkingItem[] {
  const cur = loadWorkingSet();
  if (cur.some((x) => x.id === f.id)) return cur;
  if (cur.length >= max) return cur;
  const next = [...cur, workingItemFromPool(f)];
  saveWorkingSet(next);
  return next;
}

export function setWorkingSet(items: WorkingItem[]) {
  saveWorkingSet(items);
}

export function clearWorkingSet() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(KEY);
}
