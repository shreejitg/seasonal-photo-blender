/**
 * @deprecated Google no longer authorizes `albums.list` for general library
 * access with the old Library scopes. Use the Photos Picker flow instead
 * (see /api/photos/picker/*).
 */
export const runtime = "nodejs";

export async function GET() {
  return Response.json(
    {
      error: "Google Photos library listing is not available; use the Photos Picker to choose items.",
      hint: [
        "This endpoint previously called the Photos Library API. As of 2025, broad library access is not available that way; the app uses the Photos Picker API instead.",
        "In the app: pick “Google Photos”, click “Open Google Photos picker”, select photos, then load the pool from that session.",
        "Enable “Photos Picker API” in Google Cloud and consent scope photospicker.mediaitems.readonly.",
      ].join(" "),
    },
    { status: 410 }
  );
}
