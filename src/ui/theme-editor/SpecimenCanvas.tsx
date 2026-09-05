import { Canvas, useThree } from "@react-three/fiber";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { CompositorDriver } from "../../engine/CompositorDriver";
import { useClockStore } from "../../engine/clock";
import { releaseCompositorPools } from "../../engine/compositor";
import { useEffectsStore } from "../../engine/effectsStore";
import { type AspectName, CAMERA, FORMATS, SHADOW_MAP_TYPE } from "../../engine/format";
import { ensureRectAreaLightUniforms } from "../../engine/lightingState";
import { type LoadedProject, loadProject, sceneFileStem } from "../../engine/project";
import { RenderSettingsApplier } from "../../engine/RenderSettingsApplier";
import { StageScenes } from "../../engine/StageScenes";
import { THEME_PREVIEW_PROJECT_ID, THEME_PREVIEW_SCENES } from "../../engine/themePreviews";
import { useEditorStore } from "../../store/editorStore";
import type { Theme } from "../../theme/tokens";
import { preloadBundledBackdrops } from "../../toolkit/stage/backdrops";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";

/** The live specimen: the shipped `preview-lab-theme` project rendered in the editor window's own canvas with the DRAFT theme injected through `loadProject({ theme })`, the same override the theme-preview pipeline uses for saved themes. Preview only: no export path, no capture bridge, no editor-store theme plumbed into the scenes (the store writes below are this realm's format/effects half, exactly what the hidden render window does). */

/** How long typing settles before the specimen reloads; a colour field commits per keystroke and a project load is not free. */
export const SPECIMEN_DEBOUNCE_MS = 350;

const ASPECTS: readonly { id: AspectName; icon: ThemeEditorIconName }[] = [
  { id: "16:9", icon: "aspect-landscape" },
  { id: "9:16", icon: "aspect-portrait" },
  { id: "1:1", icon: "aspect-square" },
  { id: "4:5", icon: "aspect-portrait" },
];

/** Chip labels and icons for the specimen scenes, by file stem. An unknown stem still gets a chip, named after its stem. */
const SCENE_CHIPS: Record<string, { label: string; icon: ThemeEditorIconName }> = {
  "01-app-version": { label: "Stage", icon: "stage" },
  "02-title": { label: "Text", icon: "headline" },
  "03-device-video": { label: "Device", icon: "device" },
  "04-title-2": { label: "Text 2", icon: "headline" },
  "05-device-camera": { label: "Camera", icon: "device" },
  "06-app-version-end": { label: "Closing", icon: "stage" },
};

/** Re-render one frame per clock write; the specimen's canvas is `frameloop="demand"` like the studio's. */
function SpecimenClock() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    return useClockStore.subscribe((state, prev) => {
      if (state.currentMs !== prev.currentMs) invalidate();
    });
  }, [invalidate]);
  return null;
}

/** Holds `value` until it has stopped changing for `delayMs`; the first value passes straight through so the specimen loads on open rather than a beat later. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function SpecimenCanvas({ theme }: { theme: Theme }) {
  const settledTheme = useSettled(theme, SPECIMEN_DEBOUNCE_MS);
  const [project, setProject] = useState<LoadedProject | null>(null);
  const [aspect, setAspect] = useState<AspectName>("16:9");
  const [slotIndex, setSlotIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const format = FORMATS[aspect];
  const stale = loading || settledTheme !== theme;

  useEffect(() => {
    useEditorStore.getState().setFormat(format);
  }, [format]);

  // Every draft settle reloads the specimen: the theme feeds fonts, effects and LUT resolution inside the load, so patching a loaded project afterwards would only be half a re-theme.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        await preloadBundledBackdrops();
        const loaded = await loadProject(THEME_PREVIEW_PROJECT_ID, { theme: settledTheme });
        if (cancelled) return;
        useEditorStore.getState().setTheme(loaded.theme);
        useEffectsStore
          .getState()
          .setProjectEffects(
            loaded.effects,
            loaded.effectOverrides,
            loaded.sceneEffectDefaults,
            loaded.renderSettings,
          );
        useClockStore.getState().setDurationMs(loaded.totalMs);
        setProject(loaded);
        setError(null);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settledTheme]);

  // The pooled compositor targets outlive the canvas otherwise, and this window shares the studio's WebContent memory ceiling.
  useEffect(() => releaseCompositorPools, []);

  const chips = useMemo(() => {
    if (!project) return [];
    const wanted = THEME_PREVIEW_SCENES.filter((index) => index < project.slots.length);
    const indices = wanted.length > 0 ? wanted : project.slots.map((_, index) => index);
    return indices.map((index) => {
      const stem = sceneFileStem(project.sceneFiles[index]);
      return { index, ...(SCENE_CHIPS[stem] ?? { label: stem, icon: "stage" as const }) };
    });
  }, [project]);

  const slot = project?.slots[Math.min(slotIndex, project.slots.length - 1)];

  // A reload or a chip click parks the playhead at the top of the chosen scene, past nothing: the scene owns the whole window.
  const startMs = slot?.startMs;
  useEffect(() => {
    if (startMs !== undefined) useClockStore.getState().setCurrentMs(startMs);
  }, [startMs]);

  // Preview playback: real elapsed time, looped inside the selected scene. Preview only, so reading the wall clock here can never reach an export.
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useEffect(() => {
    if (!playing || !project) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const bounds = slotRef.current;
      const dt = now - last;
      last = now;
      if (bounds) {
        const clock = useClockStore.getState();
        const next = clock.currentMs + dt;
        clock.setCurrentMs(next >= bounds.endMs ? bounds.startMs : next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project]);

  return (
    <div className="theme-editor-specimen-live">
      <div className="theme-editor-specimen-stage">
        <div
          className="stage-frame"
          style={{ "--stage-aspect": format.width / format.height } as CSSProperties}
        >
          <Canvas
            frameloop="demand"
            dpr={[1, 2]}
            gl={{ antialias: true }}
            shadows={{ enabled: true, type: SHADOW_MAP_TYPE }}
            onCreated={() => ensureRectAreaLightUniforms()}
            camera={{ position: CAMERA.position, fov: CAMERA.fov }}
          >
            <color attach="background" args={[theme.colors.background]} />
            <SpecimenClock />
            <RenderSettingsApplier />
            {project && (
              <CompositorDriver
                projectId={project.id}
                slots={project.slots}
                cameraTrack={project.cameraTrack}
                sceneDocs={project.sceneDocs}
                theme={project.theme}
                sceneThemes={project.sceneThemes}
                projectLighting={project.projectLighting}
                sceneFrames={project.sceneFrames}
                compareBDocs={project.compareBDocs}
                compareBThemes={project.compareBThemes}
                commitStamp={project}
              />
            )}
            <StageScenes project={project} />
          </Canvas>
        </div>
        {stale && <span className="theme-editor-specimen-stale">Updating…</span>}
      </div>

      {error && (
        <p className="theme-editor-specimen-error" role="alert">
          <ThemeEditorIcon name="warning" size={14} />
          {error}
        </p>
      )}

      <div className="theme-editor-specimen-controls">
        <fieldset className="theme-editor-options">
          <legend className="visually-hidden">Specimen scene</legend>
          {chips.map((chip) => (
            <button
              key={chip.index}
              type="button"
              aria-pressed={slot?.index === chip.index}
              className={`chip chip-with-icon${slot?.index === chip.index ? " selected" : ""}`}
              onClick={() => setSlotIndex(chip.index)}
            >
              <ThemeEditorIcon name={chip.icon} size={14} />
              {chip.label}
            </button>
          ))}
        </fieldset>
        <div className="theme-editor-specimen-transport">
          <fieldset className="theme-editor-options">
            <legend className="visually-hidden">Specimen aspect</legend>
            {ASPECTS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={aspect === entry.id}
                className={`chip chip-with-icon${aspect === entry.id ? " selected" : ""}`}
                onClick={() => setAspect(entry.id)}
              >
                <ThemeEditorIcon name={entry.icon} size={14} />
                {entry.id}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            aria-pressed={playing}
            className="chip chip-with-icon"
            onClick={() => setPlaying((on) => !on)}
          >
            <ThemeEditorIcon name={playing ? "pause" : "play"} size={14} />
            {playing ? "Pause" : "Play"}
          </button>
        </div>
      </div>
    </div>
  );
}
