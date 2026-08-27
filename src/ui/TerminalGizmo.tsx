import { useCallback, useMemo, useRef } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import type { StageRect } from "../engine/gizmoRegistry";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import {
  resolveSceneTerminal,
  type SceneDocTerminal,
  sceneTerminalLayout,
} from "../engine/sceneTerminal";
import { useTerminalEditStore } from "../engine/terminalEditStore";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import type { Pt } from "./gizmo/gizmo2dMath";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";

/** Direct manipulation for the active scene's terminal window: move (`terminal.position`) and corner resize (`terminal.size`), hosted on the shared `Gizmo2D` layer. The window is drawn by the frame-panel pass from the BASE pose, so world-to-stage pixels is the decorations' fixed linear map and no camera is involved. No rotate: a terminal is a window, not a sticker. */

const ITEM_ID = "terminal";
const MIN_SIZE = 0.05;
const MAX_SIZE = 1.5;

/** Position stage pixels back to the frame-relative centre (the decoration maths). */
function toPos(x: number, y: number, rect: StageRect): [number, number] {
  const clamp = (v: number) => Math.min(1.5, Math.max(-1.5, v));
  return [
    clamp((2 * (x - rect.left)) / rect.width - 1),
    clamp(1 - (2 * (y - rect.top)) / rect.height),
  ];
}

export function TerminalGizmo({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  /** Frame aspect (width / height), for the layout's frame-fraction maths. */
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const selected = useTerminalEditStore((s) => s.selected);
  const cameraArmed = useCameraEditStore((s) => s.armedTool !== null);
  const { preview, commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const terminal = useMemo(() => resolveSceneTerminal(doc ?? undefined), [doc]);

  const items = useMemo<Gizmo2DItem[]>(() => {
    if (!terminal) return [];
    return [
      {
        id: ITEM_ID,
        label: "Terminal",
        can: { move: true, resize: true, rotate: false },
        frame: (rect: StageRect) => {
          const { window } = sceneTerminalLayout(terminal, { width: aspect, height: 1 });
          const cx = rect.left + (0.5 + window.x / aspect) * rect.width;
          const cy = rect.top + (0.5 - window.y) * rect.height;
          return {
            cx,
            cy,
            w: (window.width / aspect) * rect.width,
            h: window.height * rect.height,
            deg: 0,
            pivot: [cx, cy] as Pt,
          };
        },
      },
    ];
  }, [terminal, aspect]);

  const frameGuides = useCallback(
    (rect: StageRect) => ({
      x: [rect.left + rect.width / 2],
      y: [rect.top + rect.height / 2],
    }),
    [],
  );

  const run = useRef<{
    kind: Gizmo2DGesture["kind"];
    doc: SceneDoc | null;
    position: [number, number];
    size: number;
  } | null>(null);
  const pending = useRef<Partial<SceneDocTerminal> | null>(null);

  const writeTerminal = useCallback(
    (patch: Partial<SceneDocTerminal>) => (next: SceneDoc) => {
      next.terminal = { ...(next.terminal ?? {}), ...patch };
    },
    [],
  );

  const onGesture = (g: Gizmo2DGesture) => {
    let started = run.current;
    if (!started || started.kind !== g.kind) {
      if (!terminal) return;
      started = { kind: g.kind, doc, position: terminal.position, size: terminal.size };
      run.current = started;
      pending.current = null;
    }
    let patch: Partial<SceneDocTerminal>;
    if (g.kind === "move") {
      const cx = g.rect.left + ((started.position[0] + 1) / 2) * g.rect.width;
      const cy = g.rect.top + ((1 - started.position[1]) / 2) * g.rect.height;
      patch = { position: toPos(cx + g.dxPx, cy + g.dyPx, g.rect) };
    } else if (g.kind === "resize") {
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, started.size * g.factor));
      const k = size / started.size;
      patch = {
        position: toPos(
          g.fixedPx[0] + (k * g.diagPx[0]) / 2,
          g.fixedPx[1] + (k * g.diagPx[1]) / 2,
          g.rect,
        ),
        size,
      };
    } else {
      return;
    }
    pending.current = patch;
    preview(started.doc, writeTerminal(patch));
  };

  const onGestureEnd = (g: Gizmo2DGesture | null) => {
    const started = run.current;
    const patch = pending.current;
    run.current = null;
    pending.current = null;
    if (!g || !started || !patch) return;
    void commit(
      started.doc,
      writeTerminal(patch),
      g.kind === "resize" ? "resize terminal" : "move terminal",
    );
  };

  return (
    <Gizmo2D
      items={items}
      domain="terminal"
      selectedId={selected?.sceneIndex === sceneIndex ? ITEM_ID : null}
      onSelect={(id) =>
        useTerminalEditStore.getState().select(id === ITEM_ID ? { sceneIndex } : null)
      }
      resizeAbout="opposite-corner"
      frameGuides={frameGuides}
      onGesture={onGesture}
      onGestureEnd={onGestureEnd}
      cameraArmed={cameraArmed}
    />
  );
}
