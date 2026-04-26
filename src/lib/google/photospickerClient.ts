import { formatGoogleApiErrorBody } from "./photosClient";

const API = "https://photospicker.googleapis.com/v1";

export type PickerSession = {
  id: string;
  pickerUri: string;
  mediaItemsSet: boolean;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
  expireTime?: string;
};

export type PickerPickedItem = {
  id: string;
  createTime?: string;
  type?: string;
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
  } | null;
};

export async function photospickerCreateSession(
  accessToken: string,
  maxItemCount = 2000
) {
  const res = await fetch(`${API}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pickingConfig: { maxItemCount: String(maxItemCount) },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return { error: formatGoogleApiErrorBody(t) || res.statusText, status: res.status };
  }
  const j = (await res.json()) as {
    id?: string;
    pickerUri?: string;
    mediaItemsSet?: boolean;
    pollingConfig?: { pollInterval?: string; timeoutIn?: string };
    expireTime?: string;
  };
  if (!j.id || !j.pickerUri) {
    return { error: "Invalid picker session response", status: 502 as const };
  }
  return {
    session: {
      id: j.id,
      pickerUri: j.pickerUri,
      mediaItemsSet: Boolean(j.mediaItemsSet),
      pollingConfig: j.pollingConfig,
      expireTime: j.expireTime,
    } satisfies PickerSession,
  };
}

export async function photospickerGetSession(accessToken: string, sessionId: string) {
  const res = await fetch(
    `${API}/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const t = await res.text();
    return { error: formatGoogleApiErrorBody(t) || res.statusText, status: res.status };
  }
  const j = (await res.json()) as {
    id?: string;
    pickerUri?: string;
    mediaItemsSet?: boolean;
    pollingConfig?: { pollInterval?: string; timeoutIn?: string };
    expireTime?: string;
  };
  if (!j.id) {
    return { error: "Invalid session", status: 502 as const };
  }
  return {
    session: {
      id: j.id,
      pickerUri: j.pickerUri || "",
      mediaItemsSet: Boolean(j.mediaItemsSet),
      pollingConfig: j.pollingConfig,
      expireTime: j.expireTime,
    } satisfies PickerSession,
  };
}

export async function photospickerListMediaPage(
  accessToken: string,
  sessionId: string,
  pageSize: number,
  pageToken?: string
) {
  const u = new URL(`${API}/mediaItems`);
  u.searchParams.set("sessionId", sessionId);
  u.searchParams.set("pageSize", String(Math.min(100, Math.max(1, pageSize))));
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const t = await res.text();
    return { error: formatGoogleApiErrorBody(t) || res.statusText, status: res.status };
  }
  const j = (await res.json()) as {
    mediaItems?: PickerPickedItem[];
    nextPageToken?: string;
  };
  return { items: j.mediaItems || [], nextPageToken: j.nextPageToken };
}

export function parseDurationToMs(s: string | undefined, fallback: number) {
  if (!s || typeof s !== "string") return fallback;
  const m = /^([0-9.]+)s$/.exec(s.trim());
  if (!m) return fallback;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 1000);
}
