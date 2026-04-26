"use client";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  loadImageElement,
  buildComposite,
  imageDataToPngBlob,
  rasterizeLayer,
  type TransformState,
} from "@/lib/image/renderStack";
import { meanLuminanceFromImageData as meanLuma } from "@/lib/image/luminance";
import { photosPickerFetchPath } from "@/lib/photosPickerPath";
import { loadWorkingSet, saveWorkingSet, type WorkingItem } from "@/lib/workingSet";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";

function defaultTransform(): TransformState {
  return { tx: 0, ty: 0, rotDeg: 0, scale: 1 };
}

/** Same range as the Transform (selected) scale slider. */
const LAYER_SCALE_MIN = 0.2;
const LAYER_SCALE_MAX = 3;

const PREVIEW_ZOOM_MIN = 0.2;
const PREVIEW_ZOOM_MAX = 4;

type AlignStatus =
  | { phase: "idle" }
  | { phase: "fetch"; at: number; of: number }
  | { phase: "api" }
  | { phase: "apply" }
  | { phase: "success"; layerCount: number; failedLayers: number[]; partialMessage?: string }
  | { phase: "error"; message: string };

function AutoAlignStatusBanner({ status, busy }: { status: AlignStatus; busy: boolean }) {
  if (status.phase === "idle") return null;
  const box = "rounded border px-3 py-2 text-xs leading-relaxed";
  if (status.phase === "error") {
    return (
      <div
        role="status"
        aria-live="assertive"
        className={`${box} border-amber-700/50 bg-amber-950/40 text-amber-100`}
      >
        <p className="font-medium text-amber-50/95">Auto-align did not complete</p>
        <p className="mt-1 text-amber-200/90">{status.message}</p>
      </div>
    );
  }
  if (status.phase === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`${box} border-emerald-700/50 bg-emerald-950/35 text-emerald-100`}
      >
        <p className="font-medium text-emerald-50/95">Auto-align finished</p>
        <p className="mt-1 text-emerald-200/90">
          The align service returned successfully and the editor&rsquo;s transform values were
          updated for this stack ({status.layerCount} layers; the first in the list is the
          fixed reference and stays at identity).
        </p>
        {status.failedLayers.length > 0 && status.partialMessage ? (
          <p className="mt-1.5 text-amber-200/90">{status.partialMessage}</p>
        ) : null}
      </div>
    );
  }
  const line =
    status.phase === "fetch"
      ? `1 — Downloading full images: ${status.at} / ${status.of}…`
      : status.phase === "api"
        ? "2 — Request sent. Waiting for /api/align and the sidecar…"
        : "3 — Applying returned values to transform sliders in the editor…";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${box} border-violet-600/40 bg-violet-950/40 text-violet-100`}
    >
      <div className="flex items-start gap-2.5">
        {busy ? (
          <span
            className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-violet-300/20 border-t-violet-200"
            aria-hidden
          />
        ) : null}
        <div>
          <p className="font-medium text-violet-50/95">Auto-align running</p>
          <p className="mt-0.5 text-violet-200/90">{line}</p>
        </div>
      </div>
    </div>
  );
}

function SortRow({
  item,
  selected,
  onSelect,
}: {
  item: WorkingItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex cursor-grab items-center gap-2 rounded border px-2 py-2 text-sm active:cursor-grabbing ${
        selected
          ? "border-amber-500/80 bg-amber-950/40"
          : "border-zinc-700 bg-zinc-900/60"
      }`}
    >
      <button
        type="button"
        className="touch-none text-zinc-500"
        {...attributes}
        {...listeners}
        aria-label="Drag"
      >
        ⋮⋮
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 truncate text-left text-zinc-200"
      >
        {item.name}
      </button>
      <span className="shrink-0 text-xs text-zinc-600">
        {new Date(item.imageTime).toLocaleDateString()}
      </span>
    </li>
  );
}

export function EditorView() {
  const [items, setItems] = useState<WorkingItem[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [transforms, setTransforms] = useState<Record<string, TransformState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exposureRef, setExposureRef] = useState<"first" | "middle" | "last">("middle");
  const [matchExposure, setMatchExposure] = useState(true);
  const [maxSide, setMaxSide] = useState(1600);
  const [loaded, setLoaded] = useState<Map<string, HTMLImageElement> | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewZoom, setViewZoom] = useState(1);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  /** For wheel: listener deps stay stable; read current selection without stale closure. */
  const selectedIdRef = useRef<string | null>(null);
  const vPanRef = useRef<{
    pointerId: number;
    lastY: number;
  } | null>(null);
  const [previewDragging, setPreviewDragging] = useState(false);
  const [alignBusy, setAlignBusy] = useState(false);
  const [alignStatus, setAlignStatus] = useState<AlignStatus>({ phase: "idle" });
  selectedIdRef.current = selectedId;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useLayoutEffect(() => {
    queueMicrotask(() => {
      const w = loadWorkingSet();
      setItems(w);
      const o = w
        .slice()
        .sort(
          (a, b) =>
            new Date(a.imageTime).getTime() - new Date(b.imageTime).getTime()
        )
        .map((x) => x.id);
      setOrder(o);
      if (o[0]) setSelectedId(o[0]!);
      const tr: Record<string, TransformState> = {};
      for (const x of w) {
        tr[x.id] = defaultTransform();
      }
      setTransforms(tr);
    });
  }, []);

  const mediaUrl = useCallback(
    (id: string, full: boolean) => {
      const it = items.find((x) => x.id === id);
      if (it?.source === "photos" && it.pickerBaseUrl) {
        return new URL(
          photosPickerFetchPath(it.pickerBaseUrl, { thumb: !full }),
          window.location.origin
        ).toString();
      }
      const path =
        it?.source === "photos"
          ? `/api/photos/media/${id}${full ? "" : "?thumb=1"}`
          : `/api/drive/media/${id}${full ? "" : "?thumb=1"}`;
      return new URL(path, window.location.origin).toString();
    },
    [items]
  );

  useEffect(() => {
    if (order.length === 0) {
      queueMicrotask(() => {
        setLoaded(new Map());
      });
      return;
    }
    let cancel = false;
    queueMicrotask(() => {
      if (!cancel) setLoading(true);
    });
    (async () => {
      const m = new Map<string, HTMLImageElement>();
      for (const id of order) {
        try {
          const img = await loadImageElement(mediaUrl(id, true));
          m.set(id, img);
        } catch {
          // skip
        }
        if (cancel) return;
      }
      if (!cancel) {
        setLoaded(m);
        setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [order, mediaUrl]);

  const orderedLayers = useMemo(() => {
    if (!loaded) return [];
    return order
      .map((id) => {
        const img = loaded.get(id);
        if (!img) return null;
        return { id, img, t: transforms[id] || defaultTransform() };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [loaded, order, transforms]);

  const previewData = useMemo(() => {
    if (orderedLayers.length === 0) return null;
    const first = orderedLayers[0]!.img;
    const ar = first.naturalWidth
      ? first.naturalHeight / first.naturalWidth
      : 1;
    const outW = maxSide;
    const outH = Math.max(1, Math.round(maxSide * ar));

    let exposureToRef: number | null = null;
    if (matchExposure && orderedLayers.length) {
      const rIdx =
        exposureRef === "first"
          ? 0
          : exposureRef === "last"
            ? orderedLayers.length - 1
            : Math.floor((orderedLayers.length - 1) / 2);
      const refLayer = orderedLayers[rIdx]!;
      const rIm = rasterizeLayer(
        refLayer.img,
        refLayer.t,
        outW,
        outH
      );
      exposureToRef = meanLuma(rIm);
    }

    return buildComposite(orderedLayers, outW, outH, {
      exposureToRef: matchExposure ? exposureToRef : null,
    });
  }, [orderedLayers, maxSide, matchExposure, exposureRef]);

  useLayoutEffect(() => {
    const c = previewCanvasRef.current;
    if (!c || !previewData) return;
    c.width = previewData.width;
    c.height = previewData.height;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.putImageData(previewData, 0, 0);
    }
  }, [previewData]);

  useEffect(() => {
    if (orderedLayers.length === 0) return;
    const el = previewScrollRef.current;
    if (!el) return;
    const modZoom = (e: WheelEvent) =>
      e.ctrlKey ||
      e.metaKey ||
      (typeof e.getModifierState === "function" &&
        (e.getModifierState("Control") || e.getModifierState("Meta")));

    const onWheel = (e: WheelEvent) => {
      if (!modZoom(e)) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const id = selectedIdRef.current;
      if (id) {
        const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
        setTransforms((tr) => {
          const cur = tr[id] || defaultTransform();
          const next = Math.min(
            LAYER_SCALE_MAX,
            Math.max(LAYER_SCALE_MIN, cur.scale * factor)
          );
          return { ...tr, [id]: { ...cur, scale: next } };
        });
      } else {
        setViewZoom((z) => {
          const next = e.deltaY < 0 ? z * 1.1 : z / 1.1;
          return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, next));
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, true);
  }, [orderedLayers.length]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
        setOrder((o) => {
        const a = o.indexOf(String(active.id));
        const b = o.indexOf(String(over.id));
        if (a < 0 || b < 0) return o;
        const n = arrayMove(o, a, b);
        const reordered: WorkingItem[] = [];
        for (const id of n) {
          const it = items.find((i) => i.id === id);
          if (it) reordered.push(it);
        }
        saveWorkingSet(reordered);
        return n;
      });
    }
  };

  const updateSelected = (patch: Partial<TransformState>) => {
    if (!selectedId) return;
    setTransforms((tr) => ({
      ...tr,
      [selectedId]: { ...(tr[selectedId] || defaultTransform()), ...patch },
    }));
  };

  const onPreviewPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!selectedId || !previewData) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    vPanRef.current = { pointerId: e.pointerId, lastY: e.clientY };
    setPreviewDragging(true);
  };

  const onPreviewPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!vPanRef.current || vPanRef.current.pointerId !== e.pointerId || !selectedId) return;
    if (!previewData) return;
    const canvas = e.currentTarget;
    const r = canvas.getBoundingClientRect();
    const scaleH = previewData.height / r.height;
    const dy = (e.clientY - vPanRef.current.lastY) * scaleH;
    vPanRef.current = { ...vPanRef.current, lastY: e.clientY };
    setTransforms((tr) => {
      const cur = tr[selectedId!] || defaultTransform();
      return {
        ...tr,
        [selectedId!]: { ...cur, ty: cur.ty + dy },
      };
    });
  };

  const onPreviewPointerEnd = (e: PointerEvent<HTMLCanvasElement>) => {
    if (vPanRef.current?.pointerId === e.pointerId) {
      vPanRef.current = null;
    }
    setPreviewDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const downloadPng = async () => {
    if (!previewData) return;
    const b = await imageDataToPngBlob(previewData);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "season-blend.png";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runAutoAlign = async () => {
    if (!loaded || order.length < 1) return;
    setAlignBusy(true);
    try {
      const form = new FormData();
      form.append("refIndex", "0");
      form.append("workWidth", String(maxSide));
      for (let i = 0; i < order.length; i++) {
        const id = order[i]!;
        setAlignStatus({ phase: "fetch", at: i + 1, of: order.length });
        const u = mediaUrl(id, true);
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) {
          throw new Error(`Failed to fetch image: ${r.status}`);
        }
        const blob = await r.blob();
        form.append("files", blob, "layer.jpg");
      }
      setAlignStatus({ phase: "api" });
      const res = await fetch("/api/align", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        hint?: string;
        transforms?: {
          tx: number;
          ty: number;
          rotDeg: number;
          scale: number;
          error?: string;
          inliers?: number | null;
        }[];
      };
      if (!res.ok) {
        const msg = [j.error, j.hint].filter(Boolean).join(" ");
        throw new Error(msg || "Align request failed");
      }
      if (!j.ok) {
        throw new Error(j.error || "Align service returned not ok");
      }
      const tlist = j.transforms;
      if (!tlist || tlist.length !== order.length) {
        throw new Error("Invalid align response");
      }
      setAlignStatus({ phase: "apply" });
      const failed = tlist
        .map((t, i) => (t.error ? i : -1))
        .filter((x) => x >= 0);
      setTransforms((prev) => {
        const next = { ...prev };
        for (let i = 0; i < order.length; i++) {
          const id = order[i]!;
          const t = tlist[i]!;
          if (t.error) continue;
          next[id] = {
            tx: t.tx,
            ty: t.ty,
            rotDeg: t.rotDeg,
            scale: t.scale,
          };
        }
        return next;
      });
      setAlignStatus({
        phase: "success",
        layerCount: order.length,
        failedLayers: failed.map((i) => i + 1),
        partialMessage:
          failed.length > 0
            ? `Some layers could not be matched; previous transforms were kept for layer index(es): ${failed.map((i) => i + 1).join(", ")}.`
            : undefined,
      });
    } catch (e) {
      setAlignStatus({
        phase: "error",
        message: e instanceof Error ? e.message : "Auto-align failed",
      });
    } finally {
      setAlignBusy(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-700 p-8 text-center text-sm text-zinc-500">
        No images in the working set.{" "}
        <Link className="text-amber-400 hover:underline" href="/drive">
          Pick images in Drive
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-white">Layer order & align</h1>
        <p className="text-xs text-zinc-500">
          Drag to reorder. The preview is a <strong>horizontal strip blend</strong>: one
          full-height column per layer, equal width, left → right (first in list = left).
          Auto-align uses the <strong>first</strong> layer as the reference frame.
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1">
              {order.map((id) => {
                const it = items.find((x) => x.id === id);
                if (!it) return null;
                return (
                  <SortRow
                    key={id}
                    item={it}
                    selected={selectedId === id}
                    onSelect={() => setSelectedId(id)}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>

        {selectedId && (
          <div className="space-y-2 rounded border border-zinc-800 p-3">
            <h2 className="text-sm font-medium text-zinc-300">Transform (selected)</h2>
            {(["tx", "ty", "rotDeg", "scale"] as const).map((key) => (
              <label key={key} className="block text-xs text-zinc-500">
                {key}
                <input
                  type="range"
                  className="w-full"
                  min={key === "tx" ? -900 : key === "ty" ? -1000 : key === "rotDeg" ? -45 : LAYER_SCALE_MIN}
                  max={key === "tx" ? 900 : key === "ty" ? 1000 : key === "rotDeg" ? 45 : LAYER_SCALE_MAX}
                  step={key === "scale" ? 0.01 : 1}
                  value={
                    (transforms[selectedId] || defaultTransform())[key] as number
                  }
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (key === "tx" || key === "ty" || key === "rotDeg" || key === "scale")
                      updateSelected({ [key]: v } as Partial<TransformState>);
                  }}
                />
              </label>
            ))}
          </div>
        )}

        <div className="space-y-2 rounded border border-zinc-800 p-3">
          <h2 className="text-sm font-medium text-zinc-300">Strip composite</h2>
          <p className="text-xs text-zinc-500">
            Each layer is one column of the row; order is left to right.
          </p>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={matchExposure}
              onChange={(e) => setMatchExposure(e.target.checked)}
            />
            Match exposure to reference
          </label>
          {matchExposure && (
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Reference layer
              <select
                className="rounded border border-zinc-600 bg-zinc-900 px-2 py-1"
                value={exposureRef}
                onChange={(e) =>
                  setExposureRef(e.target.value as "first" | "middle" | "last")
                }
              >
                <option value="first">First in order</option>
                <option value="middle">Middle</option>
                <option value="last">Last in order</option>
              </select>
            </label>
          )}
          <label className="block text-xs text-zinc-400">
            Max width (px)
            <input
              type="range"
              className="w-full"
              min={400}
              max={4000}
              step={100}
              value={maxSide}
              onChange={(e) => setMaxSide(Number(e.target.value))}
            />
            <span className="text-zinc-500">{maxSide}</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runAutoAlign()}
            disabled={alignBusy || !loaded || order.length < 2}
            className="rounded border border-violet-500/50 bg-violet-950/40 px-4 py-2 text-sm text-violet-200 hover:bg-violet-900/50 disabled:opacity-50"
            title="Requires ALIGN_SERVICE_URL and the Python sidecar; see sidecar/README.md"
          >
            {alignBusy ? "Auto-align…" : "Auto-align layers"}
          </button>
          <button
            type="button"
            onClick={() => void downloadPng()}
            className="rounded bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={!previewData}
          >
            Download PNG
          </button>
        </div>
        <AutoAlignStatusBanner status={alignStatus} busy={alignBusy} />
      </div>

      <div className="min-h-[320px] space-y-2">
        {loading && <p className="text-sm text-zinc-500">Loading full images…</p>}
        {previewData && (
          <div>
            <AutoAlignStatusBanner status={alignStatus} busy={alignBusy} />
            <p className="mb-1 mt-2 text-xs text-zinc-500">
              {selectedId ? (
                <>
                  <strong>Drag</strong> on the preview to move the selected layer vertically.{" "}
                  <strong>+ / −</strong> or the zoom label below: whole preview.{" "}
                  <strong>Ctrl+mouse wheel</strong> (⌘+scroll on Mac) on the preview: selected
                  layer <code className="text-zinc-400">scale</code> (same as the Transform
                  slider).
                </>
              ) : (
                "Select a layer, then drag on the preview to nudge it vertically. + / − change whole-preview zoom. Ctrl+scroll changes the selected layer’s scale when a row is active."
              )}
            </p>
            <div
              ref={previewScrollRef}
              className="max-h-[70vh] overflow-auto rounded border border-zinc-800 bg-zinc-900/40 p-2"
            >
              <div
                className="inline-block"
                style={{
                  width: previewData.width * viewZoom,
                  height: previewData.height * viewZoom,
                }}
              >
                <canvas
                  ref={previewCanvasRef}
                  width={previewData.width}
                  height={previewData.height}
                  className="block h-full w-full"
                  style={{
                    touchAction: "none",
                    cursor:
                      !selectedId
                        ? "default"
                        : previewDragging
                          ? "grabbing"
                          : "ns-resize",
                  }}
                  onPointerDown={onPreviewPointerDown}
                  onPointerMove={onPreviewPointerMove}
                  onPointerUp={onPreviewPointerEnd}
                  onPointerCancel={onPreviewPointerEnd}
                />
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
              <span>
                Preview zoom: {Math.round(viewZoom * 100)}% — magnifies the composite only; export
                size still follows &quot;Max width&quot;
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Zoom whole preview out"
                  className="rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-sm text-zinc-200 hover:bg-zinc-700"
                  onClick={() =>
                    setViewZoom((z) =>
                      Math.max(PREVIEW_ZOOM_MIN, z / 1.1)
                    )
                  }
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="Zoom whole preview in"
                  className="rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-sm text-zinc-200 hover:bg-zinc-700"
                  onClick={() =>
                    setViewZoom((z) => Math.min(PREVIEW_ZOOM_MAX, z * 1.1))
                  }
                >
                  +
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
