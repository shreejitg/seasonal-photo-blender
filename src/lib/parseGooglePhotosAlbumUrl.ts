/**
 * Extract the Library API `albumId` from a normal Google Photos album URL,
 * or accept a bare id copied from the path.
 * Does not resolve short `photos.app.goo.gl/...` links (those are not the API id).
 */
export function parseGooglePhotosAlbumId(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    const m = t.match(
      /photos\.google\.com\/(?:u\/\d+\/)?album\/([A-Za-z0-9_-]+)/i
    );
    if (m?.[1]) return m[1];
  }
  if (!/[/.#?]/.test(t) && /^[A-Za-z0-9_-]{10,128}$/.test(t)) {
    return t;
  }
  return null;
}
