import { auth } from "@/auth";
import { google } from "googleapis";
import { NextResponse } from "next/server";

export type DriveFileRow = {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  thumbnailLink: string | null;
  timeSource: "camera" | "created" | "modified" | "unknown";
  imageTime: string;
};

const IMAGE_FIELDS =
  "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, imageMediaMetadata, thumbnailLink, size)";

function pickImageTime(file: {
  imageMediaMetadata?: { time?: string } | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
}): { imageTime: string; timeSource: DriveFileRow["timeSource"] } {
  const camera = file.imageMediaMetadata?.time;
  if (camera) return { imageTime: camera, timeSource: "camera" };
  if (file.createdTime) {
    return { imageTime: file.createdTime, timeSource: "created" };
  }
  if (file.modifiedTime) {
    return { imageTime: file.modifiedTime, timeSource: "modified" };
  }
  return { imageTime: new Date(0).toISOString(), timeSource: "unknown" };
}

export function createOAuthFromSession(
  accessToken: string,
  refreshToken: string | undefined
) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return oauth2Client;
}

export async function getAuthenticatedDrive() {
  const session = await auth();
  if (!session?.accessToken) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const oauth2 = createOAuthFromSession(
    session.accessToken,
    session.refreshToken
  );
  const drive = google.drive({ version: "v3", auth: oauth2 });
  return { drive, session };
}

export type DriveFolder = {
  id: string;
  name: string;
  createdTime?: string | null;
};

const FOLDER_FIELDS = "nextPageToken, files(id, name, createdTime)";

/**
 * List folders the user can open (trashed = false, folder mime type).
 * Drive does not have "albums" — this is the usual way to group photos.
 */
export async function listFolders(
  pageToken: string | undefined,
  pageSize: number
): Promise<
  | { error: import("next/server").NextResponse }
  | { folders: DriveFolder[]; nextPageToken: string | null | undefined }
> {
  const r = await getAuthenticatedDrive();
  if ("error" in r) {
    return r as { error: import("next/server").NextResponse };
  }
  const { drive } = r;
  const q = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");
  const { data } = await drive.files.list({
    pageSize: Math.min(pageSize, 1000),
    pageToken: pageToken || undefined,
    q,
    orderBy: "name",
    fields: FOLDER_FIELDS,
  });
  const folders: DriveFolder[] = (data.files || [])
    .filter((f) => Boolean(f.id))
    .map((f) => ({
      id: f.id!,
      name: (f.name != null && String(f.name).trim() !== ""
        ? String(f.name)
        : "(Unnamed folder)") as string,
      createdTime: f.createdTime ?? null,
    }));
  return { folders, nextPageToken: data.nextPageToken };
}

function escDriveQueryString(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export type ListImageFilesResult =
  | { error: import("next/server").NextResponse }
  | { files: DriveFileRow[]; nextPageToken: string | null | undefined };

export async function listImageFiles(
  pageToken: string | undefined,
  pageSize: number,
  nameContains?: string,
  parentFolderId?: string
): Promise<ListImageFilesResult> {
  const r = await getAuthenticatedDrive();
  if ("error" in r) {
    return r as ListImageFilesResult;
  }
  const { drive } = r;

  const parts = [
    "mimeType contains 'image/'",
    "trashed = false",
  ];
  if (parentFolderId?.trim()) {
    const esc = escDriveQueryString(parentFolderId.trim());
    parts.push(`'${esc}' in parents`);
  }
  if (nameContains?.trim()) {
    const esc = escDriveQueryString(nameContains.trim());
    parts.push(`name contains '${esc}'`);
  }
  const q = parts.join(" and ");

  const { data } = await drive.files.list({
    pageSize: Math.min(pageSize, 100),
    pageToken: pageToken || undefined,
    q,
    orderBy: "createdTime desc",
    fields: IMAGE_FIELDS,
  });

  const files: DriveFileRow[] = (data.files || []).map((f) => {
    const t = pickImageTime(f);
    return {
      id: f.id!,
      name: f.name!,
      mimeType: f.mimeType!,
      createdTime: f.createdTime!,
      modifiedTime: f.modifiedTime!,
      thumbnailLink: f.thumbnailLink || null,
      timeSource: t.timeSource,
      imageTime: t.imageTime,
    };
  });

  return {
    files,
    nextPageToken: data.nextPageToken,
  };
}

const FILE_FIELDS =
  "id, name, mimeType, createdTime, modifiedTime, imageMediaMetadata, thumbnailLink, size";

export async function getFileMeta(fileId: string) {
  const r = await getAuthenticatedDrive();
  if ("error" in r) return r;
  const { data } = await r.drive.files.get({
    fileId,
    fields: FILE_FIELDS,
  });
  const f = data as {
    id?: string;
    name?: string;
    mimeType?: string;
    createdTime?: string;
    modifiedTime?: string;
    imageMediaMetadata?: { time?: string } | null;
    thumbnailLink?: string | null;
  };
  if (!f.id) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const t = pickImageTime(f);
  const row: DriveFileRow = {
    id: f.id,
    name: f.name!,
    mimeType: f.mimeType!,
    createdTime: f.createdTime!,
    modifiedTime: f.modifiedTime!,
    thumbnailLink: f.thumbnailLink || null,
    timeSource: t.timeSource,
    imageTime: t.imageTime,
  };
  return { meta: row };
}
