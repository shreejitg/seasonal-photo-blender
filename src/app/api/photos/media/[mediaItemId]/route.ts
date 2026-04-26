import { getAuthenticatedPhotos, photosGetMediaItem, photosImageBytesUrl } from "@/lib/google/photosClient";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ mediaItemId: string }> };

export async function GET(request: NextRequest, ctx: RouteCtx) {
  const { mediaItemId } = await ctx.params;
  const useThumb = request.nextUrl.searchParams.get("thumb") === "1";

  const r = await getAuthenticatedPhotos();
  if ("error" in r) return r.error;
  const { accessToken } = r;

  const got = await photosGetMediaItem(accessToken, mediaItemId);
  if ("error" in got) {
    return new Response(got.error, { status: got.status });
  }

  const url = photosImageBytesUrl(got.baseUrl, useThumb);
  const imgRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!imgRes.ok) {
    return new Response("Image fetch failed", { status: 502 });
  }
  const buf = await imgRes.arrayBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": imgRes.headers.get("content-type") || got.mime || "image/jpeg",
      "Cache-Control": "private, max-age=300",
    },
  });
}
