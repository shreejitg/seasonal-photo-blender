import { auth } from "@/auth";
import { NextResponse } from "next/server";

const API = "https://photoslibrary.googleapis.com/v1";

/** Parse `{"error": { "message", "status" } }` from Google API bodies. */
export function formatGoogleApiErrorBody(text: string): string {
  const raw = (text || "").trim();
  if (!raw) return "Unknown error";
  try {
    const j = JSON.parse(raw) as { error?: { message?: string; messageDetails?: string } };
    if (j.error?.message) return j.error.message;
  } catch {
    /* plain text or HTML */
  }
  if (raw.length > 500) return `${raw.slice(0, 200)}…`;
  return raw;
}

export type PhotosAlbum = {
  id: string;
  title: string;
  mediaItemsCount: number;
  coverPhotoMediaItemId: string | null;
};

type ApiAlbum = {
  id?: string;
  title?: string;
  mediaItemsCount?: string;
  coverPhotoMediaItemId?: string;
};

type MediaItemResponse = {
  id?: string;
  baseUrl?: string;
  mimeType?: string;
  mediaMetadata?: { creationTime?: string };
};

function toAlbum(a: ApiAlbum): PhotosAlbum | null {
  if (!a.id) return null;
  const t =
    a.title != null && String(a.title).trim() !== "" ? String(a.title) : "Untitled";
  const n = Number.parseInt(String(a.mediaItemsCount ?? "0"), 10);
  return {
    id: a.id,
    title: t,
    mediaItemsCount: Number.isFinite(n) ? n : 0,
    coverPhotoMediaItemId: a.coverPhotoMediaItemId ?? null,
  };
}

export async function getAuthenticatedPhotos() {
  const session = await auth();
  if (!session?.accessToken) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { accessToken: session.accessToken as string, session };
}

export async function photosListAlbumsPage(
  accessToken: string,
  pageSize: number,
  pageToken?: string
) {
  const u = new URL(`${API}/albums`);
  u.searchParams.set("pageSize", String(Math.min(50, Math.max(1, pageSize))));
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  u.searchParams.set("excludeNonAppCreatedData", "false");
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const t = await res.text();
    return {
      error: formatGoogleApiErrorBody(t) || res.statusText,
      status: res.status,
    };
  }
  const j = (await res.json()) as { albums?: ApiAlbum[]; nextPageToken?: string };
  const albums: PhotosAlbum[] = (j.albums || [])
    .map((x) => toAlbum(x))
    .filter((x): x is PhotosAlbum => x != null);
  return { albums, nextPageToken: j.nextPageToken };
}

/**
 * Newest `creationTime` in the first N media items in album order (not guaranteed
 * global max). Fallback when a cover is missing.
 */
export async function photosAlbumSampleMaxCreationMs(
  accessToken: string,
  albumId: string,
  pageSize: number
): Promise<number> {
  const res = await fetch(`${API}/mediaItems:search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ albumId, pageSize, pageToken: undefined }),
  });
  if (!res.ok) return 0;
  const j = (await res.json()) as {
    mediaItems?: { mediaMetadata?: { creationTime?: string } }[];
  };
  const items = j.mediaItems || [];
  let max = 0;
  for (const m of items) {
    const t = m.mediaMetadata?.creationTime;
    if (t) max = Math.max(max, new Date(t).getTime());
  }
  return max;
}

export async function photosMediaItemCreationMs(
  accessToken: string,
  mediaItemId: string
): Promise<number> {
  const res = await fetch(
    `${API}/mediaItems/${encodeURIComponent(mediaItemId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return 0;
  const it = (await res.json()) as MediaItemResponse;
  const t = it.mediaMetadata?.creationTime;
  return t ? new Date(t).getTime() : 0;
}

export type SearchMediaResult = {
  mediaItems?: MediaItemResponse[];
  nextPageToken?: string;
};

export async function photosSearchMedia(
  accessToken: string,
  body: Record<string, unknown>
): Promise<SearchMediaResult & { error?: string; status?: number }> {
  const res = await fetch(`${API}/mediaItems:search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    return {
      error: formatGoogleApiErrorBody(t) || res.statusText,
      status: res.status,
    };
  }
  return (await res.json()) as SearchMediaResult;
}

export async function photosGetMediaItem(
  accessToken: string,
  mediaItemId: string
): Promise<
  { item: MediaItemResponse; baseUrl: string; mime: string } | { error: string; status: number }
> {
  const res = await fetch(
    `${API}/mediaItems/${encodeURIComponent(mediaItemId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const t = await res.text();
    return { error: formatGoogleApiErrorBody(t), status: res.status };
  }
  const item = (await res.json()) as MediaItemResponse;
  if (!item.baseUrl) {
    return { error: "No baseUrl", status: 502 };
  }
  const mime = item.mimeType || "image/jpeg";
  return { item, baseUrl: item.baseUrl, mime };
}

/**
 * Thumbnail: append =w512-h512. Full: =d
 */
export function photosImageBytesUrl(baseUrl: string, thumb: boolean) {
  if (!baseUrl) return baseUrl;
  if (thumb) return `${baseUrl}=w512-h512`;
  return `${baseUrl}=d`;
}
