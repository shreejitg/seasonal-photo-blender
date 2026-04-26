import { auth } from "@/auth";
import { getGoogleAccessTokenScopeInfo } from "@/lib/google/accessTokenScopeInfo";

export const runtime = "nodejs";

/** Shows which OAuth scopes the current Google access token actually carries. */
export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const info = await getGoogleAccessTokenScopeInfo(session.accessToken as string);
  if (!info.ok) {
    return Response.json(
      { error: "Token introspection failed", details: info.error, status: info.status },
      { status: 502 }
    );
  }
  return Response.json({
    audience: info.audience,
    expiresIn: info.expiresIn,
    scopes: info.scopes,
    hasPhotospickerReadonly: info.hasPhotospickerReadonly,
    hasDriveReadonly: info.hasDriveReadonly,
    expected: {
      photos: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
      drive: "https://www.googleapis.com/auth/drive.readonly",
    },
  });
}
