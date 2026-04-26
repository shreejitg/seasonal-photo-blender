import type { DriveFileRow } from "@/lib/google/driveClient";

/** Unified row for Drive + Google Photos when building the pool in /drive. */
export type PoolFileRow = {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  thumbnailLink: string | null;
  timeSource: DriveFileRow["timeSource"];
  imageTime: string;
  source: "drive" | "photos";
  /** Google Photos Picker: signed download base URL; required for proxy when present. */
  pickerBaseUrl?: string;
};

export function poolFromDrive(f: DriveFileRow): PoolFileRow {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    thumbnailLink: f.thumbnailLink,
    timeSource: f.timeSource,
    imageTime: f.imageTime,
    source: "drive",
  };
}

export function poolFromPhotosMediaItem(m: {
  id: string;
  filename?: string | null;
  mimeType?: string | null;
  mediaMetadata?: { creationTime?: string | null } | null;
}): PoolFileRow {
  const created = m.mediaMetadata?.creationTime || new Date(0).toISOString();
  const name =
    m.filename != null && String(m.filename).trim() !== ""
      ? String(m.filename)
      : "Photo";
  return {
    id: m.id,
    name,
    mimeType: m.mimeType || "image/jpeg",
    createdTime: created,
    modifiedTime: created,
    thumbnailLink: null,
    timeSource: "created",
    imageTime: created,
    source: "photos",
  };
}

export function poolFromPickerPicked(m: {
  id?: string;
  type?: string;
  createTime?: string;
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
  } | null;
}): PoolFileRow | null {
  if (!m.id) return null;
  if (m.type && m.type !== "PHOTO") return null;
  const baseUrl = m.mediaFile?.baseUrl;
  if (!baseUrl) return null;
  const created = m.createTime || new Date(0).toISOString();
  const name =
    m.mediaFile?.filename != null && String(m.mediaFile.filename).trim() !== ""
      ? String(m.mediaFile.filename)
      : "Photo";
  return {
    id: m.id,
    name,
    mimeType: m.mediaFile?.mimeType || "image/jpeg",
    createdTime: created,
    modifiedTime: created,
    thumbnailLink: null,
    timeSource: "created",
    imageTime: created,
    source: "photos",
    pickerBaseUrl: baseUrl,
  };
}
