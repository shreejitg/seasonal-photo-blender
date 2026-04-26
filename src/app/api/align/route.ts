import { auth } from "@/auth";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MB = 25;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }

  const base = process.env.ALIGN_SERVICE_URL?.trim();
  if (!base) {
    return Response.json(
      {
        error: "Auto-align is not configured",
        hint: "Set ALIGN_SERVICE_URL (e.g. http://127.0.0.1:8765) and run the Python sidecar (see sidecar/README.md).",
      },
      { status: 503 }
    );
  }

  const incoming = await request.formData();
  const refIndex = String(incoming.get("refIndex") ?? incoming.get("ref_index") ?? "0");
  const workWidth = String(
    incoming.get("workWidth") ?? incoming.get("work_width") ?? "800"
  );
  const out = new FormData();
  out.append("ref_index", refIndex);
  out.append("work_width", workWidth);
  let total = 0;
  for (const [k, v] of incoming) {
    if (v instanceof File && (k === "file" || k.startsWith("file"))) {
      out.append("files", v, (v as File).name || "image.jpg");
      total += (v as File).size;
    }
  }
  if (total > MB * 1024 * 1024) {
    return Response.json(
      { error: `Request too large (max ${MB} MB of images)` },
      { status: 400 }
    );
  }

  const url = new URL("/align", base.endsWith("/") ? base : `${base}/`);
  const res = await fetch(url, { method: "POST", body: out });
  const text = await res.text();
  if (!res.ok) {
    try {
      const j = JSON.parse(text) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) {
        return Response.json(j, { status: res.status });
      }
    } catch {
      /* not JSON */
    }
    return Response.json(
      { error: text || "Align service error" },
      { status: res.status }
    );
  }
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
