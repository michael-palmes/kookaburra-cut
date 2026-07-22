import { useCallback, useEffect, useRef, useState } from "react";
import { useDecorationEditStore } from "../engine/decorationEditStore";
import { type HistoryChange, pushHistory } from "../engine/history";
import { type LoadedProject, resolveAssetUrl, workspaceSlug } from "../engine/project";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { FrameDecorationSpec } from "../toolkit/frame/types";

/** A direct-manipulation overlay for the active scene's panel decorations: a DOM layer over the letterboxed stage (the export can't see DOM, the CameraToolOverlay precedent) that draws a box per decoration, drags it to move and resizes it from the corners. A decoration's frame-relative `position` is exactly its NDC under the base pose and the stage matches the frame aspect, so boxes place with plain percentages and pointer maths runs in NDC. Move and resize are data-only (position/size are in the schema); rotate arrives in the next step. See docs/overlays.md. */

/** Size clamp (fraction of frame width) while dragging a corner. */
const MIN_SIZE = 0.02;
const MAX_SIZE = 1.5;

/** The four resize corners: NDC sign of the offset from centre (y up), the CSS anchor within the box, and the diagonal cursor. */
const HANDLES = [
  { id: "tl", cx: -1, cy: 1, left: "0%", top: "0%", cursor: "nwse-resize" },
  { id: "tr", cx: 1, cy: 1, left: "100%", top: "0%", cursor: "nesw-resize" },
  { id: "bl", cx: -1, cy: -1, left: "0%", top: "100%", cursor: "nesw-resize" },
  { id: "br", cx: 1, cy: -1, left: "100%", top: "100%", cursor: "nwse-resize" },
] as const;

type Drag =
  | {
      mode: "move";
      id: string;
      startX: number;
      startY: number;
      origPos: [number, number];
      origDoc: SceneDoc | null;
    }
  | {
      mode: "resize";
      id: string;
      /** The fixed (opposite) corner in NDC. */
      fixed: [number, number];
      /** Vector from the fixed corner to the dragged corner in NDC. */
      diag: [number, number];
      size0: number;
      origDoc: SceneDoc | null;
    };

export function DecorationGizmo({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  /** Frame aspect (width / height); a box's NDC half-height is `size · aspect / imageAspect`. */
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const selectedId = useDecorationEditStore((s) => s.selectedId);
  const select = useDecorationEditStore((s) => s.select);
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const pending = useRef<FrameDecorationSpec[] | null>(null);
  const [imgAspect, setImgAspect] = useState<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());

  const decorations = project.sceneFrames[sceneIndex]?.decorations ?? [];
  const slug = workspaceSlug(project.id);
  const sceneFile = project.sceneFiles[sceneIndex];
  const doc = project.sceneDocs[sceneIndex] ?? null;

  /** A decoration's NDC half-height from its size, the frame aspect and the image aspect (circles stay square). */
  const halfHeight = useCallback(
    (d: FrameDecorationSpec) =>
      d.size * (aspect / (d.shape === "circle" ? 1 : (imgAspect[d.src] ?? 1))),
    [aspect, imgAspect],
  );

  // Each decoration image's natural aspect, for the box height (shape "none"); circle stays square.
  const srcKey = decorations.map((d) => d.src).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: srcKey stands in for decorations; the array itself is a fresh identity each render
  useEffect(() => {
    let alive = true;
    for (const d of decorations) {
      if (requested.current.has(d.src)) continue;
      requested.current.add(d.src);
      let url: string;
      try {
        url = resolveAssetUrl(project.id, d.src);
      } catch {
        continue;
      }
      const img = new Image();
      img.onload = () => {
        if (alive && img.naturalHeight > 0) {
          setImgAspect((m) => ({ ...m, [d.src]: img.naturalWidth / img.naturalHeight }));
        }
      };
      img.src = url;
    }
    return () => {
      alive = false;
    };
  }, [srcKey, project.id]);

  // Drop the selection when the gizmo unmounts (drill-in closed).
  useEffect(() => () => select(null), [select]);

  const buildDoc = useCallback((base: SceneDoc | null, decos: FrameDecorationSpec[]): SceneDoc => {
    const next = base ? structuredClone(base) : ({ version: 1 } as SceneDoc);
    next.frame = { ...(next.frame ?? {}), decorations: decos };
    return next;
  }, []);

  const commit = useCallback(
    async (base: SceneDoc | null, decos: FrameDecorationSpec[], label: string) => {
      if (!sceneFile) return;
      const next = buildDoc(base, decos);
      try {
        await writeSceneDoc(slug, sceneFile, next);
        onDocChanged(sceneIndex, next);
        const change: HistoryChange = {
          kind: "sceneDoc",
          slug,
          file: sceneFile,
          sceneIndex,
          before: base ? structuredClone(base) : null,
          after: structuredClone(next),
        };
        pushHistory({ label, changes: [change] });
      } catch (e) {
        console.warn("[decoration-edit] sidecar write failed:", e);
      }
    },
    [slug, sceneFile, sceneIndex, onDocChanged, buildDoc],
  );

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const id = target.dataset.decoId;
    if (!id) {
      select(null);
      return;
    }
    const d = decorations.find((x) => x.id === id);
    if (!d) return;
    layerRef.current?.setPointerCapture(e.pointerId);
    select(id);
    pending.current = null;
    const corner = HANDLES.find((h) => h.id === target.dataset.corner);
    if (corner) {
      const hw = d.size;
      const hh = halfHeight(d);
      const [px, py] = d.position;
      const fixed: [number, number] = [px - corner.cx * hw, py - corner.cy * hh];
      setDrag({
        mode: "resize",
        id,
        fixed,
        diag: [2 * corner.cx * hw, 2 * corner.cy * hh],
        size0: d.size,
        origDoc: doc,
      });
    } else {
      setDrag({
        mode: "move",
        id,
        startX: e.clientX,
        startY: e.clientY,
        origPos: [...d.position],
        origDoc: doc,
      });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    let decos: FrameDecorationSpec[];
    if (drag.mode === "move") {
      const nx = drag.origPos[0] + (2 * (e.clientX - drag.startX)) / rect.width;
      const ny = drag.origPos[1] - (2 * (e.clientY - drag.startY)) / rect.height;
      decos = decorations.map((x) =>
        x.id === drag.id ? { ...x, position: [nx, ny] as [number, number] } : x,
      );
    } else {
      // Project the pointer onto the box diagonal (aspect-locked uniform scale), opposite corner fixed.
      const qx = (2 * (e.clientX - rect.left)) / rect.width - 1;
      const qy = 1 - (2 * (e.clientY - rect.top)) / rect.height;
      const [fx, fy] = drag.fixed;
      const [dx, dy] = drag.diag;
      const dd = dx * dx + dy * dy;
      const s = dd > 0 ? ((qx - fx) * dx + (qy - fy) * dy) / dd : 1;
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, drag.size0 * s));
      const k = size / drag.size0;
      const pos: [number, number] = [fx + (k * dx) / 2, fy + (k * dy) / 2];
      decos = decorations.map((x) => (x.id === drag.id ? { ...x, position: pos, size } : x));
    }
    pending.current = decos;
    // Live preview: an in-memory patch (no disk, no history), so the decoration tracks the pointer.
    onDocChanged(sceneIndex, buildDoc(drag.origDoc, decos));
  }

  function onPointerUp() {
    if (!drag) return;
    if (pending.current) {
      void commit(
        drag.origDoc,
        pending.current,
        drag.mode === "resize" ? "resize decoration" : "move decoration",
      );
    }
    pending.current = null;
    setDrag(null);
  }

  return (
    <div
      ref={layerRef}
      className="decoration-gizmo-layer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {decorations.map((d) => {
        const selected = d.id === selectedId;
        return (
          <div
            key={d.id}
            data-deco-id={d.id}
            className={`deco-gizmo-box${selected ? " selected" : ""}`}
            style={{
              left: `${((d.position[0] + 1) / 2) * 100}%`,
              top: `${((1 - d.position[1]) / 2) * 100}%`,
              width: `${d.size * 100}%`,
              height: `${halfHeight(d) * 100}%`,
            }}
          >
            {selected &&
              HANDLES.map((h) => (
                <div
                  key={h.id}
                  data-deco-id={d.id}
                  data-corner={h.id}
                  className="deco-gizmo-handle"
                  style={{ left: h.left, top: h.top, cursor: h.cursor }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
