import { getAuthenticatedDrive } from "@/lib/google/driveClient";
import { photosGetMediaItem, photosImageBytesUrl } from "@/lib/google/photosClient";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const BATCH = 6;

export async function POST(req: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json(
      { error: "GEMINI_API_KEY is not set" },
      { status: 400 }
    );
  }

  const body = (await req.json()) as {
    prompt?: string;
    fileIds?: string[];
    source?: "drive" | "photos";
    /** Picker `baseUrl` by media id (Google Photos Picker flow). */
    photosPickerBases?: Record<string, string>;
  };
  const prompt = (body.prompt || "").trim();
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds : [];
  const source: "drive" | "photos" = body.source === "photos" ? "photos" : "drive";
  const photosPickerBases =
    body.photosPickerBases && typeof body.photosPickerBases === "object"
      ? body.photosPickerBases
      : undefined;
  if (!prompt || fileIds.length === 0) {
    return Response.json(
      { error: "prompt and fileIds are required" },
      { status: 400 }
    );
  }

  const r = await getAuthenticatedDrive();
  if ("error" in r) return r.error;
  const { drive, session } = r;
  const at = session.accessToken;
  if (source === "photos" && !at) {
    return Response.json({ error: "No access token" }, { status: 401 });
  }

  const allScores: { id: string; score: number }[] = [];
  const gen = new GoogleGenerativeAI(key);

  for (let b = 0; b < fileIds.length; b += BATCH) {
    const slice = fileIds.slice(b, b + BATCH);
    const n = slice.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userParts: any[] = [
      {
        text: `The user is searching for: "${prompt}".\n\nYou will see ${n} images in order (index 0 to ${n - 1}). For each index, return a relevance score 0-100. Reply with JSON only in this shape: {"items":[{"i":0,"s":12}]}`,
      },
    ];

    for (const fileId of slice) {
      let buf: ArrayBuffer;
      let mime: string;
      if (source === "photos") {
        const fromPicker = photosPickerBases?.[fileId];
        if (fromPicker) {
          const url = photosImageBytesUrl(fromPicker, false);
          const imgRes = await fetch(url, {
            headers: { Authorization: `Bearer ${at}` },
          });
          if (!imgRes.ok) {
            return Response.json({ error: "Photos image download failed" }, { status: 502 });
          }
          buf = await imgRes.arrayBuffer();
          mime =
            imgRes.headers.get("content-type")?.split(";")[0] || "image/jpeg";
        } else {
          const got = await photosGetMediaItem(at!, fileId);
          if ("error" in got) {
            return Response.json(
              { error: String(got.error || "Photos fetch failed") },
              { status: got.status >= 400 ? got.status : 502 }
            );
          }
          const url = photosImageBytesUrl(got.baseUrl, false);
          const imgRes = await fetch(url, {
            headers: { Authorization: `Bearer ${at}` },
          });
          if (!imgRes.ok) {
            return Response.json({ error: "Photos image download failed" }, { status: 502 });
          }
          buf = await imgRes.arrayBuffer();
          mime =
            imgRes.headers.get("content-type")?.split(";")[0] || got.mime || "image/jpeg";
        }
      } else {
        const gres = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" }
        );
        buf = gres.data as ArrayBuffer;
        const hdrs = (gres as { headers?: { "content-type"?: string } }).headers;
        mime = hdrs?.["content-type"]?.split(";")[0] || "image/jpeg";
      }
      const b64 = Buffer.from(buf).toString("base64");
      userParts.push({ inlineData: { mimeType: mime, data: b64 } });
    }

    const model = gen.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            items: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  i: { type: SchemaType.NUMBER, nullable: false },
                  s: { type: SchemaType.NUMBER, nullable: false },
                },
                required: ["i", "s"],
              },
            },
          },
          required: ["items"],
        },
      },
    });

    const out = await model.generateContent({
      contents: [{ role: "user", parts: userParts }],
    });
    const txt = out.response.text();
    let parsed: { items?: { i: number; s: number }[] };
    try {
      parsed = JSON.parse(txt) as { items: { i: number; s: number }[] };
    } catch {
      return Response.json({ error: "Invalid Gemini response" }, { status: 502 });
    }
    for (const row of parsed.items || []) {
      const id = slice[Math.floor(row.i)];
      if (id) {
        allScores.push({ id, score: Math.max(0, Math.min(1, row.s / 100)) });
      }
    }
  }

  return Response.json({ scores: allScores });
}
