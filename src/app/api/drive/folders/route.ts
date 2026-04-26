import { listFolders } from "@/lib/google/driveClient";
import { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pageToken = searchParams.get("pageToken") || undefined;
  const pageSize = Math.min(
    200,
    Math.max(10, Number(searchParams.get("pageSize") || 200))
  );

  const res = await listFolders(pageToken, pageSize);
  if ("error" in res) return res.error;
  return Response.json({
    folders: res.folders,
    nextPageToken: res.nextPageToken || undefined,
  });
}
