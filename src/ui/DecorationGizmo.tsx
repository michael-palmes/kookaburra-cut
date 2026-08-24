import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { useDecorationEditStore } from "../engine/decorationEditStore";
import {
  LINE_HEIGHT,
  measuredPanelTextBlock,
  type PanelTextBlock,
  type PanelTextSpec,
  panelMeasureVersion,
  requestPanelTextMeasure,
  subscribePanelMeasures,
} from "../engine/framePanelMeasure";
import { charAdvance } from "../engine/framePanelText";
import type { StageRect } from "../engine/gizmoRegistry";
import { type LoadedProject, resolveAssetUrl } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { parseFontString } from "../theme/fontRef";
import { fontUrl } from "../theme/fonts";
import type { Theme } from "../theme/tokens";
import { isTextDecoration } from "../toolkit/frame/icon";
import type { FrameDecorationSpec } from "../toolkit/frame/types";
import { prepareEmojiText } from "../toolkit/text/emojiText";
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

/** The troika measurement a text decoration's box needs: one em (fontSize 1), unwrapped, in the font the renderer types it in. Null for an image decoration. */
function textSpec(d: FrameDecorationSpec, theme: Theme | undefined): PanelTextSpec | null {
  if (!isTextDecoration(d) || !d.text || !theme) return null;
  return {
    text: prepareEmojiText(d.text).text,
    font: fontUrl(d.font ? parseFontString(d.font) : theme.typography[d.face ?? "headline"]),
    fontSize: 1,
    maxWidth: Number.POSITIVE_INFINITY,
    textAlign: "left",
    ...(d.lineHeight !== undefined ? { lineHeight: d.lineHeight } : {}),
  };
}

/** Em box until the real typeset lands: the panel's advance classes, widest line by line count. */
function estimateEm(text: string): PanelTextBlock {
  const lines = text.split("\n");
  let width = 0;
  for (const line of lines) {
    let em = 0;
    for (const c of line) em += charAdvance(c);
    width = Math.max(width, em);
  }
  return { width, height: lines.length * LINE_HEIGHT };
}

export function DecorationGizmo({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  /** Frame aspect (width / height); it turns a box's world proportions into frame fractions (see `boxFrac`). */
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const measureTick = useSyncExternalStore(
    subscribePanelMeasures,
    panelMeasureVersion,
    panelMeasureVersion,
  );
  const selectedId = useDecorationEditStore((s) =>
    s.sceneIndex === sceneIndex ? s.selectedId : null,
  );
  const select = useDecorationEditStore((s) => s.select);
  const setScene = useDecorationEditStore((s) => s.setScene);
  const requestMedia = useDecorationEditStore((s) => s.requestMedia);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [imgAspect, setImgAspect] = useState<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());
  const { preview, commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);

  const decorations = project.sceneFrames[sceneIndex]?.decorations ?? [];
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const theme = project.sceneThemes[sceneIndex];

  /** A decoration's box, as fractions of the frame width and height (also the NDC half-extents). An image sizes by its natural aspect (circle crops square); text sizes by its measured em box, both axes scaling with `size` so a corner drag stays a uniform scale. */
  const boxFrac = useCallback(
    (d: FrameDecorationSpec): [number, number] => {
      if (isTextDecoration(d)) {
        void measureTick;
        const spec = textSpec(d, theme);
        const em = (spec && measuredPanelTextBlock(spec)) || estimateEm(d.text ?? "");
        // An empty (or unmeasured, zero-width) text still needs a grabbable box.
        return [
          Math.max(MIN_SIZE, d.size * em.width),
          Math.max(MIN_SIZE, d.size * em.height) * aspect,
        ];
      }
      return [
        d.size,
        d.size * (aspect / (d.shape === "circle" ? 1 : (imgAspect[d.src ?? ""] ?? 1))),
      ];
    },
    [aspect, imgAspect, theme, measureTick],
  );

  // Each decoration image's natural aspect, for the box height (shape "none"); circle stays square.
  const srcKey = decorations.map((d) => d.src ?? "").join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: srcKey stands in for decorations; the array itself is a fresh identity each render
  useEffect(() => {
    let alive = true;
    for (const d of decorations) {
      if (!d.src || requested.current.has(d.src)) continue;
      requested.current.add(d.src);
      let url: string;
      try {
        url = resolveAssetUrl(project.id, d.src);
      } catch {
        continue;
      }
      const img = new Image();
      const src = d.src;
      img.onload = () => {
        if (alive && img.naturalHeight > 0) {
          setImgAspect((m) => ({ ...m, [src]: img.naturalWidth / img.naturalHeight }));
        }
      };
      img.src = url;
    }
    return () => {
      alive = false;
    };
  }, [srcKey, project.id]);

  // Text decoration boxes come from the panel's troika measurement cache; the estimate stands in until each lands.
  const textKey = decorations
    .map((d) => `${d.text ?? ""} ${d.face ?? ""} ${d.font ?? ""} ${d.lineHeight ?? ""}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: textKey stands in for decorations, same as srcKey above
  useEffect(() => {
    for (const d of decorations) {
      const spec = textSpec(d, theme);
      if (spec) requestPanelTextMeasure(spec);
    }
  }, [textKey, theme]);

  // The gizmo follows the playhead, so it owns the store's scene: scrubbing into another scene drops the selection rather than matching the id against that scene's decorations.
  useEffect(() => {
    setScene(sceneIndex);
  }, [setScene, sceneIndex]);

  // Drop the selection when the gizmo unmounts (drill-in closed).
  useEffect(() => () => select(null), [select]);

  const writeDecorations = useCallback(
    (decos: FrameDecorationSpec[]) => (next: SceneDoc) => {
      next.frame = { ...(next.frame ?? {}), decorations: decos };
    },
    [],
  );

  // Latest scene/decorations/doc for the keydown handler, which mounts once.
  const latest = useRef({ sceneIndex, decorations, doc });
  latest.current = { sceneIndex, decorations, doc };
  // Delete/Backspace removes the selected decoration (undoable), unless a text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const store = useDecorationEditStore.getState();
      const id = store.sceneIndex === latest.current.sceneIndex ? store.selectedId : null;
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
          const [wf, hf] = boxFrac(d);
          return {
            cx,
            cy,
            w: wf * rect.width,
            h: hf * rect.height,
            deg: d.rotationDeg ?? 0,
            pivot: [cx, cy] as Pt,
          };
        },
      })),
    [decorations, boxFrac],
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
        // A text decoration has no media to change; its text edits live in the drill.
        ...(isTextDecoration(d)
          ? []
          : [{ id: "media", label: "Change media…", onSelect: () => requestMedia(id) }]),
        "separator" as const,
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
        "separator" as const,
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
        domain="decorations"
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
