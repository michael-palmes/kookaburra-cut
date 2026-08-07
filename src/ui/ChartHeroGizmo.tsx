import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { useChartEditStore } from "../engine/chartEditStore";
import { computeFormat } from "../engine/format";
import { type StageRect, stageCamera } from "../engine/gizmoRegistry";
import {
  type Gizmo2DTarget,
  gizmoTargets,
  subscribeGizmoTargets,
} from "../engine/gizmoTargetRegistry";
import { nodeDrawn } from "../engine/gizmoVisibility";
import type { LoadedProject } from "../engine/project";
import { resolveChart } from "../engine/sceneChart";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { useEditorStore } from "../store/editorStore";
import { chartOffsetWrite, chartScaleWrite } from "./gizmo/chartGizmoWrite";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import { frameFromQuad, frameGuideLines, type Pt } from "./gizmo/gizmo2dMath";
import { projectWorldPoint, unprojectToZPlane, worldQuadOf } from "./gizmo/gizmo2dProject";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";

/** Direct manipulation for a hero-mount chart: move (`chart.style.offset`) and scale about the plot's own origin (`chart.style.scale`), the same two fields the Chart drill's Placement group writes. Staged charts keep the 3D gizmo; a panel chart's position is entirely a function of the panel layout, so there is nothing to write. There is no rotate handle: `style.rotation` is the two-axis presentation tilt fed into `fitChart3d`, not a 2D roll. */

const ITEM_ID = "chart";

interface Started {
  kind: Gizmo2DGesture["kind"];
  doc: SceneDoc | null;
  offset: [number, number];
  scale: number;
  pivot: Pt;
  worldZ: number;
}

export function ChartHeroGizmo({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const targets = useSyncExternalStore(subscribeGizmoTargets, gizmoTargets);
  const selected = useChartEditStore((s) => s.selected);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const formatSpec = useEditorStore((s) => s.format);
  const format = useMemo(() => computeFormat(formatSpec), [formatSpec]);
  const { preview, commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const chart = useMemo(() => resolveChart(doc ?? undefined), [doc]);

  const target = useMemo<Gizmo2DTarget | null>(
    () =>
      chart?.mount === "hero"
        ? (targets.find(
            (t) => t.domain === "chart" && t.sceneIndex === sceneIndex && t.side === undefined,
          ) ?? null)
        : null,
    [targets, sceneIndex, chart],
  );

  const geometryOf = useCallback((entry: Gizmo2DTarget, rect: StageRect) => {
    const node = entry.node();
    const local = entry.localRect();
    if (!node || !local || !nodeDrawn(node)) return null;
    const camera = stageCamera();
    if (!camera) return null;
    let worldZ = 0;
    const { quad, pivot } = worldQuadOf(node, local, (w) => {
      worldZ = w.z;
      return projectWorldPoint(camera, rect, w);
    });
    return { frame: frameFromQuad(quad, pivot), worldZ };
  }, []);

  const items = useMemo<Gizmo2DItem[]>(
    () =>
      target
        ? [
            {
              id: ITEM_ID,
              label: "Chart",
              can: { move: true, resize: true, rotate: false },
              frame: (rect: StageRect) => geometryOf(target, rect)?.frame ?? null,
            },
          ]
        : [],
    [target, geometryOf],
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
  const pending = useRef<((next: SceneDoc) => void) | null>(null);

  const begin = (g: Gizmo2DGesture): Started | null => {
    const current = run.current;
    if (current && current.kind === g.kind) return current;
    const geometry = target ? geometryOf(target, g.rect) : null;
    if (!geometry || !chart) return null;
    const started: Started = {
      kind: g.kind,
      doc,
      offset: [chart.style.offset[0], chart.style.offset[1]],
      scale: chart.style.scale,
      pivot: geometry.frame.pivot,
      worldZ: geometry.worldZ,
    };
    run.current = started;
    return started;
  };

  const patchFor = (g: Gizmo2DGesture, started: Started): ((next: SceneDoc) => void) | null => {
    if (g.kind === "move") {
      const camera = stageCamera();
      if (!camera) return null;
      const from = unprojectToZPlane(camera, g.rect, started.pivot, started.worldZ);
      const to = unprojectToZPlane(
        camera,
        g.rect,
        [started.pivot[0] + g.dxPx, started.pivot[1] + g.dyPx],
        started.worldZ,
      );
      if (!from || !to) return null;
      const offset: [number, number] = [
        chartOffsetWrite(started.offset[0], to[0] - from[0]),
        chartOffsetWrite(started.offset[1], to[1] - from[1]),
      ];
      return (next: SceneDoc) => {
        if (next.chart) next.chart.style = { ...next.chart.style, offset };
      };
    }
    if (g.kind === "resize") {
      const scale = chartScaleWrite(started.scale, g.factor);
      return (next: SceneDoc) => {
        if (next.chart) next.chart.style = { ...next.chart.style, scale };
      };
    }
    return null;
  };

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
    void commit(started.doc, patch, "chart placement");
  };

  return (
    <Gizmo2D
      items={items}
      selectedId={selected?.sceneIndex === sceneIndex ? ITEM_ID : null}
      onSelect={(id) => useChartEditStore.getState().select(id === ITEM_ID ? { sceneIndex } : null)}
      resizeAbout="pivot"
      frameGuides={frameGuides}
      onGesture={onGesture}
      onGestureEnd={onGestureEnd}
      cameraArmed={cameraArmed}
    />
  );
}
