import { getAuthenticatedPhotos } from "@/lib/google/photosClient";
import { photospickerListMediaPage } from "@/lib/google/photospickerClient";
import { poolFromPickerPicked } from "@/lib/poolFile";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const r = await getAuthenticatedPhotos();
  if ("error" in r) return r.error;
  const { accessToken } = r;

  const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim() || "";
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  const pageSize = Math.min(
    100,
    Math.max(1, Number(request.nextUrl.searchParams.get("pageSize") || "100"))
  );
  const pageToken = request.nextUrl.searchParams.get("pageToken") || undefined;

  const page = await photospickerListMediaPage(
    accessToken,
    sessionId,
    pageSize,
    pageToken
  );
  if ("error" in page) {
    return Response.json(
      { error: page.error },
      { status: page.status && page.status >= 400 ? page.status : 502 }
    );
  }
  const files = page.items
    .map((m) => poolFromPickerPicked(m))
    .filter((f): f is NonNullable<typeof f> => f != null);
  return Response.json({
    files,
    nextPageToken: page.nextPageToken,
  });
}
