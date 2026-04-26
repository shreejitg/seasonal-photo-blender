"use client";

import type { DriveFolder } from "@/lib/google/driveClient";
import { driveFolderOptionLabels } from "@/lib/driveFolderLabels";
import { parseDurationToMs } from "@/lib/google/photospickerClient";
import { photosPickerFetchPath } from "@/lib/photosPickerPath";
import { poolFromDrive, type PoolFileRow } from "@/lib/poolFile";
import { saveWorkingSet, workingItemFromPool } from "@/lib/workingSet";
import { scoreManyByUrl, getClipClassifier } from "@/lib/similarity/localClip";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

const MAX_EDITOR = 50;

type DriveListResponse = { files: import("@/lib/google/driveClient").DriveFileRow[]; nextPageToken?: string };
type PhotosListResponse = { files: PoolFileRow[]; nextPageToken?: string };

function poolThumbUrl(f: PoolFileRow) {
  if (f.source === "photos" && f.pickerBaseUrl) {
    return new URL(
      photosPickerFetchPath(f.pickerBaseUrl, { thumb: true }),
      window.location.origin
    ).toString();
  }
  const path =
    f.source === "photos"
      ? `/api/photos/media/${f.id}?thumb=1`
      : `/api/drive/media/${f.id}?thumb=1`;
  return new URL(path, window.location.origin).toString();
}

export function DriveView() {
  const router = useRouter();
  const [loadSource, setLoadSource] = useState<"drive" | "photos">("drive");

  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [folderId, setFolderId] = useState("");

  const [pickerSessionId, setPickerSessionId] = useState<string | null>(null);
  const [pickerPhase, setPickerPhase] = useState<"idle" | "picking" | "ready" | "error">("idle");
  const [pickerErr, setPickerErr] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [photosReauth, setPhotosReauth] = useState(false);
  const [scopeDiagJson, setScopeDiagJson] = useState<string | null>(null);
  const [scopeDiagLoading, setScopeDiagLoading] = useState(false);

  const [q, setQ] = useState("");
  const [maxToLoad, setMaxToLoad] = useState(200);
  const [candidates, setCandidates] = useState<PoolFileRow[]>([]);
  const [loadLabel, setLoadLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ranking, setRanking] = useState(false);
  const [modelProg, setModelProg] = useState<number | null>(null);
  const [scores, setScores] = useState<Record<string, number> | null>(null);
  const [sortNote, setSortNote] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const switchSource = (next: "drive" | "photos") => {
    if (next === loadSource) return;
    setLoadSource(next);
    setCandidates([]);
    setScores(null);
    setSelectedIds(new Set());
    setSortNote("");
    setErr(null);
    setScopeDiagJson(null);
    if (next === "drive") {
      setPickerSessionId(null);
      setPickerPhase("idle");
      setPickerErr(null);
    }
  };

  const openGooglePhotosPicker = useCallback(async () => {
    setPickerErr(null);
    setPickerBusy(true);
    setPickerPhase("idle");
    setPhotosReauth(false);
    try {
      const r = await fetch("/api/photos/picker/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          maxItemCount: Math.min(2000, Math.max(1, maxToLoad)),
        }),
      });
      const j = (await r.json()) as {
        sessionId?: string;
        pickerUri?: string;
        pollingConfig?: { pollInterval?: string; timeoutIn?: string };
        error?: string;
        hint?: string;
      };
      if (!r.ok) {
        const msg = [j.error, j.hint].filter(Boolean).join("\n\n");
        setPickerErr(msg || "Could not start picker");
        setPickerPhase("error");
        const errText = String(j.error || "").toLowerCase();
        setPhotosReauth(
          r.status === 401 ||
            r.status === 403 ||
            errText.includes("scope") ||
            errText.includes("permission")
        );
        return;
      }
      if (!j.sessionId || !j.pickerUri) {
        setPickerErr("Invalid picker response");
        setPickerPhase("error");
        return;
      }
      setPickerSessionId(j.sessionId);
      const u = new URL(j.pickerUri);
      u.pathname = u.pathname.replace(/\/?$/, "") + "/autoclose";
      window.open(u.toString(), "_blank", "noopener,noreferrer");
      setPickerPhase("picking");
      const pollEvery = parseDurationToMs(j.pollingConfig?.pollInterval, 2500);
      const maxWait = parseDurationToMs(j.pollingConfig?.timeoutIn, 300_000) || 300_000;
      const started = Date.now();
      for (;;) {
        if (Date.now() - started > maxWait) {
          setPickerErr(
            "Timed out waiting for your selection. Open the picker again and complete your selection in Google Photos."
          );
          setPickerPhase("error");
          return;
        }
        await new Promise((res) => setTimeout(res, pollEvery));
        const gr = await fetch(
          `/api/photos/picker/sessions/${encodeURIComponent(j.sessionId)}`,
          { credentials: "include" }
        );
        const g = (await gr.json()) as { mediaItemsSet?: boolean; error?: string };
        if (!gr.ok) {
          setPickerErr(g.error || "Session poll failed");
          setPickerPhase("error");
          return;
        }
        if (g.mediaItemsSet) {
          setPickerPhase("ready");
          setScopeDiagJson(null);
          return;
        }
      }
    } catch (e) {
      setPickerErr(e instanceof Error ? e.message : "Picker failed");
      setPickerPhase("error");
    } finally {
      setPickerBusy(false);
    }
  }, [maxToLoad]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch("/api/drive/folders?pageSize=200", {
          credentials: "include",
        });
        if (!r.ok) return;
        const j = (await r.json()) as { folders?: DriveFolder[] };
        if (!cancel) {
          setFolders(
            (j.folders || []).sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            )
          );
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancel) setFoldersLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const folderOptions = useMemo(
    () => driveFolderOptionLabels(folders),
    [folders]
  );

  const loadPool = useCallback(async () => {
    setErr(null);
    setScores(null);
    setSortNote("");
    setSelectedIds(new Set());
    setCandidates([]);
    const cap = Math.min(1000, Math.max(20, maxToLoad));
    setLoading(true);
    const acc: PoolFileRow[] = [];
    let pageToken: string | undefined;
    try {
      if (loadSource === "drive") {
        while (acc.length < cap) {
          setLoadLabel(`Loading from Drive… ${acc.length} / ${cap}`);
          const u = new URL("/api/drive/list", window.location.origin);
          u.searchParams.set("pageSize", String(Math.min(100, cap - acc.length)));
          if (q.trim()) u.searchParams.set("q", q.trim());
          if (folderId.trim()) u.searchParams.set("folder", folderId.trim());
          if (pageToken) u.searchParams.set("pageToken", pageToken);
          const r = await fetch(u.toString(), { credentials: "include" });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error((j as { error?: string }).error || r.statusText);
          }
          const j = (await r.json()) as DriveListResponse;
          const rows = j.files.map(poolFromDrive);
          acc.push(...rows);
          setCandidates([...acc]);
          if (!j.nextPageToken || acc.length >= cap) break;
          pageToken = j.nextPageToken;
        }
        setCandidates(acc.slice(0, cap));
      } else {
        if (!pickerSessionId) {
          throw new Error(
            "Open the Google Photos picker and finish selecting, then try loading again."
          );
        }
        while (acc.length < cap) {
          setLoadLabel(`Loading from Google Photos… ${acc.length} / ${cap}`);
          const u = new URL("/api/photos/picker/media", window.location.origin);
          u.searchParams.set("sessionId", pickerSessionId);
          u.searchParams.set("pageSize", String(Math.min(100, cap - acc.length)));
          if (pageToken) u.searchParams.set("pageToken", pageToken);
          const r = await fetch(u.toString(), { credentials: "include" });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            setPhotosReauth(!!(j as { reauth?: boolean }).reauth);
            throw new Error(
              (j as { error?: string; hint?: string }).error ||
                (j as { hint?: string }).hint ||
                r.statusText
            );
          }
          setPhotosReauth(false);
          const j = (await r.json()) as PhotosListResponse;
          acc.push(...j.files);
          setCandidates([...acc]);
          if (!j.nextPageToken || acc.length >= cap) break;
          pageToken = j.nextPageToken;
        }
        let out = acc.slice(0, cap);
        if (q.trim()) {
          const qq = q.trim().toLowerCase();
          out = out.filter((f) => f.name.toLowerCase().includes(qq));
        }
        setCandidates(out);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load photos");
    } finally {
      setLoading(false);
      setLoadLabel(null);
    }
  }, [maxToLoad, q, folderId, loadSource, pickerSessionId]);

  const rankLocal = async () => {
    if (!candidates.length || !prompt.trim()) return;
    setRanking(true);
    setModelProg(0);
    setErr(null);
    setSortNote("");
    try {
      const items = candidates.map((f) => ({
        id: f.id,
        url: poolThumbUrl(f),
      }));
      const scoreRows = await scoreManyByUrl(items, prompt, {
        concurrency: 2,
        onProgress: (p) => {
          if (p.progress < 1) setModelProg(p.progress);
        },
        onEach: () =>
          setModelProg((x) => (x === null ? null : (x as number) + 0.001)),
      });
      setModelProg(1);
      const byId = new Map(scoreRows.map((s) => [s.id, s.score] as const));
      const sc: Record<string, number> = {};
      for (const [id, s] of byId) sc[id] = s;
      setScores(sc);
      const next = [...candidates].sort(
        (a, b) => (byId.get(b.id) || 0) - (byId.get(a.id) || 0)
      );
      setCandidates(next);
      setSortNote("Sorted by your description (local CLIP).");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rank failed");
    } finally {
      setRanking(false);
      setModelProg(null);
    }
  };

  const prewarm = () => {
    setModelProg(0);
    setErr(null);
    void getClipClassifier((p) => {
      if (p.progress < 1) setModelProg(p.progress);
    })
      .then(() => setModelProg(1))
      .catch((e) => {
        setModelProg(null);
        setErr(e instanceof Error ? e.message : "Failed to load CLIP model");
      });
  };

  const rankGemini = async () => {
    if (!candidates.length || !prompt.trim()) return;
    setRanking(true);
    setErr(null);
    setSortNote("");
    try {
      const r = await fetch("/api/similarity/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          fileIds: candidates.map((f) => f.id),
          source: loadSource === "photos" ? "photos" : "drive",
          photosPickerBases:
            loadSource === "photos"
              ? Object.fromEntries(
                  candidates
                    .filter((f) => f.pickerBaseUrl)
                    .map((f) => [f.id, f.pickerBaseUrl!] as const)
                )
              : undefined,
        }),
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || r.statusText);
      }
      const j = (await r.json()) as { scores: { id: string; score: number }[] };
      const byId = new Map(j.scores.map((s) => [s.id, s.score] as const));
      const sc: Record<string, number> = {};
      for (const [id, s] of byId) sc[id] = s;
      setScores(sc);
      const next = [...candidates].sort(
        (a, b) => (byId.get(b.id) || 0) - (byId.get(a.id) || 0)
      );
      setCandidates(next);
      setSortNote("Sorted by your description (Gemini).");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gemini failed");
    } finally {
      setRanking(false);
    }
  };

  const sortChrono = () => {
    if (!candidates.length) return;
    const next = [...candidates].sort(
      (a, b) =>
        new Date(a.imageTime).getTime() - new Date(b.imageTime).getTime()
    );
    setCandidates(next);
    setSortNote("Sorted by date (camera/created). Match scores, if any, are unchanged.");
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectAll = () => {
    setSelectedIds(new Set(candidates.map((c) => c.id)));
  };

  const selectTopK = (k: number) => {
    const n = new Set<string>();
    for (const c of candidates.slice(0, k)) n.add(c.id);
    setSelectedIds(n);
  };

  const openEditor = () => {
    const inOrder = candidates
      .filter((c) => selectedIds.has(c.id))
      .slice(0, MAX_EDITOR)
      .map(workingItemFromPool);
    if (inOrder.length === 0) {
      setErr("Select at least one photo.");
      return;
    }
    saveWorkingSet(inOrder);
    router.push("/editor");
  };

  const scorePct = (id: string) => {
    const s = scores?.[id];
    if (s === undefined) return null;
    return Math.round(s * 100);
  };

  const loadActionLabel = loadSource === "photos" ? "Load from Google Photos" : "Load from Drive";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold text-white">Find photos, then build a blend</h1>
      <ol className="list-inside list-decimal space-y-1 text-sm text-zinc-500">
        <li>
          <span className="text-zinc-300">Load</span> from{" "}
          <strong>Google Photos (picker)</strong> or a <strong>Google Drive</strong> folder
          (or the whole drive), then optionally narrow the list.
        </li>
        <li>
          <span className="text-zinc-300">Describe</span> them in natural language
          and <span className="text-zinc-300">rank</span> (CLIP on-device or Gemini) — order is
          by image match, not file names.
        </li>
        <li>
          <span className="text-zinc-300">Select</span> the ones you want, then open
          the editor (max {MAX_EDITOR} at once).
        </li>
      </ol>

      {/* Step 1: load pool */}
      <div className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
        <h2 className="text-sm font-medium text-amber-200/90">
          <span className="text-zinc-500">Step 1 ·</span> Load a photo pool
        </h2>
        <div className="flex flex-wrap gap-2">
          <span className="w-full text-xs text-zinc-500">Source</span>
          <button
            type="button"
            onClick={() => switchSource("drive")}
            className={`rounded border px-3 py-1.5 text-xs ${
              loadSource === "drive"
                ? "border-amber-500 bg-amber-950/50 text-amber-100"
                : "border-zinc-600 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            Google Drive
          </button>
          <button
            type="button"
            onClick={() => switchSource("photos")}
            className={`rounded border px-3 py-1.5 text-xs ${
              loadSource === "photos"
                ? "border-amber-500 bg-amber-950/50 text-amber-100"
                : "border-zinc-600 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            Google Photos
          </button>
        </div>

        {loadSource === "drive" ? (
          <div>
            <label
              className="mb-0.5 block text-xs text-zinc-500"
              htmlFor="folder-select"
            >
              Drive folder
            </label>
            <select
              id="folder-select"
              className="w-full max-w-lg rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              disabled={foldersLoading}
            >
              <option value="">
                All image files (entire Drive)
              </option>
              {folderOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-600">
              Only images stored as files in the selected folder are included (not
              subfolders). Leave as entire Drive to search all images, up to your max.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void openGooglePhotosPicker()}
                disabled={pickerBusy}
                className="rounded bg-amber-700/50 px-3 py-2 text-sm text-amber-100 hover:bg-amber-600/50 disabled:opacity-50"
              >
                {pickerBusy ? "Starting picker…" : "Open Google Photos picker"}
              </button>
              {pickerSessionId && (
                <span className="text-xs text-zinc-500">
                  Session ready — {pickerPhase === "ready" ? "items selected" : "choose photos in the other tab…"}
                </span>
              )}
            </div>
            {pickerErr && (
              <div className="space-y-2 rounded border border-red-900/40 bg-red-950/20 p-3">
                <p className="whitespace-pre-line text-xs text-red-300">{pickerErr}</p>
                {photosReauth && (
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href="https://myaccount.google.com/permissions"
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-amber-200/90 underline"
                    >
                      Open Google “Third-party access”
                    </a>
                    <button
                      type="button"
                      disabled={scopeDiagLoading}
                      onClick={() => {
                        void (async () => {
                          setScopeDiagLoading(true);
                          setScopeDiagJson(null);
                          try {
                            const r = await fetch("/api/photos/scope-diagnostics", {
                              credentials: "include",
                            });
                            const j = (await r.json()) as object;
                            setScopeDiagJson(JSON.stringify(j, null, 2));
                          } catch {
                            setScopeDiagJson('{"error":"Request failed"}');
                          } finally {
                            setScopeDiagLoading(false);
                          }
                        })();
                      }}
                      className="rounded border border-zinc-500 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
                    >
                      {scopeDiagLoading ? "…" : "Check token scopes"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          await signOut({ redirect: false });
                          await signIn(
                            "google",
                            { callbackUrl: "/drive" },
                            {
                              prompt: "select_account consent",
                              access_type: "offline",
                              include_granted_scopes: "false",
                            }
                          );
                        })();
                      }}
                      className="rounded bg-amber-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
                    >
                      Reconnect Google
                    </button>
                  </div>
                )}
                {scopeDiagJson && (
                  <pre className="max-h-48 overflow-auto rounded border border-zinc-700/80 bg-zinc-950/80 p-2 text-[11px] text-zinc-400">
                    {scopeDiagJson}
                  </pre>
                )}
                {photosReauth && !scopeDiagJson && (
                  <p className="text-[11px] text-zinc-500">
                    If hasPhotospickerReadonly is false after &quot;Check token scopes&quot;,
                    revoke the app at Third-party access, then Reconnect.
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-zinc-600">
              Google’s{" "}
              <a
                className="text-amber-200/80 underline"
                href="https://developers.google.com/photos/support/updates"
                target="_blank"
                rel="noreferrer"
              >
                current Photos access model
              </a>{" "}
              uses the <strong>Photos Picker</strong> (not library-wide API listing). In
              Cloud Console, enable the <strong>Photos Picker API</strong> and add OAuth
              scope <code className="rounded bg-zinc-800 px-1">photospicker.mediaitems.readonly</code>
              . After a scope change, revoke this app and sign in again.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs text-zinc-500">
            Max photos
            <input
              type="number"
              min={20}
              max={1000}
              step={10}
              className="ml-1 w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
              value={maxToLoad}
              onChange={(e) => setMaxToLoad(Number(e.target.value) || 200)}
            />
          </label>
        </div>
        <p className="text-xs text-zinc-600">
          {loadSource === "drive" ? (
            <>
              Fetches the most recently created image files, paging the Drive API until
              the limit (or the folder runs out). Large values take longer to rank.
            </>
          ) : (
            <>
              Loads the images you selected in the Google Photos picker (up to your max),
              paged if needed. The name filter below applies after load (you may get fewer
              than max).
            </>
          )}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label className="mb-0.5 block text-xs text-zinc-500">
              {loadSource === "drive"
                ? "Optional: file name contains (Drive query)"
                : "Optional: file name contains (filters after load)"}
            </label>
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. IMG, vacation, 2024"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadPool()}
            disabled={
              loading ||
              (loadSource === "photos" &&
                (!pickerSessionId || pickerPhase !== "ready"))
            }
            className="shrink-0 rounded bg-amber-600/90 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {loading ? (loadLabel || "Loading…") : loadActionLabel}
          </button>
        </div>
        {candidates.length > 0 && !loading && (
          <p className="text-xs text-zinc-400">
            {candidates.length} photo(s) in the pool. Next: add a description and rank.
          </p>
        )}
      </div>

      {/* Step 2: rank */}
      <div className="space-y-2 rounded-lg border border-amber-900/30 bg-zinc-900/50 p-4">
        <h2 className="text-sm font-medium text-amber-200/90">
          <span className="text-zinc-500">Step 2 ·</span> Match with a natural language description
        </h2>
        <textarea
          className="min-h-[4.5rem] w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. red kayak on a lake, foggy morning, people smiling at a picnic…"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={ranking}
            onClick={prewarm}
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
          >
            Prewarm local CLIP
          </button>
          <button
            type="button"
            disabled={ranking || !candidates.length || !prompt.trim()}
            onClick={() => void rankLocal()}
            className="rounded bg-amber-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            Rank with CLIP
          </button>
          <button
            type="button"
            disabled={ranking || !candidates.length || !prompt.trim()}
            onClick={() => void rankGemini()}
            className="rounded border border-violet-500/50 bg-violet-950/30 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-900/50 disabled:opacity-50"
          >
            Rank with Gemini
          </button>
          <button
            type="button"
            onClick={sortChrono}
            disabled={!candidates.length}
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-50"
          >
            Re-sort by date
          </button>
        </div>
        {modelProg !== null && (
          <p className="text-xs text-amber-200/80">
            CLIP: {modelProg < 1 ? `${Math.round(modelProg * 100)}%` : "ready"}
          </p>
        )}
        {sortNote && (
          <p className="text-xs text-zinc-500">{sortNote}</p>
        )}
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {/* Step 3: select */}
      {candidates.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium text-emerald-200/90">
            <span className="text-zinc-500">Step 3 ·</span> Select photos for the composite
            {selectedIds.size > 0 && (
              <span className="ml-2 text-zinc-500">
                ({selectedIds.size} selected
                {selectedIds.size > MAX_EDITOR
                  ? ` — only the first ${MAX_EDITOR} will open in the editor`
                  : ""}
                )
              </span>
            )}
          </h2>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={selectAll}
              className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300"
            >
              Clear
            </button>
            <span className="text-xs text-zinc-500">Select top</span>
            <button
              type="button"
              onClick={() => selectTopK(5)}
              className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300"
            >
              5
            </button>
            <button
              type="button"
              onClick={() => selectTopK(10)}
              className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300"
            >
              10
            </button>
            <button
              type="button"
              onClick={() => selectTopK(20)}
              className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300"
            >
              20
            </button>
            <button
              type="button"
              onClick={openEditor}
              className="ml-auto rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Open in editor
            </button>
          </div>
          <p className="mb-2 text-xs text-zinc-600">
            Order in the list is the current sort (after ranking, best match is first). The
            editor will use the same order among your selection.
          </p>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {candidates.map((f) => {
              const sel = selectedIds.has(f.id);
              const pct = scorePct(f.id);
              return (
                <li key={f.id} className="space-y-1">
                  <div
                    className={`overflow-hidden rounded border bg-zinc-800 ${
                      sel
                        ? "border-emerald-500 ring-1 ring-emerald-500/50"
                        : "border-zinc-700"
                    }`}
                  >
                    <div className="flex items-center gap-2 border-b border-zinc-700 bg-zinc-900/80 px-2 py-1">
                      <input
                        type="checkbox"
                        className="rounded border-zinc-600"
                        checked={sel}
                        onChange={() => toggleSelect(f.id)}
                        aria-label={`Select ${f.name}`}
                      />
                      {pct !== null && (
                        <span className="text-xs text-amber-200/80">{pct}%</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="block w-full"
                      onClick={() => toggleSelect(f.id)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={poolThumbUrl(f)}
                        alt=""
                        className="aspect-square w-full object-cover"
                      />
                    </button>
                  </div>
                  <p className="truncate text-xs text-zinc-500">{f.name}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {candidates.length === 0 && !loading && (
        <p className="text-sm text-zinc-600">Load a pool (Drive or Google Photos) to begin.</p>
      )}
    </div>
  );
}
