import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BeatAnalysis } from "../engine/beatAnalysis";
import {
  effectiveKeyMoments,
  projectBeatGrid,
  retryBeatAnalysis,
  useBeatStore,
} from "../engine/beatState";
import {
  AUDIO_MARKERS_VERSION,
  type AudioMarkersSpec,
  type LoadedProject,
} from "../engine/project";
import { activeSceneIndex } from "../engine/sceneTimeline";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { msFromTrackX, playheadFraction, type SceneCellSpan, sceneCellSpans } from "./scrubMath";

/** Marker drags snap to the beat grid within this many screen px (the TrackLane radius). */
const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 3;

/** Beat lane: soundtrack waveform, beat grid and key-moment diamonds directly above the scene strip. It lives in the playback bar's centre column and maps every time through the same span maths as the playhead, so markers sit exactly on the scene cuts below. Click a diamond to jump there; drag to nudge (first edit copies the detected set into `audio.markers`); double-click adds; right-click deletes or resets. Editor chrome only; the export path reads none of it. */
export function BeatLane({
  project,
  durationMs,
  isWorkspace,
  onSeek,
  onUpdateMarkers,
  onAddCameraKey,
  onSyncCamera,
}: {
  project: LoadedProject;
  durationMs: number;
  /** Bundled projects show the lane read-only (their manifests are not writable). */
  isWorkspace: boolean;
  /** Seek the playhead (the host's scrub guard applies). */
  onSeek: (ms: number) => void;
  /** Write (or null to clear) the manifest's `audio.markers` overlay. */
  onUpdateMarkers: (markers: AudioMarkersSpec | null) => void;
  /** Add one camera keyframe landing on the beat at project-time ms. */
  onAddCameraKey: (ms: number) => void;
  /** Generate the owning scene's camera track from its key beats. */
  onSyncCamera: (ms: number) => void;
}) {
  const status = useBeatStore((s) => s.status);
  const analysis = useBeatStore((s) => s.analysis);
  const laneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ fromMs: number; toMs: number; startX: number; moved: boolean } | null>(
    null,
  );
  const [dragView, setDragView] = useState<{ fromMs: number; toMs: number } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const startOffsetMs = project.audio?.startOffsetMs ?? 0;
  const spans = useMemo(() => sceneCellSpans(project.slots, durationMs), [project, durationMs]);
  const moments = useMemo(
    () => effectiveKeyMoments(analysis, project.audio?.markers, startOffsetMs, durationMs),
    [analysis, project, startOffsetMs, durationMs],
  );
  const grid = useMemo(
    () => projectBeatGrid(analysis, startOffsetMs, durationMs),
    [analysis, startOffsetMs, durationMs],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawWave(canvas, analysis, spans, durationMs, startOffsetMs);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [analysis, spans, durationMs, startOffsetMs]);

  // Idle means no analysis was ever kicked for this window (no audio project, or an autorun); no lane.
  if (status === "idle") return null;

  const laneMsAt = (clientX: number): number | null => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return msFromTrackX(clientX - rect.left, rect.width, durationMs, spans);
  };

  /** Snap in px space (the mapping is non-linear): the nearest grid beat within SNAP_PX wins. */
  const snapToGrid = (rawMs: number): number => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return rawMs;
    const rawPx = playheadFraction(rawMs, durationMs, spans) * rect.width;
    let best = rawMs;
    let bestD = SNAP_PX;
    for (const b of grid) {
      const d = Math.abs(playheadFraction(b, durationMs, spans) * rect.width - rawPx);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  const commitTimes = (times: number[]) => {
    onUpdateMarkers({
      version: AUDIO_MARKERS_VERSION,
      keyMoments: times.map((t) => Math.round(t)).sort((a, b) => a - b),
    });
  };
  const addMarker = (tMs: number) => commitTimes([...moments.map((m) => m.tMs), tMs]);
  const deleteMarker = (tMs: number) =>
    commitTimes(moments.filter((m) => m.tMs !== tMs).map((m) => m.tMs));
  const moveMarker = (fromMs: number, toMs: number) =>
    commitTimes(moments.map((m) => (m.tMs === fromMs ? toMs : m.tMs)));

  const resetItem = {
    id: "reset",
    label: "Reset markers to detected",
    disabled: !project.audio?.markers,
    title: project.audio?.markers ? undefined : "Markers already follow detection",
    onSelect: () => onUpdateMarkers(null),
  };

  /** Camera actions target the scene owning the clicked time; free-flight scenes keep their authored flights. */
  const cameraItemsFor = (tMs: number): ContextMenuItem[] => {
    const sceneIndex =
      tMs >= durationMs ? project.slots.length - 1 : activeSceneIndex(project.slots, tMs);
    const rig = project.sceneDocs[sceneIndex]?.cameraMode === "rig";
    const title = rig ? "Free-flight scenes keep their authored flights" : undefined;
    return [
      {
        id: "camera-key",
        label: "Add camera keyframe here",
        disabled: rig,
        title,
        onSelect: () => onAddCameraKey(tMs),
      },
      {
        id: "camera-sync",
        label: "Sync scene camera to beats",
        disabled: rig,
        title,
        onSelect: () => onSyncCamera(tMs),
      },
    ];
  };

  const openMenu = (e: ReactMouseEvent) => {
    if (!isWorkspace) return;
    e.preventDefault();
    e.stopPropagation();
    const diamond = (e.target as HTMLElement).closest<HTMLElement>(".beat-diamond");
    const tMs = diamond ? Number(diamond.dataset.tms) : laneMsAt(e.clientX);
    if (tMs === null || Number.isNaN(tMs)) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: diamond
        ? [
            ...cameraItemsFor(tMs),
            "separator",
            {
              id: "delete",
              label: "Delete marker",
              danger: true,
              onSelect: () => deleteMarker(tMs),
            },
            "separator",
            resetItem,
          ]
        : [
            { id: "add", label: "Add marker here", onSelect: () => addMarker(snapToGrid(tMs)) },
            "separator",
            ...cameraItemsFor(tMs),
            "separator",
            resetItem,
          ],
    });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer affordances over the bar's scrub surface; diamonds are real buttons
    <div
      ref={laneRef}
      className="beat-lane"
      data-status={status}
      onDoubleClick={(e) => {
        if (!isWorkspace) return;
        if ((e.target as HTMLElement).closest(".beat-diamond, .beat-status")) return;
        const tMs = laneMsAt(e.clientX);
        if (tMs !== null) addMarker(snapToGrid(tMs));
      }}
      onContextMenu={openMenu}
    >
      <canvas ref={canvasRef} className="beat-wave" />
      {moments.map((m) => {
        const shownMs = dragView?.fromMs === m.tMs ? dragView.toMs : m.tMs;
        return (
          <button
            key={m.tMs}
            type="button"
            className="beat-diamond"
            data-tms={m.tMs}
            style={
              {
                left: `${playheadFraction(shownMs, durationMs, spans) * 100}%`,
                "--strength": m.strength,
              } as CSSProperties
            }
            title={`Key beat at ${(shownMs / 1000).toFixed(2)}s`}
            aria-label={`Key beat at ${(shownMs / 1000).toFixed(2)} seconds`}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = { fromMs: m.tMs, toMs: m.tMs, startX: e.clientX, moved: false };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d || d.fromMs !== m.tMs) return;
              if (!d.moved) {
                if (!isWorkspace || Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
                d.moved = true;
              }
              const raw = laneMsAt(e.clientX);
              if (raw === null) return;
              d.toMs = snapToGrid(raw);
              setDragView({ fromMs: d.fromMs, toMs: d.toMs });
            }}
            onPointerUp={() => {
              const d = dragRef.current;
              dragRef.current = null;
              setDragView(null);
              if (!d) return;
              if (d.moved) {
                if (d.toMs !== d.fromMs) moveMarker(d.fromMs, d.toMs);
              } else {
                onSeek(m.tMs);
              }
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setDragView(null);
            }}
          />
        );
      })}
      {status === "analysing" && <span className="beat-status">Analysing soundtrack…</span>}
      {status === "error" && (
        <button
          type="button"
          className="beat-status beat-error"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={retryBeatAnalysis}
        >
          Beat analysis failed. Retry
        </button>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Repaint the waveform and beat grid; per-column sampling through `msFromTrackX` keeps the drawing aligned with the non-linear scene cells. */
function drawWave(
  canvas: HTMLCanvasElement,
  analysis: BeatAnalysis | null,
  spans: readonly SceneCellSpan[],
  durationMs: number,
  startOffsetMs: number,
): void {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!analysis || durationMs <= 0) return;
  const styles = getComputedStyle(canvas);
  const waveColour = styles.getPropertyValue("--text-tertiary").trim() || "#8a8a8a";
  const gridColour = styles.getPropertyValue("--border-default").trim() || "#555555";

  ctx.strokeStyle = gridColour;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let lastX = -8;
  for (const beat of projectBeatGrid(analysis, startOffsetMs, durationMs)) {
    const x = Math.round(playheadFraction(beat, durationMs, spans) * rect.width) + 0.5;
    if (x - lastX < 4) continue;
    lastX = x;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rect.height);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  const { hopMs, values } = analysis.envelope;
  const mid = rect.height / 2;
  ctx.fillStyle = waveColour;
  for (let x = 0; x < rect.width; x++) {
    const ms = msFromTrackX(x + 0.5, rect.width, durationMs, spans, 1) + startOffsetMs;
    const v = values[Math.floor(ms / hopMs)] ?? 0;
    const h = Math.max(0.5, v * (mid - 1));
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
}
