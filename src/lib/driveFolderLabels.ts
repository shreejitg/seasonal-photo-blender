import type { DriveFolder } from "@/lib/google/driveClient";

export type FolderOption = { id: string; label: string };

/**
 * Build unique, readable labels for the folder &lt;select&gt;. Google Drive allows
 * many folders with the same display name (e.g. "1" or "Photos"); disambiguate.
 */
export function driveFolderOptionLabels(folders: DriveFolder[]): FolderOption[] {
  const rows = folders.map((f) => ({
    id: f.id,
    base: f.name.trim() || "(Unnamed folder)",
    createdTime: f.createdTime,
  }));
  const nameCount = new Map<string, number>();
  for (const r of rows) {
    nameCount.set(r.base, (nameCount.get(r.base) ?? 0) + 1);
  }
  return rows.map((r) => {
    const dup = (nameCount.get(r.base) ?? 0) > 1;
    if (!dup) {
      return { id: r.id, label: r.base };
    }
    const date =
      r.createdTime &&
      !Number.isNaN(new Date(r.createdTime).getTime())
        ? new Date(r.createdTime).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : null;
    const tail = r.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || r.id.slice(-6);
    if (date) {
      return { id: r.id, label: `${r.base} — ${date} · ${tail}` };
    }
    return { id: r.id, label: `${r.base} · ${tail}` };
  });
}
