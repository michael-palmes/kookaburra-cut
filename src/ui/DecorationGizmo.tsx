import { useCallback, useEffect, useRef, useState } from "react";
import { useDecorationEditStore } from "../engine/decorationEditStore";
import { type HistoryChange, pushHistory } from "../engine/history";
import { type LoadedProject, resolveAssetUrl, workspaceSlug } from "../engine/project";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { FrameDecorationSpec } from "../toolkit/frame/types";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";

/** A direct-manipulation overlay for the active scene's panel decorations: a DOM layer over the letterboxed stage (the export can't see DOM, the CameraToolOverlay precedent) that draws a box per decoration and moves, resizes and rotates it. Pointer maths runs in stage PIXELS: world-to-screen is a uniform scale for the matched-aspect frame, so a world rotation is a true screen rotation (NDC is anisotropic and would skew it). Move/resize/rotate all write the sidecar `frame.decorations` override. See docs/overlays.md. */

/** Size clamp (fraction of frame width) while dragging a corner. */
const MIN_SIZE = 0.02;
const MAX_SIZE = 1.5;
/** Rotation snap (degrees) while Shift is held. */
const SNAP_DEG = 15;
/** Alignment snap distance (stage pixels) for the smart guides. */
const SNAP_PX = 6;

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
      /** The fixed (opposite) corner in stage pixels. */
      fixed: [number, number];
      /** Vector from the fixed corner to the dragged corner in stage pixels. */
      diag: [number, number];
      size0: number;
      origDoc: SceneDoc | null;
    }
  | {
      mode: "rotate";
      id: string;
      /** The decoration centre in stage pixels. */
      centre: [number, number];
      origDoc: SceneDoc | null;
    };

/** Rotate a screen vector clockwise (screen y is down) by `deg`. */
function rotate(vx: number, vy: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [vx * c - vy * s, vx * s + vy * c];
}

/** The nearest alignment line to any of the anchors, within the snap threshold, else null. */
function nearestLine(anchors: number[], lines: number[]): { off: number; line: number } | null {
  let best: { off: number; line: number } | null = null;
  let bestAbs = SNAP_PX;
  for (const a of anchors) {
    for (const t of lines) {
      const off = t - a;
      if (Math.abs(off) < bestAbs) {
        bestAbs = Math.abs(off);
        best = { off, line: t };
      }
    }
  }
  return best;
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
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  const pending = useRef<FrameDecorationSpec[] | null>(null);
  const [imgAspect, setImgAspect] = useState<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());

  const decorations = project.sceneFrames[sceneIndex]?.decorations ?? [];
  const slug = workspaceSlug(project.id);
  const sceneFile = project.sceneFiles[sceneIndex];
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
      void commit(
        base,
        decos.filter((x) => x.id !== id),
        "delete decoration",
      );
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, select]);

  /** Decoration centre in stage pixels. */
  const centrePx = (d: FrameDecorationSpec, rect: DOMRect): [number, number] => [
    rect.left + ((d.position[0] + 1) / 2) * rect.width,
    rect.top + ((1 - d.position[1]) / 2) * rect.height,
  ];

  /** Stage pixels back to a frame-relative position. */
  const toPos = (x: number, y: number, rect: DOMRect): [number, number] => [
    (2 * (x - rect.left)) / rect.width - 1,
    1 - (2 * (y - rect.top)) / rect.height,
  ];

  /** Half-extents (px) of a decoration's axis-aligned bounding box, accounting for its rotation. */
  const extents = (d: FrameDecorationSpec, rect: DOMRect): [number, number] => {
    const hw = (d.size * rect.width) / 2;
    const hh = (heightFrac(d) * rect.height) / 2;
    const r = ((d.rotationDeg ?? 0) * Math.PI) / 180;
    const c = Math.abs(Math.cos(r));
    const s = Math.abs(Math.sin(r));
    return [hw * c + hh * s, hw * s + hh * c];
  };

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const id = target.dataset.decoId;
    if (!id) {
      select(null);
      return;
    }
    const d = decorations.find((x) => x.id === id);
    const rect = layerRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    layerRef.current?.setPointerCapture(e.pointerId);
    select(id);
    pending.current = null;
    const centre = centrePx(d, rect);
    if (target.dataset.rotate) {
      setDrag({ mode: "rotate", id, centre, origDoc: doc });
      return;
    }
    const corner = HANDLES.find((h) => h.id === target.dataset.corner);
    if (corner) {
      const hwPx = (d.size * rect.width) / 2;
      const hhPx = (heightFrac(d) * rect.height) / 2;
      const rot = d.rotationDeg ?? 0;
      // Corner offsets in the box's screen-local frame (NDC +y is screen up), rotated into stage pixels.
      const [fx, fy] = rotate(-corner.cx * hwPx, corner.cy * hhPx, rot);
      const [gx, gy] = rotate(corner.cx * hwPx, -corner.cy * hhPx, rot);
      const fixed: [number, number] = [centre[0] + fx, centre[1] + fy];
      const dragged: [number, number] = [centre[0] + gx, centre[1] + gy];
      setDrag({
        mode: "resize",
        id,
        fixed,
        diag: [dragged[0] - fixed[0], dragged[1] - fixed[1]],
        size0: d.size,
        origDoc: doc,
      });
      return;
    }
    setDrag({
      mode: "move",
      id,
      startX: e.clientX,
      startY: e.clientY,
      origPos: [...d.position],
      origDoc: doc,
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    let patch: Partial<FrameDecorationSpec>;
    if (drag.mode === "move") {
      const rawX = drag.origPos[0] + (2 * (e.clientX - drag.startX)) / rect.width;
      const rawY = drag.origPos[1] - (2 * (e.clientY - drag.startY)) / rect.height;
      if (e.ctrlKey) {
        // Ctrl held: free movement, no snapping or guides.
        setGuides({ x: null, y: null });
        patch = { position: [rawX, rawY] };
      } else {
        let cx = rect.left + ((rawX + 1) / 2) * rect.width;
        let cy = rect.top + ((1 - rawY) / 2) * rect.height;
        const dragged = decorations.find((x) => x.id === drag.id);
        const [exD, eyD] = dragged ? extents(dragged, rect) : [0, 0];
        // Alignment targets: the frame centre and every other decoration's centre + bounding-box edges.
        const xLines = [rect.left + rect.width / 2];
        const yLines = [rect.top + rect.height / 2];
        for (const o of decorations) {
          if (o.id === drag.id) continue;
          const [ox, oy] = centrePx(o, rect);
          const [ex, ey] = extents(o, rect);
          xLines.push(ox, ox - ex, ox + ex);
          yLines.push(oy, oy - ey, oy + ey);
        }
        const sx = nearestLine([cx, cx - exD, cx + exD], xLines);
        const sy = nearestLine([cy, cy - eyD, cy + eyD], yLines);
        if (sx) cx += sx.off;
        if (sy) cy += sy.off;
        setGuides({
          x: sx ? ((sx.line - rect.left) / rect.width) * 100 : null,
          y: sy ? ((sy.line - rect.top) / rect.height) * 100 : null,
        });
        patch = { position: toPos(cx, cy, rect) };
      }
    } else if (drag.mode === "resize") {
      // Project the pointer onto the box diagonal (aspect-locked uniform scale), opposite corner fixed.
      const [fx, fy] = drag.fixed;
      const [dx, dy] = drag.diag;
      const dd = dx * dx + dy * dy;
      let k = dd > 0 ? ((e.clientX - fx) * dx + (e.clientY - fy) * dy) / dd : 1;
      let guideX: number | null = null;
      let guideY: number | null = null;
      if (!e.ctrlKey) {
        // Snap the dragged corner's moving edge to a target line; aspect-locked, so only one axis snaps.
        const cornerX = fx + k * dx;
        const cornerY = fy + k * dy;
        const xLines = [rect.left + rect.width / 2];
        const yLines = [rect.top + rect.height / 2];
        for (const o of decorations) {
          if (o.id === drag.id) continue;
          const [ox, oy] = centrePx(o, rect);
          const [ex, ey] = extents(o, rect);
          xLines.push(ox, ox - ex, ox + ex);
          yLines.push(oy, oy - ey, oy + ey);
        }
        const sx = dx !== 0 ? nearestLine([cornerX], xLines) : null;
        const sy = dy !== 0 ? nearestLine([cornerY], yLines) : null;
        if (sx && (!sy || Math.abs(sx.off) <= Math.abs(sy.off))) {
          k = (sx.line - fx) / dx;
          guideX = ((sx.line - rect.left) / rect.width) * 100;
        } else if (sy) {
          k = (sy.line - fy) / dy;
          guideY = ((sy.line - rect.top) / rect.height) * 100;
        }
      }
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, drag.size0 * k));
      k = size / drag.size0;
      setGuides({ x: guideX, y: guideY });
      patch = { position: toPos(fx + (k * dx) / 2, fy + (k * dy) / 2, rect), size };
    } else {
      // Angle from the centre to the pointer, clockwise from straight up; Shift snaps.
      const vx = e.clientX - drag.centre[0];
      const vy = e.clientY - drag.centre[1];
      let deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / SNAP_DEG) * SNAP_DEG;
      patch = { rotationDeg: deg };
    }
    const decos = decorations.map((x) => (x.id === drag.id ? { ...x, ...patch } : x));
    pending.current = decos;
    // Live preview: an in-memory patch (no disk, no history), so the decoration tracks the pointer.
    onDocChanged(sceneIndex, buildDoc(drag.origDoc, decos));
  }

  function onPointerUp() {
    if (!drag) return;
    if (pending.current) {
      const label =
        drag.mode === "resize"
          ? "resize decoration"
          : drag.mode === "rotate"
            ? "rotate decoration"
            : "move decoration";
      void commit(drag.origDoc, pending.current, label);
    }
    pending.current = null;
    setDrag(null);
    setGuides({ x: null, y: null });
  }

  const apply = (next: FrameDecorationSpec[], label: string) => void commit(doc, next, label);

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const id = (e.target as HTMLElement).dataset.decoId;
    if (!id) {
      setMenu(null);
      return;
    }
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer drag + right-click surface over the canvas; keyboard editing is the inspector's fields */}
      <div
        ref={layerRef}
        className={`decoration-gizmo-layer${drag ? ` dragging-${drag.mode}` : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
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
                height: `${heightFrac(d) * 100}%`,
                transform: `translate(-50%, -50%) rotate(${d.rotationDeg ?? 0}deg)`,
              }}
            >
              {selected && (
                <>
                  {HANDLES.map((h) => (
                    <div
                      key={h.id}
                      data-deco-id={d.id}
                      data-corner={h.id}
                      className="deco-gizmo-handle"
                      style={{ left: h.left, top: h.top, cursor: h.cursor }}
                    />
                  ))}
                  <div data-deco-id={d.id} data-rotate="1" className="deco-gizmo-rotate" />
                </>
              )}
            </div>
          );
        })}
        {guides.x !== null && (
          <div className="deco-gizmo-guide v" style={{ left: `${guides.x}%` }} />
        )}
        {guides.y !== null && (
          <div className="deco-gizmo-guide h" style={{ top: `${guides.y}%` }} />
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
