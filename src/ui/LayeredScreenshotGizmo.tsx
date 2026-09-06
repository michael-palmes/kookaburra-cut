import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Matrix4, Vector3 } from "three";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { computeFormat } from "../engine/format";
import { resolveCutoutRender } from "../engine/frameFormat";
import { type StageRect, stageCamera } from "../engine/gizmoRegistry";
import { gizmoTargets, subscribeGizmoTargets } from "../engine/gizmoTargetRegistry";
import { nodeDrawn } from "../engine/gizmoVisibility";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc, SceneDocLayeredScreenshot } from "../engine/sceneDocSchema";
import { resolveLayeredScreenshotPlacement } from "../engine/sceneLayeredScreenshot";
import { cutoutStageRect, frameWorldCutout, worldViewportRect } from "../engine/stageViewport";
import { useEditorStore } from "../store/editorStore";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import { frameGuideLines, type Pt } from "./gizmo/gizmo2dMath";
import { unprojectToZPlane } from "./gizmo/gizmo2dProject";
import {
  screenshotStackFrame,
  screenshotStackPlacementWrite,
} from "./gizmo/layeredScreenshotGizmoMath";
import { useLayeredScreenshotDoc } from "./layeredScreenshotDoc";

const ITEM_ID = "layeredScreenshot";

export function LayeredScreenshotGizmo({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const targets = useSyncExternalStore(subscribeGizmoTargets, gizmoTargets);
  const selected = useLayeredScreenshotEditStore((s) => s.selectedStack?.sceneIndex === sceneIndex);
  const writeError = useLayeredScreenshotEditStore((s) => s.writeError);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const stackArmed = useLayeredScreenshotEditStore((s) => s.armedTool !== null);
  const formatSpec = useEditorStore((s) => s.format);
  const frameSpec = project.sceneFrames[sceneIndex];
  const cutout = useMemo(
    () => frameWorldCutout(frameSpec, formatSpec.width / formatSpec.height),
    [frameSpec, formatSpec],
  );
  const format = useMemo(
    () =>
      cutout && frameSpec
        ? resolveCutoutRender(formatSpec, frameSpec).format
        : computeFormat(formatSpec),
    [cutout, frameSpec, formatSpec],
  );
  const { block, preview, commit } = useLayeredScreenshotDoc(project, sceneIndex, onDocChanged);
  const target = targets.find(
    (t) => t.domain === ITEM_ID && t.sceneIndex === sceneIndex && t.side === undefined,
  );
  const geometryOf = useCallback(
    (rect: StageRect) => {
      const node = target?.node();
      const camera = stageCamera();
      if (!node || !nodeDrawn(node) || !camera) return null;
      return screenshotStackFrame(
        node,
        target?.localPoints?.() ?? [],
        camera,
        worldViewportRect(rect, cutout),
      );
    },
    [target, cutout],
  );
  const items = useMemo<Gizmo2DItem[]>(
    () =>
      project.sceneDocs[sceneIndex]?.layeredScreenshot && target
        ? [
            {
              id: ITEM_ID,
              label: "Screenshot stack",
              can: { move: true, resize: true, rotate: true },
              frame: geometryOf,
            },
          ]
        : [],
    [project.sceneDocs, sceneIndex, target, geometryOf],
  );
  const guides = useCallback(
    (rect: StageRect) => {
      const drawn = cutoutStageRect(rect, cutout);
      const scale = drawn.width / format.frame.width;
      return frameGuideLines(drawn, {
        left: format.safe.left * scale,
        right: format.safe.right * scale,
        top: format.safe.top * scale,
        bottom: format.safe.bottom * scale,
      });
    },
    [cutout, format],
  );
  const run = useRef<{
    block: SceneDocLayeredScreenshot;
    pivot: Pt;
    worldZ: number;
    inverseParent: Matrix4;
  } | null>(null);
  const pending = useRef<SceneDocLayeredScreenshot | null>(null);
  useEffect(
    () => () => {
      if (!run.current) return;
      const state = useLayeredScreenshotEditStore.getState();
      if (
        state.draft?.projectId === project.id &&
        state.draft.sceneIndex === sceneIndex &&
        !state.draft.committed
      )
        state.setDraft(null);
    },
    [project.id, sceneIndex],
  );

  const onGesture = (gesture: Gizmo2DGesture) => {
    let started = run.current;
    if (!started) {
      const geometry = geometryOf(gesture.rect);
      const node = target?.node();
      if (!geometry || !node) return;
      useEditorStore.getState().setPlaying(false);
      started = {
        block: structuredClone(block),
        pivot: geometry.pivot,
        worldZ: node.getWorldPosition(new Vector3()).z,
        inverseParent: node.parent ? node.parent.matrixWorld.clone().invert() : new Matrix4(),
      };
      run.current = started;
    }
    const base = resolveLayeredScreenshotPlacement(started.block.placement);
    let placement = base;
    if (gesture.kind === "move") {
      const camera = stageCamera();
      if (!camera) return;
      const viewport = worldViewportRect(gesture.rect, cutout);
      const from = unprojectToZPlane(camera, viewport, started.pivot, started.worldZ);
      const to = unprojectToZPlane(
        camera,
        viewport,
        [started.pivot[0] + gesture.dxPx, started.pivot[1] + gesture.dyPx],
        started.worldZ,
      );
      if (!from || !to) return;
      const delta = new Vector3(...to)
        .applyMatrix4(started.inverseParent)
        .sub(new Vector3(...from).applyMatrix4(started.inverseParent));
      placement = {
        ...base,
        position: [
          base.position[0] + (2 * delta.x) / format.frame.width,
          base.position[1] + (2 * delta.y) / format.frame.height,
        ],
      };
    } else if (gesture.kind === "resize") {
      placement = { ...base, size: base.size * gesture.factor };
    } else {
      placement = { ...base, rotationDeg: base.rotationDeg + gesture.deg - gesture.deg0 };
    }
    const next = { ...started.block, placement: screenshotStackPlacementWrite(placement) };
    pending.current = next;
    preview(next, false);
  };
  const onGestureEnd = (gesture: Gizmo2DGesture | null) => {
    const next = pending.current;
    run.current = null;
    pending.current = null;
    if (gesture && next) void commit(next);
  };
  return (
    <>
      <Gizmo2D
        items={items}
        domain={ITEM_ID}
        selectedId={selected ? ITEM_ID : null}
        onSelect={(id) =>
          useLayeredScreenshotEditStore
            .getState()
            .selectStack(id === ITEM_ID ? { sceneIndex } : null)
        }
        resizeAbout="pivot"
        frameGuides={guides}
        onGesture={onGesture}
        onGestureEnd={onGestureEnd}
        cameraArmed={cameraArmed || stackArmed}
      />
      {writeError && (
        <div className="toast toast-error" role="alert">
          <span className="toast-msg">Screenshot stack could not be saved: {writeError}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss save error"
            onClick={() => useLayeredScreenshotEditStore.getState().setWriteError(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
