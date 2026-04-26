import { getAuthenticatedDrive } from "@/lib/google/driveClient";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ fileId: string }> };

export async function GET(request: NextRequest, ctx: RouteCtx) {
  const { fileId } = await ctx.params;
  const useThumb = request.nextUrl.searchParams.get("thumb") === "1";

  const r = await getAuthenticatedDrive();
  if ("error" in r) return r.error;
  const { drive, session } = r;
  if (!session.accessToken) {
    return new Response("No access token", { status: 401 });
  }

  if (useThumb) {
    const { data: meta } = await drive.files.get({
      fileId,
      fields: "thumbnailLink,mimeType",
    });
    if (meta?.thumbnailLink) {
      const tUrl = new URL(meta.thumbnailLink);
      tUrl.searchParams.set("access_token", session.accessToken);
      const imgRes = await fetch(tUrl.toString());
      if (!imgRes.ok) {
        return new Response("Thumbnail fetch failed", { status: 502 });
      }
      const buf = await imgRes.arrayBuffer();
      return new Response(buf, {
        headers: {
          "Content-Type":
            imgRes.headers.get("content-type") || "image/jpeg",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }

  const gres = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );

  const data = gres.data as ArrayBuffer;
  const rawHeaders = (gres as { headers?: { "content-type"?: string } })
    .headers;
  const mime =
    rawHeaders?.["content-type"]?.split(";")[0]?.trim() || "image/jpeg";

  return new Response(data, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=60",
    },
  });
}
