import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { PerspectiveCamera } from "three";
import { applyCameraTrack, sampleCameraTrack } from "../engine/cameraTrack";
import { useClockStore } from "../engine/clock";
import { renderComposited } from "../engine/compositor";
import { preloadEnvironments } from "../engine/environments";
import { resolveOverlays } from "../engine/overlayPlan";
import { setSceneHold } from "../engine/presentHold";
import { snapshotPresentTimings } from "../engine/presentTimingRegistry";
import type { LoadedProject } from "../engine/project";
import { buildSceneCameraTracks, orbitToView, resolveFrameCameras } from "../engine/sceneCamera";
import { getSceneHosts } from "../engine/sceneHostRegistry";
import { buildSceneRenderStates, resolveFrameSceneStates } from "../engine/sceneState";
import {
  applyTransitionEase,
  defaultDirection,
  type Resolved,
  resolveAt,
  resolveTransitionParams,
} from "../engine/sceneTimeline";
import { sampleLoopedSceneCamera } from "./cameraLoop";
import { type DerivedHold, derivePresentHold } from "./holdPoint";
import { usePresentStore } from "./presentStore";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** End-of-deck fade length, ms. */
const END_FADE_MS = 600;

/** Minimum warm-up before the first scene may jump to its hold. */
const INITIAL_SETTLE_MIN_MS = 250;
/** The derived hold must sit unchanged this long before the jump (async typesets land their stagger spread late). */
const INITIAL_SETTLE_STABLE_MS = 150;
/** Give up waiting on a slow Suspense resolve and jump with whatever registered; holding self-heals upward after. */
const INITIAL_SETTLE_CAP_MS = 2500;

interface LeaveState {
  fromIndex: number;
  /** Raw scene-local ms when the leave began (the outro re-bases onto it). */
  startRawMs: number;
  hold: DerivedHold;
  anchoredNext: boolean;
}

/** The present window's render driver: same shape as CompositorDriver (a priority useFrame calling the shared renderComposited), but what is on screen comes from the deck state, not the authored global timeline. The clock is MONOTONIC for the whole session; each scene's local time derives from its anchor, holds clamp staged text via presentHold, and the leave re-bases the same clamp forward each frame so authored outros replay at natural speed. */
export function PresentCompositorDriver({
  project,
  mode,
}: {
  project: LoadedProject;
  mode: "video" | "slideshow";
}) {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const sceneTracks = useMemo(() => buildSceneCameraTracks(project.sceneDocs), [project]);
  const sceneStates = useMemo(
    () => buildSceneRenderStates(project.theme, project.sceneThemes),
    [project],
  );
  const overlays = useMemo(
    () => resolveOverlays(project.sceneFrames, project.sceneThemes),
    [project],
  );

  useEffect(() => {
    void preloadEnvironments(gl, [project.theme, ...project.sceneThemes]).then(() => invalidate());
  }, [gl, project, invalidate]);

  // Redraw on deck changes that land while the clock is parked (e.g. back nav in video pause).
  useEffect(() => usePresentStore.subscribe(() => invalidate()), [invalidate]);

  const leaveRef = useRef<LeaveState | null>(null);
  const holdsRef = useRef<Record<number, DerivedHold>>({});
  const appliedHoldRef = useRef<Record<number, number | null>>({});
  const initialJumpRef = useRef(false);
  const settleProbeRef = useRef({ holdMs: -1, sinceRawMs: 0 });

  useFrame((s) => {
    const clockMs = useClockStore.getState().currentMs;
    const store = usePresentStore.getState();
    const { deck, anchors } = store;
    const slots = project.slots;

    const applyHold = (index: number, value: number | null) => {
      if (appliedHoldRef.current[index] === value) return;
      appliedHoldRef.current[index] = value;
      setSceneHold(index, value);
    };
    const deriveHold = (index: number) =>
      derivePresentHold(snapshotPresentTimings(index), slots[index].durationMs);

    let resolved: Resolved;
    let loopRawMs: number | null = null;

    if (mode === "video" || slots.length === 0) {
      resolved = resolveAt(slots, clockMs);
    } else {
      const i = Math.min(deck.sceneIndex, slots.length - 1);
      const anchor = anchors[i] ?? slots[i].startMs;
      const raw = clockMs - anchor;
      resolved = { active: [{ index: i, localMs: raw }] };

      if (deck.phase === "entering") {
        leaveRef.current = null;
        store.setEndFade(0);
        if (anchors[i] === undefined) store.setAnchor(i, anchor);
        if (!initialJumpRef.current && i === 0) {
          // First open: wait behind the loading overlay until the Suspense tree has committed (registrations only land on commit) and the derived hold has stopped moving, then land on the stable hold (text settled, camera rested) so the reveal never shows a mid-intro frame.
          const hold = deriveHold(0);
          if (settleProbeRef.current.holdMs !== hold.holdMs) {
            settleProbeRef.current = { holdMs: hold.holdMs, sinceRawMs: raw };
          }
          const stableForMs = raw - settleProbeRef.current.sinceRawMs;
          const ready =
            store.scenesCommitted &&
            raw >= INITIAL_SETTLE_MIN_MS &&
            stableForMs >= INITIAL_SETTLE_STABLE_MS;
          if (ready || raw >= INITIAL_SETTLE_CAP_MS) {
            const track = sceneTracks[0];
            const camEndMs = track ? (track.keys[track.keys.length - 1]?.tMs ?? 0) : 0;
            store.setAnchor(0, clockMs - Math.max(hold.holdMs, camEndMs));
            holdsRef.current[0] = hold;
            applyHold(0, hold.holdMs);
            initialJumpRef.current = true;
            store.dispatch({ type: "settled" });
          }
        } else {
          const hold = deriveHold(i);
          if (raw >= hold.holdMs) {
            holdsRef.current[i] = hold;
            applyHold(i, hold.holdMs);
            store.dispatch({ type: "settled" });
          }
        }
      } else if (deck.phase === "holding") {
        leaveRef.current = null;
        store.setEndFade(0);
        // Self-heal upward: a late registration (slow typeset or Suspense resolve) may raise the derived hold; the clamp follows so text can never freeze mid-intro. Never lowered, to avoid jitter.
        const derived = deriveHold(i);
        const latched = holdsRef.current[i];
        if (!latched || derived.holdMs > latched.holdMs) holdsRef.current[i] = derived;
        const hold = holdsRef.current[i];
        applyHold(i, hold.holdMs);
        const loop = project.sceneDocs[i]?.camera?.presentLoop;
        if (loop && sceneTracks[i]) loopRawMs = raw;
      } else if (deck.phase === "leaving") {
        if (!leaveRef.current) {
          leaveRef.current = {
            fromIndex: i,
            startRawMs: raw,
            hold: holdsRef.current[i] ?? deriveHold(i),
            anchoredNext: false,
          };
        }
        const lv = leaveRef.current;
        const durA = slots[i].durationMs;
        const mapped = Math.min(lv.hold.outStartMs + (raw - lv.startRawMs), durA);
        applyHold(i, mapped);
        const next = slots[i + 1] as (typeof slots)[number] | undefined;
        if (next) {
          const spec = next.transitionIn;
          const overlap = spec?.durationMs ?? 0;
          const transStart = durA - overlap;
          if (mapped >= transStart) {
            if (!lv.anchoredNext) {
              lv.anchoredNext = true;
              store.setAnchor(i + 1, clockMs);
              delete holdsRef.current[i + 1];
              applyHold(i + 1, null);
            }
            const localB = clockMs - (usePresentStore.getState().anchors[i + 1] ?? clockMs);
            if (spec) {
              const linear = overlap > 0 ? clamp01((mapped - transStart) / overlap) : 1;
              resolved = {
                active: [
                  { index: i, localMs: raw },
                  { index: i + 1, localMs: localB },
                ],
                transition: {
                  type: spec.type,
                  direction: spec.direction ?? defaultDirection(spec.type),
                  params: resolveTransitionParams(spec),
                  color: spec.color,
                  progress: applyTransitionEase(spec.ease, linear),
                  fromIndex: i,
                  toIndex: i + 1,
                },
              };
            } else {
              resolved = { active: [{ index: i + 1, localMs: localB }] };
            }
          }
          if (mapped >= durA) {
            applyHold(i, null);
            leaveRef.current = null;
            store.dispatch({ type: "left" });
          }
        } else {
          store.setEndFade(clamp01((mapped - (durA - END_FADE_MS)) / END_FADE_MS));
          if (mapped >= durA) {
            leaveRef.current = null;
            store.dispatch({ type: "left" });
          }
        }
      } else {
        store.setEndFade(1);
      }
    }

    let plan =
      resolveFrameCameras(sceneTracks, project.cameraTrack, resolved, clockMs) ?? undefined;
    if (loopRawMs !== null) {
      const i = Math.min(deck.sceneIndex, slots.length - 1);
      const track = sceneTracks[i];
      const loop = project.sceneDocs[i]?.camera?.presentLoop;
      if (track && loop) {
        const view = orbitToView(sampleLoopedSceneCamera(track, loopRawMs, loop));
        const fov = sampleCameraTrack(project.cameraTrack ?? [], clockMs).fov;
        plan = { solo: { position: view.position, lookAt: view.lookAt, fov } };
      }
    }
    if (!plan) applyCameraTrack(s.camera as PerspectiveCamera, project.cameraTrack, clockMs);
    const statePlan = resolveFrameSceneStates(sceneStates, resolved);
    renderComposited(
      s.gl,
      s.scene,
      s.camera,
      getSceneHosts(),
      resolved,
      plan,
      statePlan,
      overlays ?? undefined,
    );
  }, 1);

  return null;
}
