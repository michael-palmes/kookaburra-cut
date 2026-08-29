import { useCallback, useMemo, useRef } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import type { StageRect } from "../engine/gizmoRegistry";
import { type LoadedProject, sceneFileStem } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import {
  resolveSceneWebsite,
  type SceneDocWebsite,
  sceneWebsiteLayout,
} from "../engine/sceneWebsite";
import { sceneWebsiteKey, useSceneWebsiteSessionStore } from "../engine/sceneWebsiteSession";
import { useWebsiteEditStore } from "../engine/websiteEditStore";
import { Gizmo2D, type Gizmo2DGesture, type Gizmo2DItem } from "./gizmo/Gizmo2D";
import type { Pt } from "./gizmo/gizmo2dMath";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";

const ITEM_ID = "website";
const MIN_SIZE = 0.05;
const MAX_SIZE = 1.5;

function toPosition(x: number, y: number, rect: StageRect): [number, number] {
  const clamp = (value: number) => Math.min(1.5, Math.max(-1.5, value));
  return [
    clamp((2 * (x - rect.left)) / rect.width - 1),
    clamp(1 - (2 * (y - rect.top)) / rect.height),
  ];
}

export function WebsiteGizmo({
  project,
  sceneIndex,
  aspect,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  aspect: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const selected = useWebsiteEditStore((state) => state.selected);
  const cameraArmed = useCameraEditStore((state) => state.armedTool !== null);
  const { preview, commit } = useGizmoDocWrite(project, sceneIndex, onDocChanged);
  const doc = project.sceneDocs[sceneIndex] ?? null;
  const website = useMemo(() => resolveSceneWebsite(doc ?? undefined), [doc]);
  const stem = sceneFileStem(project.sceneFiles[sceneIndex] ?? "");
  const sessionKey = sceneWebsiteKey(project.id, stem);
  const live = useSceneWebsiteSessionStore((state) => state.sessions[sessionKey]?.active ?? false);

  const items = useMemo<Gizmo2DItem[]>(() => {
    if (!website || live) return [];
    return [
      {
        id: ITEM_ID,
        label: "Website",
        can: { move: true, resize: true, rotate: false },
        frame: (rect: StageRect) => {
          const { window } = sceneWebsiteLayout(website, { width: aspect, height: 1 });
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
  }, [website, live, aspect]);

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
  const pending = useRef<Partial<SceneDocWebsite> | null>(null);

  const writeWebsite = useCallback(
    (patch: Partial<SceneDocWebsite>) => (next: SceneDoc) => {
      next.website = { ...(next.website ?? {}), ...patch };
    },
    [],
  );

  const onGesture = (gesture: Gizmo2DGesture) => {
    let started = run.current;
    if (!started || started.kind !== gesture.kind) {
      if (!website) return;
      started = {
        kind: gesture.kind,
        doc,
        position: website.position,
        size: website.size,
      };
      run.current = started;
      pending.current = null;
    }
    let patch: Partial<SceneDocWebsite>;
    if (gesture.kind === "move") {
      const cx = gesture.rect.left + ((started.position[0] + 1) / 2) * gesture.rect.width;
      const cy = gesture.rect.top + ((1 - started.position[1]) / 2) * gesture.rect.height;
      patch = {
        position: toPosition(cx + gesture.dxPx, cy + gesture.dyPx, gesture.rect),
      };
    } else if (gesture.kind === "resize") {
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, started.size * gesture.factor));
      const ratio = size / started.size;
      patch = {
        position: toPosition(
          gesture.fixedPx[0] + (ratio * gesture.diagPx[0]) / 2,
          gesture.fixedPx[1] + (ratio * gesture.diagPx[1]) / 2,
          gesture.rect,
        ),
        size,
      };
    } else {
      return;
    }
    pending.current = patch;
    preview(started.doc, writeWebsite(patch));
  };

  const onGestureEnd = (gesture: Gizmo2DGesture | null) => {
    const started = run.current;
    const patch = pending.current;
    run.current = null;
    pending.current = null;
    if (!gesture || !started || !patch) return;
    void commit(
      started.doc,
      writeWebsite(patch),
      gesture.kind === "resize" ? "resize Website" : "move Website",
    );
  };

  return (
    <Gizmo2D
      items={items}
      domain="website"
      selectedId={selected?.sceneIndex === sceneIndex ? ITEM_ID : null}
      onSelect={(id) =>
        useWebsiteEditStore.getState().select(id === ITEM_ID ? { sceneIndex } : null)
      }
      resizeAbout="opposite-corner"
      frameGuides={frameGuides}
      onGesture={onGesture}
      onGestureEnd={onGestureEnd}
      cameraArmed={cameraArmed}
    />
  );
}
