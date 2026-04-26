const PHOTOS_PICKER = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Introspect a Google access token. Uses the legacy `oauth2/v1/tokeninfo` endpoint
 * (still the practical way to list scopes for a user access token).
 */
export async function getGoogleAccessTokenScopeInfo(accessToken: string) {
  const u = new URL("https://www.googleapis.com/oauth2/v1/tokeninfo");
  u.searchParams.set("access_token", accessToken);
  const res = await fetch(u.toString());
  if (!res.ok) {
    const t = await res.text();
    return { ok: false as const, status: res.status, error: t };
  }
  const j = (await res.json()) as {
    scope?: string;
    audience?: string;
    expires_in?: number;
  };
  const scopes = (j.scope || "").split(/\s+/).filter(Boolean);
  return {
    ok: true as const,
    audience: j.audience,
    expiresIn: j.expires_in,
    scopes,
    hasPhotospickerReadonly: scopes.includes(PHOTOS_PICKER),
    hasDriveReadonly: scopes.includes(DRIVE_READONLY),
  };
}
