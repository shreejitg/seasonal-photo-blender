import { getAuthenticatedPhotos } from "@/lib/google/photosClient";
import { photospickerCreateSession } from "@/lib/google/photospickerClient";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const r = await getAuthenticatedPhotos();
  if ("error" in r) return r.error;
  const { accessToken } = r;
  const body = (await request.json().catch(() => ({}))) as {
    maxItemCount?: number;
  };
  const max = Math.min(
    2000,
    Math.max(1, Number(body.maxItemCount) || 2000)
  );
  const out = await photospickerCreateSession(accessToken, max);
  if ("error" in out) {
    const st = out.status ?? 502;
    return Response.json(
      { error: out.error, hint: pickerHint() },
      { status: st >= 400 ? st : 502 }
    );
  }
  return Response.json({
    sessionId: out.session.id,
    pickerUri: out.session.pickerUri,
    mediaItemsSet: out.session.mediaItemsSet,
    pollingConfig: out.session.pollingConfig,
    expireTime: out.session.expireTime,
  });
}

function pickerHint() {
  return [
    "Enable “Photos Picker API” in Google Cloud (APIs & services → Library) for the same project as the OAuth client.",
    "The OAuth consent screen must include scope https://www.googleapis.com/auth/photospicker.mediaitems.readonly. Revoke the app at https://myaccount.google.com/permissions and sign in again to grant it.",
  ].join(" ");
}
