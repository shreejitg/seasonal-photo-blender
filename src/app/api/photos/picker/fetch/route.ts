import { getAuthenticatedPhotos, photosImageBytesUrl } from "@/lib/google/photosClient";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

function base64UrlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8");
}

function isAllowedGooglePickerUrl(href: string) {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "lh3.googleusercontent.com" || h.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

/**
 * Fetches Picker `baseUrl` bytes (thumb or full). The URL is passed as
 * base64url in `u` so we never hit GET length limits with raw `baseUrl`.
 */
export async function GET(request: NextRequest) {
  const enc = request.nextUrl.searchParams.get("u")?.trim() || "";
  const thumb = request.nextUrl.searchParams.get("thumb") === "1";
  if (!enc) {
    return new Response("Missing u", { status: 400 });
  }
  let baseUrl: string;
  try {
    baseUrl = base64UrlToUtf8(enc);
  } catch {
    return new Response("Invalid u", { status: 400 });
  }
  if (!isAllowedGooglePickerUrl(baseUrl)) {
    return new Response("URL not allowed", { status: 400 });
  }
  const auth = await getAuthenticatedPhotos();
  if ("error" in auth) return auth.error;
  const { accessToken } = auth;
  const url = photosImageBytesUrl(baseUrl, thumb);
  const imgRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!imgRes.ok) {
    return new Response("Image fetch failed", { status: 502 });
  }
  const buf = await imgRes.arrayBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": imgRes.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "private, max-age=300",
    },
  });
}
