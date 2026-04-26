import { NextRequest } from "next/server";

export const runtime = "nodejs";

export function GET(_request: NextRequest) {
  return Response.json(
    {
      error: "Library-wide Google Photos search is not available; use the Photos Picker flow.",
      hint: "Use /api/photos/picker/sessions, open pickerUri, then /api/photos/picker/media?sessionId=…",
    },
    { status: 410 }
  );
}
