import { listImageFiles } from "@/lib/google/driveClient";
import { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pageToken = searchParams.get("pageToken") || undefined;
  const nameContains = searchParams.get("q") || undefined;
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") || 30))
  );
  const folderId =
    searchParams.get("folder") || searchParams.get("folderId") || undefined;

  const res = await listImageFiles(pageToken, pageSize, nameContains, folderId);
  if ("error" in res) return res.error;
  return Response.json({
    files: res.files,
    nextPageToken: res.nextPageToken || undefined,
  });
}
