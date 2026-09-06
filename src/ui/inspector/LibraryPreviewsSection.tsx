import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useClockStore } from "../../engine/clock";
import { isExporting, subscribeExporting } from "../../engine/exportState";
import type { AspectName } from "../../engine/format";
import { fsUrl } from "../../engine/media";
import { canQueuePresetPoster, queuePresetPoster } from "../../engine/presetPosters";
import { listAllPresets, refreshUserPresets, subscribePresets } from "../../engine/presets";
import { type LoadedProject, nativeProjectSlug } from "../../engine/project";
import { activeSceneIndex } from "../../engine/sceneTimeline";
import { listAllTemplates, refreshUserTemplates, subscribeTemplates } from "../../engine/templates";
import { useEditorStore } from "../../store/editorStore";
import { PresetCard } from "../PresetCard";
import { settleContentEdits } from "../settleContentEdits";
import { TemplateCard } from "../TemplateCard";
import { ThemeEditorIcon } from "../theme-editor/icons";

interface PreviewSlot {
  slot: number;
  path: string | null;
  mtimeMs: number | null;
  capture: { scene: number; sceneFile: string; atMs: number; aspect: AspectName } | null;
  error: string | null;
}
interface PreviewState {
  kind: "template" | "preset";
  cover: number;
  slots: PreviewSlot[];
}

export function LibraryPreviewsSection({
  project,
  aspect,
}: {
  project: LoadedProject;
  aspect: AspectName;
}) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [slot, setSlot] = useState(0);
  const [saving, setSaving] = useState<"capture" | "cover" | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const playing = useEditorStore((state) => state.playing);
  const exporting = useSyncExternalStore(subscribeExporting, isExporting, isExporting);
  const busy = saving !== null;
  const capturing = saving === "capture" || queued !== null;
  const templates = useSyncExternalStore(subscribeTemplates, listAllTemplates);
  const presets = useSyncExternalStore(subscribePresets, listAllPresets);
  const template = templates.find((entry) => entry.projectId === project.id);
  const preset = presets.find((entry) => entry.projectId === project.id);
  const slug = nativeProjectSlug(project.id);
  const available = canQueuePresetPoster(project.id);
  const load = useCallback(async () => {
    if (!available) return;
    const current = ++version.current;
    try {
      const next = await invoke<PreviewState>("get_library_previews", { slug });
      if (current === version.current) setState(next);
    } catch (e) {
      if (current === version.current) setError(String(e));
    }
  }, [available, slug]);
  useEffect(() => {
    void project;
    void load();
    return () => {
      version.current++;
    };
  }, [load, project]);
  useEffect(() => {
    if (!available) return;
    let disposed = false;
    const saved = listen<{ projectId: string; slot: number }>(
      "kookaburra://library-preview-saved",
      ({ payload }) => {
        if (disposed || payload.projectId !== slug) return;
        void load().then(() => setQueued((current) => (current === payload.slot ? null : current)));
      },
    );
    const failed = listen<{ projectId: string; slot: number; error: string }>(
      "kookaburra://library-preview-failed",
      ({ payload }) => {
        if (disposed || payload.projectId !== slug) return;
        setQueued((current) => (current === payload.slot ? null : current));
        setError(`Preview ${payload.slot + 1}: ${payload.error}`);
      },
    );
    return () => {
      disposed = true;
      for (const pending of [saved, failed])
        void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [available, load, slug]);
  if (!available) return null;
  const current = state?.slots[slot];
  const previews = state?.slots.map((entry, index) =>
    entry.path
      ? `${fsUrl(entry.path)}?v=${entry.mtimeMs ?? 0}`
      : (template?.previews?.[index] ?? null),
  );
  const save = async (capture: boolean) => {
    if (busy || capturing || !state || isExporting() || playing) return;
    const at = useClockStore.getState().currentMs;
    const scene = activeSceneIndex(project.slots, at);
    const sceneSlot = project.slots[scene];
    if (!sceneSlot) return;
    const point = {
      scene,
      sceneFile: project.sceneFiles[scene],
      atMs: Math.max(0, Math.min(sceneSlot.durationMs, at - sceneSlot.startMs)),
      aspect,
    };
    setSaving(capture ? "capture" : "cover");
    setError(null);
    try {
      await settleContentEdits();
      const next = await invoke<PreviewState>("set_library_preview", {
        slug,
        slot,
        capture: capture ? point : null,
        cover: capture ? null : slot,
      });
      setState(next);
      if (capture) setQueued(slot);
      await (state.kind === "template" ? refreshUserTemplates() : refreshUserPresets());
      await queuePresetPoster(project.id);
    } catch (e) {
      setError(String(e));
      setQueued(null);
    } finally {
      setSaving(null);
    }
  };
  return (
    <section className="library-previews-section" aria-label="Library previews">
      <h3>
        <ThemeEditorIcon name="image" />
        Library previews
      </h3>
      {state?.kind === "template" && (
        <div className="library-preview-slots">
          {state.slots.map((entry, index) => (
            <button
              type="button"
              className={`btn btn-small chip-with-icon${slot === index ? " selected" : ""}`}
              key={entry.slot}
              aria-label={`Preview ${index + 1}${state.cover === index ? ", cover" : ""}`}
              aria-pressed={slot === index}
              title={entry.error ?? `Preview ${index + 1}`}
              disabled={busy}
              onClick={() => setSlot(index)}
            >
              <ThemeEditorIcon name="image" />
              {index + 1}
              {state.cover === index && <ThemeEditorIcon name="visible" />}
            </button>
          ))}
        </div>
      )}
      <div className="library-preview-card" inert>
        {template ? (
          <TemplateCard
            entry={{ ...template, previews: previews ?? template.previews }}
            selected={false}
            tabStop={false}
            onSelect={() => {}}
            previewFrame={slot}
          />
        ) : preset ? (
          <PresetCard
            entry={{ ...preset, previewUrl: previews?.[0] ?? preset.previewUrl }}
            selected={false}
            tabStop={false}
            onSelect={() => {}}
          />
        ) : null}
      </div>
      {current?.capture && (
        <p className="inspector-hint">
          Scene {current.capture.scene + 1} · {(current.capture.atMs / 1000).toFixed(2)}s ·{" "}
          {current.capture.aspect}
        </p>
      )}
      {current?.error && <p className="modal-warn">{current.error}</p>}
      <button
        type="button"
        className="btn chip-with-icon"
        disabled={busy || capturing || !state || playing || exporting}
        aria-busy={capturing || undefined}
        onClick={() => void save(true)}
      >
        {capturing ? (
          <span className="button-spinner" aria-hidden="true" />
        ) : (
          <ThemeEditorIcon name="image" />
        )}
        {capturing ? "Capturing…" : "Capture current frame"}
      </button>
      {state?.kind === "template" && (
        <button
          type="button"
          className="btn chip-with-icon"
          disabled={busy || capturing || state.cover === slot || playing || exporting}
          onClick={() => void save(false)}
        >
          <ThemeEditorIcon name="visible" />
          {state.cover === slot ? "Cover preview" : "Use as cover"}
        </button>
      )}
      {capturing && (
        <p className="inspector-hint" role="status">
          {exporting
            ? `Preview ${(queued ?? slot) + 1} is waiting for export to finish.`
            : playing
              ? `Preview ${(queued ?? slot) + 1} is waiting for playback to finish.`
              : `Capturing preview ${(queued ?? slot) + 1}…`}
        </p>
      )}
      {error && (
        <p className="modal-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
