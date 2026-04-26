/**
 * Path (relative) for the server image proxy. Uses base64url of the
 * Picker `baseUrl` (client-only: uses `btoa`).
 */
export function photosPickerFetchPath(
  pickerBaseUrl: string,
  opts: { thumb?: boolean } = {}
) {
  const b64 = btoa(
    new TextEncoder()
      .encode(pickerBaseUrl)
      .reduce((acc, c) => acc + String.fromCharCode(c), "")
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `/api/photos/picker/fetch?u=${encodeURIComponent(b64)}${
    opts.thumb ? "&thumb=1" : ""
  }`;
}
