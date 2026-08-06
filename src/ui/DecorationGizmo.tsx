import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { useDecorationEditStore } from "../engine/decorationEditStore";
import type { StageRect } from "../engine/gizmoRegistry";
import { type LoadedProject, resolveAssetUrl } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { FrameDecorationSpec } from "../toolkit/frame/types";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import type { Pt } from "./gizmo/gizmo2dMath";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";

/** Direct manipulation for the active scene's panel decorations: move, aspect-locked corner resize, rotate and smart alignment guides, hosted on the shared `Gizmo2D` layer. Decorations are drawn by `FrameDecoration` at `position × format.frame / 2` inside the overlay panel, which the compositor draws from the BASE pose, so world-to-stage pixels is a fixed linear map here and no camera is involved. See docs/overlays.md. */

/** Size clamp (fraction of frame width) while dragging a corner. */
const MIN_SIZE = 0.02;
const MAX_SIZE = 1.5;

/** Decoration centre in stage pixels. */
function centrePx(d: FrameDecorationSpec, rect: StageRect): Pt {
  return [
    rect.left + ((d.position[0] + 1) / 2) * rect.width,
    rect.top + ((1 - d.position[1]) / 2) * rect.height,
  ];
}

/** Stage pixels back to a frame-relative position. */
function toPos(x: number, y: number, rect: StageRect): [number, number] {
  return [(2 * (x - rect.left)) / rect.width - 1, 1 - (2 * (y - rect.top)) / rect.height];
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
  const requestMedia = useDecorationEditStore((s) => s.requestMedia);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [imgAspect, setImgAspect] = useState<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());
  const { preview, commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);

  const decorations = project.sceneFrames[sceneIndex]?.decorations ?? [];
  const doc = project.sceneDocs[sceneIndex] ?? null;

  /** A decoration's box height as a fraction of the frame height (also the NDC half-height). */
  const heightFrac = useCallback(
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

  const writeDecorations = useCallback(
    (decos: FrameDecorationSpec[]) => (next: SceneDoc) => {
      next.frame = { ...(next.frame ?? {}), decorations: decos };
    },
    [],
  );

  // Latest decorations/doc for the keydown handler, which mounts once.
  const latest = useRef({ decorations, doc });
  latest.current = { decorations, doc };
  // Delete/Backspace removes the selected decoration (undoable), unless a text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const id = useDecorationEditStore.getState().selectedId;
      if (!id) return;
      e.preventDefault();
      const { decorations: decos, doc: base } = latest.current;
      void commit(base, writeDecorations(decos.filter((x) => x.id !== id)), "delete decoration");
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, select, writeDecorations]);

  const items = useMemo<Gizmo2DItem[]>(
    () =>
      decorations.map((d) => ({
        id: d.id,
        can: { move: true, resize: true, rotate: true },
        frame: (rect: StageRect) => {
          const [cx, cy] = centrePx(d, rect);
          return {
            cx,
            cy,
            w: d.size * rect.width,
            h: heightFrac(d) * rect.height,
            deg: d.rotationDeg ?? 0,
            pivot: [cx, cy] as Pt,
          };
        },
      })),
    [decorations, heightFrac],
  );

  // The frame centre only, which is exactly what decorations have always snapped to.
  const frameGuides = useCallback(
    (rect: StageRect) => ({
      x: [rect.left + rect.width / 2],
      y: [rect.top + rect.height / 2],
    }),
    [],
  );

  const run = useRef<{
    id: string;
    kind: Gizmo2DGesture["kind"];
    doc: SceneDoc | null;
    deco: FrameDecorationSpec;
  } | null>(null);
  const pending = useRef<FrameDecorationSpec[] | null>(null);

  const onGesture = (g: Gizmo2DGesture) => {
    let started = run.current;
    if (!started || started.id !== g.id || started.kind !== g.kind) {
      const deco = decorations.find((d) => d.id === g.id);
      if (!deco) return;
      started = { id: g.id, kind: g.kind, doc, deco: { ...deco } };
      run.current = started;
      pending.current = null;
    }
    const d0 = started.deco;
    let patch: Partial<FrameDecorationSpec>;
    if (g.kind === "move") {
      const [cx, cy] = centrePx(d0, g.rect);
      patch = { position: toPos(cx + g.dxPx, cy + g.dyPx, g.rect) };
    } else if (g.kind === "resize") {
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, d0.size * g.factor));
      const k = size / d0.size;
      patch = {
        position: toPos(
          g.fixedPx[0] + (k * g.diagPx[0]) / 2,
          g.fixedPx[1] + (k * g.diagPx[1]) / 2,
          g.rect,
        ),
        size,
      };
    } else {
      patch = { rotationDeg: g.deg };
    }
    const decos = decorations.map((x) => (x.id === g.id ? { ...x, ...patch } : x));
    pending.current = decos;
    preview(started.doc, writeDecorations(decos));
  };

  const onGestureEnd = (g: Gizmo2DGesture | null) => {
    const started = run.current;
    const decos = pending.current;
    run.current = null;
    pending.current = null;
    if (!g || !started || !decos) return;
    const label =
      g.kind === "resize"
        ? "resize decoration"
        : g.kind === "rotate"
          ? "rotate decoration"
          : "move decoration";
    void commit(started.doc, writeDecorations(decos), label);
  };

  const apply = (next: FrameDecorationSpec[], label: string) =>
    void commit(doc, writeDecorations(next), label);

  function onContextMenu(id: string, e: React.MouseEvent) {
    e.preventDefault();
    const idx = decorations.findIndex((d) => d.id === id);
    if (idx < 0) return;
    select(id);
    const without = decorations.filter((d) => d.id !== id);
    const d = decorations[idx];
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "duplicate",
          label: "Duplicate",
          onSelect: () => {
            const taken = new Set(decorations.map((x) => x.id));
            let copyId = `${d.id}-copy`;
            let n = 2;
            while (taken.has(copyId)) copyId = `${d.id}-copy-${n++}`;
            const copy: FrameDecorationSpec = {
              ...d,
              id: copyId,
              position: [d.position[0] + 0.05, d.position[1] - 0.05],
            };
            apply(
              [...decorations.slice(0, idx + 1), copy, ...decorations.slice(idx + 1)],
              "duplicate decoration",
            );
            select(copyId);
          },
        },
        { id: "media", label: "Change media…", onSelect: () => requestMedia(id) },
        "separator",
        {
          id: "front",
          label: "Bring to front",
          onSelect: () => apply([...without, d], "bring decoration to front"),
        },
        {
          id: "back",
          label: "Send to back",
          onSelect: () => apply([d, ...without], "send decoration to back"),
        },
        "separator",
        {
          id: "delete",
          label: "Delete",
          danger: true,
          confirmLabel: "Really delete?",
          onSelect: () => {
            apply(without, "delete decoration");
            select(null);
          },
        },
      ],
    });
  }

  return (
    <>
      <Gizmo2D
        items={items}
        selectedId={selectedId}
        onSelect={select}
        resizeAbout="opposite-corner"
        frameGuides={frameGuides}
        onGesture={onGesture}
        onGestureEnd={onGestureEnd}
        onContextMenu={onContextMenu}
        cameraArmed={cameraArmed}
      />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
