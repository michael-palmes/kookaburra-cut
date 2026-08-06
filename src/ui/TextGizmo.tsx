import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Object3D } from "three";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { computeFormat } from "../engine/format";
import { getFramePanels } from "../engine/framePanelRegistry";
import { type StageRect, stageCamera } from "../engine/gizmoRegistry";
import {
  type Gizmo2DTarget,
  gizmoTargets,
  subscribeGizmoTargets,
} from "../engine/gizmoTargetRegistry";
import { nodeDrawn } from "../engine/gizmoVisibility";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { useTextEditStore } from "../engine/textEditStore";
import { useEditorStore } from "../store/editorStore";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import { frameFromQuad, frameGuideLines, type Pt } from "./gizmo/gizmo2dMath";
import {
  panelToStagePx,
  projectWorldPoint,
  unprojectToZPlane,
  worldQuadOf,
} from "./gizmo/gizmo2dProject";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";
import { textOffsetWrite, textRotationWrite, textSizeWrite } from "./gizmo/textGizmoWrite";

/** Direct manipulation for the active scene's text: a box per mounted text key while the Text section is open, then move (`textStyle.<key>OffsetX/Y`), size about the anchor (`<key>Size`) and tilt (`<key>RotationDeg`) on the selected one. Two spaces: an overlay panel's headlines are drawn from the base pose against the full frame, a linear map; everything else projects through the LIVE camera, so a box tracks a rig pose, a keyframe and a transition. Cutout-hosted text is deliberately excluded: it renders into a cutout-sized target at a different `camera.aspect` and is then keyed into the cutout's pixel rect, so `stageCamera()` is not the projection that put it on screen; the Text drill still edits it numerically. */

interface Started {
  id: string;
  kind: Gizmo2DGesture["kind"];
  doc: SceneDoc | null;
  offX: number;
  offY: number;
  size: number;
  rot: number;
  pivot: Pt;
  worldZ: number;
  panel: boolean;
}

export function TextGizmo({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const targets = useSyncExternalStore(subscribeGizmoTargets, gizmoTargets);
  const selected = useTextEditStore((s) => s.selected);
  const select = useTextEditStore((s) => s.select);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const formatSpec = useEditorStore((s) => s.format);
  const format = useMemo(() => computeFormat(formatSpec), [formatSpec]);
  const { preview, commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);
  const doc = project.sceneDocs[sceneIndex] ?? null;
  // A cutout scene draws its own text through a different projection; only its panel text is editable here.
  const cutout = (project.sceneFrames[sceneIndex]?.cutout.shape ?? "none") !== "none";

  useEffect(() => () => select(null), [select]);

  // One box per text key: a scene that mounts the same key twice gets the first, since both write the same fields.
  const mine = useMemo(() => {
    const byKey = new Map<string, Gizmo2DTarget>();
    for (const t of targets) {
      if (t.domain !== "text" || t.sceneIndex !== sceneIndex || t.side !== undefined) continue;
      if (!byKey.has(t.itemId)) byKey.set(t.itemId, t);
    }
    return [...byKey.values()];
  }, [targets, sceneIndex]);

  /** The panel group this node sits inside, if any: panel text is laid out against the full frame and drawn from the base pose. */
  const panelOf = useCallback((node: Object3D): Object3D | null => {
    const panels = getFramePanels();
    if (panels.length === 0) return null;
    for (let o: Object3D | null = node; o; o = o.parent) {
      if (panels.some((p) => p.group === o)) return o;
    }
    return null;
  }, []);

  const geometryOf = useCallback(
    (target: Gizmo2DTarget, rect: StageRect) => {
      const node = target.node();
      const local = target.localRect();
      if (!node || !local) return null;
      const panel = panelOf(node);
      // The compositor leaves a panel group hidden between its passes, so its own subtree is judged below it.
      if (!nodeDrawn(node, panel)) return null;
      if (panel) {
        const { quad, pivot } = worldQuadOf(node, local, (w) =>
          panelToStagePx([w.x, w.y], format.frame, rect),
        );
        return { frame: frameFromQuad(quad, pivot), panel: true, worldZ: 0 };
      }
      if (cutout) return null;
      const camera = stageCamera();
      if (!camera) return null;
      let worldZ = 0;
      const { quad, pivot } = worldQuadOf(node, local, (w) => {
        worldZ = w.z;
        return projectWorldPoint(camera, rect, w);
      });
      return { frame: frameFromQuad(quad, pivot), panel: false, worldZ };
    },
    [panelOf, format.frame, cutout],
  );

  const items = useMemo<Gizmo2DItem[]>(
    () =>
      mine.map((target) => ({
        id: target.itemId,
        label: target.itemId,
        can: { move: true, resize: true, rotate: true },
        frame: (rect: StageRect) => geometryOf(target, rect)?.frame ?? null,
      })),
    [mine, geometryOf],
  );

  const frameGuides = useCallback(
    (rect: StageRect) => {
      const scale = rect.width / format.frame.width;
      return frameGuideLines(rect, {
        left: format.safe.left * scale,
        right: format.safe.right * scale,
        top: format.safe.top * scale,
        bottom: format.safe.bottom * scale,
      });
    },
    [format],
  );

  const run = useRef<Started | null>(null);

  const styleNum = (key: string): number | undefined => {
    const v = doc?.textStyle?.[key];
    return typeof v === "number" ? v : undefined;
  };

  const begin = (g: Gizmo2DGesture): Started | null => {
    const current = run.current;
    if (current && current.id === g.id && current.kind === g.kind) return current;
    const target = mine.find((t) => t.itemId === g.id);
    const geometry = target ? geometryOf(target, g.rect) : null;
    if (!geometry) return null;
    const started: Started = {
      id: g.id,
      kind: g.kind,
      doc,
      offX: styleNum(`${g.id}OffsetX`) ?? 0,
      offY: styleNum(`${g.id}OffsetY`) ?? 0,
      size: styleNum(`${g.id}Size`) ?? 1,
      rot: styleNum(`${g.id}RotationDeg`) ?? 0,
      pivot: geometry.frame.pivot,
      worldZ: geometry.worldZ,
      panel: geometry.panel,
    };
    run.current = started;
    return started;
  };

  /** The px drag delta as a world delta at the item's own plane: a ray-plane intersection, exact under any rig pose. */
  const worldDelta = (started: Started, rect: StageRect, dxPx: number, dyPx: number): Pt | null => {
    if (started.panel) {
      return [
        (dxPx * format.frame.width) / rect.width,
        (-dyPx * format.frame.height) / rect.height,
      ];
    }
    const camera = stageCamera();
    if (!camera) return null;
    const from = unprojectToZPlane(camera, rect, started.pivot, started.worldZ);
    const to = unprojectToZPlane(
      camera,
      rect,
      [started.pivot[0] + dxPx, started.pivot[1] + dyPx],
      started.worldZ,
    );
    return from && to ? [to[0] - from[0], to[1] - from[1]] : null;
  };

  const patchFor = (g: Gizmo2DGesture, started: Started): ((next: SceneDoc) => void) | null => {
    const style: Record<string, number | undefined> = {};
    if (g.kind === "move") {
      const delta = worldDelta(started, g.rect, g.dxPx, g.dyPx);
      if (!delta) return null;
      style[`${g.id}OffsetX`] = textOffsetWrite(started.offX + delta[0]);
      style[`${g.id}OffsetY`] = textOffsetWrite(started.offY + delta[1]);
    } else if (g.kind === "resize") {
      style[`${g.id}Size`] = textSizeWrite(started.size * g.factor);
    } else {
      // The turn, not the screen angle: a scene may already tilt the block itself, and the field is only the sidecar's own share of it.
      style[`${g.id}RotationDeg`] = textRotationWrite(started.rot + (g.deg - g.deg0));
    }
    return (next: SceneDoc) => {
      const textStyle = { ...(next.textStyle ?? {}) };
      for (const [key, value] of Object.entries(style)) {
        if (value === undefined) delete textStyle[key];
        else textStyle[key] = value;
      }
      if (Object.keys(textStyle).length > 0) next.textStyle = textStyle;
      else delete next.textStyle;
    };
  };

  const pending = useRef<((next: SceneDoc) => void) | null>(null);

  const onGesture = (g: Gizmo2DGesture) => {
    const started = begin(g);
    if (!started) return;
    const patch = patchFor(g, started);
    if (!patch) return;
    pending.current = patch;
    preview(started.doc, patch);
  };

  const onGestureEnd = (g: Gizmo2DGesture | null) => {
    const started = run.current;
    const patch = pending.current;
    run.current = null;
    pending.current = null;
    if (!g || !started || !patch) return;
    const label =
      g.kind === "resize" ? "text size" : g.kind === "rotate" ? "text rotation" : "text position";
    void commit(started.doc, patch, label);
  };

  return (
    <Gizmo2D
      items={items}
      selectedId={selected?.sceneIndex === sceneIndex ? selected.key : null}
      onSelect={(key) => select(key ? { sceneIndex, key } : null)}
      resizeAbout="pivot"
      frameGuides={frameGuides}
      onGesture={onGesture}
      onGestureEnd={onGestureEnd}
      cameraArmed={cameraArmed}
    />
  );
}
