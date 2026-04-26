import { getAuthenticatedPhotos } from "@/lib/google/photosClient";
import { photospickerGetSession } from "@/lib/google/photospickerClient";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }
  const r = await getAuthenticatedPhotos();
  if ("error" in r) return r.error;
  const { accessToken } = r;
  const out = await photospickerGetSession(accessToken, sessionId);
  if ("error" in out) {
    const st = out.status ?? 502;
    return Response.json({ error: out.error }, { status: st >= 400 ? st : 502 });
  }
  return Response.json({
    sessionId: out.session.id,
    mediaItemsSet: out.session.mediaItemsSet,
    pollingConfig: out.session.pollingConfig,
    expireTime: out.session.expireTime,
  });
}
