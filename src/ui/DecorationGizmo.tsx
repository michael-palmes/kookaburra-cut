import { useCallback, useEffect, useRef, useState } from "react";
import { useDecorationEditStore } from "../engine/decorationEditStore";
import { type HistoryChange, pushHistory } from "../engine/history";
import { type LoadedProject, resolveAssetUrl, workspaceSlug } from "../engine/project";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { FrameDecorationSpec } from "../toolkit/frame/types";

/** A direct-manipulation overlay for the active scene's panel decorations: a DOM layer over the letterboxed stage (the export can't see DOM, the CameraToolOverlay precedent) that draws a box per decoration and drags it to move. A decoration's frame-relative `position` is exactly its NDC under the base pose and the stage matches the frame aspect, so boxes place with plain percentages and a drag maps px deltas 1:1. Move is data-only (position is already in the schema); resize and rotate arrive in later steps. See docs/overlays.md. */

interface MoveDrag {
  id: string;
  startX: number;
  startY: number;
  origPos: [number, number];
  origDoc: SceneDoc | null;
}

export function DecorationGizmo({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  /** Frame aspect (width / height); a box's height fraction is `size · aspect / imageAspect`. */
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const selectedId = useDecorationEditStore((s) => s.selectedId);
  const select = useDecorationEditStore((s) => s.select);
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const pending = useRef<FrameDecorationSpec[] | null>(null);
  const [imgAspect, setImgAspect] = useState<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());

  const decorations = project.sceneFrames[sceneIndex]?.decorations ?? [];
  const slug = workspaceSlug(project.id);
  const sceneFile = project.sceneFiles[sceneIndex];
  const doc = project.sceneDocs[sceneIndex] ?? null;

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
    async (base: SceneDoc | null, decos: FrameDecorationSpec[]) => {
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
        pushHistory({ label: "move decoration", changes: [change] });
      } catch (e) {
        console.warn("[decoration-edit] sidecar write failed:", e);
      }
    },
    [slug, sceneFile, sceneIndex, onDocChanged, buildDoc],
  );

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const id = (e.target as HTMLElement).dataset.decoId;
    if (!id) {
      select(null);
      return;
    }
    const d = decorations.find((x) => x.id === id);
    if (!d) return;
    layerRef.current?.setPointerCapture(e.pointerId);
    select(id);
    setDrag({ id, startX: e.clientX, startY: e.clientY, origPos: [...d.position], origDoc: doc });
    pending.current = null;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const nx = drag.origPos[0] + (2 * (e.clientX - drag.startX)) / rect.width;
    const ny = drag.origPos[1] - (2 * (e.clientY - drag.startY)) / rect.height;
    const decos = decorations.map((x) =>
      x.id === drag.id ? { ...x, position: [nx, ny] as [number, number] } : x,
    );
    pending.current = decos;
    // Live preview: an in-memory patch (no disk, no history), so the decoration tracks the pointer.
    onDocChanged(sceneIndex, buildDoc(drag.origDoc, decos));
  }

  function onPointerUp() {
    if (!drag) return;
    if (pending.current) void commit(drag.origDoc, pending.current);
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
        const a = d.shape === "circle" ? 1 : (imgAspect[d.src] ?? 1);
        return (
          <div
            key={d.id}
            data-deco-id={d.id}
            className={`deco-gizmo-box${d.id === selectedId ? " selected" : ""}`}
            style={{
              left: `${((d.position[0] + 1) / 2) * 100}%`,
              top: `${((1 - d.position[1]) / 2) * 100}%`,
              width: `${d.size * 100}%`,
              height: `${d.size * 100 * (aspect / a)}%`,
            }}
          />
        );
      })}
    </div>
  );
}
