import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { TRANSITION_CATALOG } from "../engine/transitionCatalog";
import { SceneInsertTimeline } from "./SceneInsertTimeline";
import { sceneIndexAtPlayhead, type WizardSceneInfo } from "./SceneWizards";
import { useEscapeClose } from "./useEscapeClose";

/** Mini form wizards behind the terminal helper chips: each composes a concrete, well-formed prompt from a few fields, then hands it to the panel, which pastes it into the Claude session exactly like the old one-click templates (bracketed paste, never auto-submitted; the user can still edit before pressing Enter). */

export type WizardKind = "new-scene" | "pacing" | "look" | "media";

const DURATION_PRESETS = [
  { label: "Quick", seconds: 2 },
  { label: "Standard", seconds: 4 },
  { label: "Long", seconds: 6 },
] as const;

// Derived from the picker's catalogue: one vocabulary everywhere.
const TRANSITIONS = [
  ...TRANSITION_CATALOG.map((m) => ({ id: m.type, label: m.label })),
  { id: "none", label: "No transition" },
] as const;

function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

/** Quick / Standard / Long / Custom seconds, returns whole/half seconds. */
function DurationField({
  value,
  onChange,
}: {
  value: number;
  onChange: (seconds: number) => void;
}) {
  const [custom, setCustom] = useState(false);
  return (
    <div className="wizard-presets">
      {DURATION_PRESETS.map((p) => (
        <button
          type="button"
          key={p.label}
          className={`chip${!custom && value === p.seconds ? " selected" : ""}`}
          onClick={() => {
            setCustom(false);
            onChange(p.seconds);
          }}
        >
          {p.label} · {p.seconds}s
        </button>
      ))}
      <button
        type="button"
        className={`chip${custom ? " selected" : ""}`}
        onClick={() => setCustom(true)}
      >
        Custom
      </button>
      {custom && (
        <input
          className="modal-input wizard-seconds"
          type="number"
          min={0.5}
          step={0.5}
          value={value}
          onChange={(e) => onChange(Math.max(0.5, Number(e.target.value) || 0.5))}
          aria-label="Duration in seconds"
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // A div, not <label>: some fields render plain text (e.g. the empty-assets note), which a label may not wrap. Controls are adjacent to their visible caption.
  return (
    <div className="wizard-field">
      <span className="wizard-label">{label}</span>
      {children}
    </div>
  );
}

export function HelperWizard({
  kind,
  scenes,
  thumbs,
  slug,
  onInsert,
  onCancel,
}: {
  kind: WizardKind;
  /** The loaded project's scenes, for scene-aware dropdowns and the placement strip. */
  scenes: WizardSceneInfo[];
  /** Scene-thumb paths by stem, for the placement strip's cards. */
  thumbs: Record<string, string>;
  /** Project slug, for the media listing. */
  slug: string;
  /** Receives the composed prompt (the panel pastes it, unsubmitted). */
  onInsert: (prompt: string) => void;
  onCancel: () => void;
}) {
  useEscapeClose(onCancel);
  const titleId = useId();

  // Shared field state (each wizard uses the subset it renders).
  const [description, setDescription] = useState("");
  const [seconds, setSeconds] = useState(4);
  // Seeded after the scene under the playhead, the place a new scene usually belongs.
  const [placement, setPlacement] = useState(() => `after:${sceneIndexAtPlayhead(scenes)}`);
  // "media" defaults to "a new scene" (empty target, a file elsewhere); pacing targets a scene INDEX. One wizard mounts per open, so per-kind init is safe.
  const [sceneTarget, setSceneTarget] = useState(
    kind === "media" ? "" : scenes[0] ? String(scenes[0].index) : "",
  );
  const [scope, setScope] = useState("video");
  const [transition, setTransition] = useState<string>("crossfade");
  const [mediaFiles, setMediaFiles] = useState<string[] | null>(null);
  const [mediaFile, setMediaFile] = useState("");

  useEffect(() => {
    if (kind !== "media") return;
    let cancelled = false;
    invoke<string[]>("list_project_media", { slug })
      .then((files) => {
        if (cancelled) return;
        setMediaFiles(files);
        setMediaFile((current) => current || files[0] || "");
      })
      .catch(() => {
        if (!cancelled) setMediaFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, slug]);

  // Named like the pickers, with the file as the unambiguous anchor: ids can repeat across scenes, files cannot.
  const sceneName = (file: string) => {
    const scene = scenes.find((s) => s.file === file);
    return scene ? `the "${scene.name ?? scene.stem}" scene (${scene.file})` : `the ${file} scene`;
  };

  function compose(): string | null {
    const desc = description.trim();
    switch (kind) {
      case "new-scene": {
        if (!desc) return null;
        const afterScene =
          placement.startsWith("after:") && scenes[Number(placement.slice("after:".length))];
        // Named like the strip's caption, with the file as the unambiguous anchor.
        const where =
          placement === "start"
            ? "at the start"
            : afterScene
              ? `after the "${afterScene.name ?? afterScene.stem}" scene (${afterScene.file})`
              : "at the end";
        const enter =
          transition === "none"
            ? "with no transition"
            : `with the previous scene exiting into it via a ${TRANSITIONS.find((t) => t.id === transition)?.label.toLowerCase()} (the transition goes on the previous scene's entry)`;
        return `Add a new scene to this video: ${desc}. Place it ${where} in project.json, about ${seconds} seconds long, ${enter}.`;
      }
      case "pacing": {
        const current = scenes[Number(sceneTarget)];
        if (!current) return null;
        return `Change the pacing: make ${sceneName(current.file)} about ${seconds} seconds long (it is currently ${secondsLabel(current.durationMs)}). Update the durations in project.json and keep the transitions intact.`;
      }
      case "look": {
        if (!desc) return null;
        const target = scope === "video" ? "the whole video" : sceneName(scope);
        return `Change the look of ${target}: ${desc}. Adjust how the scenes use the theme tokens — never hard-code colours in scene files.`;
      }
      case "media": {
        if (!mediaFile || !desc) return null;
        const where = sceneTarget === "" ? "a new scene at the end" : sceneName(sceneTarget);
        return `Use my file ${mediaFile} in ${where}: ${desc}. Reference it by its relative path.`;
      }
    }
  }

  const prompt = compose();

  const titles: Record<WizardKind, string> = {
    "new-scene": "New scene",
    pacing: "Change pacing",
    look: "Change the look",
    media: "Use my media",
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={`modal${kind === "new-scene" ? " wizard-wide wizard-place-wide" : ""}`}>
        <h2 id={titleId}>{titles[kind]}</h2>

        {kind === "new-scene" && (
          <>
            <Field label="What should it show?">
              <textarea
                className="modal-input wizard-textarea"
                // biome-ignore lint/a11y/noAutofocus: the wizard exists to fill this field
                autoFocus
                placeholder="e.g. a headline saying “Now with offline mode” over a slow zoom"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Where?">
              <SceneInsertTimeline
                scenes={scenes}
                thumbs={thumbs}
                value={placement}
                onChange={setPlacement}
              />
            </Field>
            <Field label="How long?">
              <DurationField value={seconds} onChange={setSeconds} />
            </Field>
            <Field label="Comes in with">
              <select
                className="select"
                value={transition}
                onChange={(e) => setTransition(e.target.value)}
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}

        {kind === "pacing" && (
          <>
            <Field label="Which scene?">
              <select
                className="select"
                value={sceneTarget}
                onChange={(e) => setSceneTarget(e.target.value)}
              >
                {scenes.map((s) => (
                  <option key={s.stem} value={String(s.index)}>
                    {s.name ?? s.stem} · {secondsLabel(s.durationMs)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="New length">
              <DurationField value={seconds} onChange={setSeconds} />
            </Field>
          </>
        )}

        {kind === "look" && (
          <>
            <Field label="Apply to">
              <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="video">The whole video</option>
                {scenes.map((s) => (
                  <option key={s.stem} value={s.file}>
                    Only “{s.name ?? s.stem}”
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Describe the look">
              <textarea
                className="modal-input wizard-textarea"
                // biome-ignore lint/a11y/noAutofocus: the wizard exists to fill this field
                autoFocus
                placeholder="e.g. warmer and more premium — dark background, gold accents"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </>
        )}

        {kind === "media" && (
          <>
            <Field label="Which file?">
              {mediaFiles === null ? (
                <span className="muted">Looking in assets…</span>
              ) : mediaFiles.length === 0 ? (
                <span className="muted">
                  No media in this project yet — drop files into its assets folder first.
                </span>
              ) : (
                <select
                  className="select"
                  value={mediaFile}
                  onChange={(e) => setMediaFile(e.target.value)}
                >
                  {mediaFiles.map((f) => (
                    <option key={f} value={f}>
                      {f.replace(/^assets\//, "")}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Where?">
              <select
                className="select"
                value={sceneTarget}
                onChange={(e) => setSceneTarget(e.target.value)}
              >
                <option value="">In a new scene at the end</option>
                {scenes.map((s) => (
                  <option key={s.stem} value={s.file}>
                    In “{s.name ?? s.stem}”
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What should it do?">
              <textarea
                className="modal-input wizard-textarea"
                placeholder="e.g. play full-screen / show inside the phone mockup / logo in a corner"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </>
        )}

        {prompt && <p className="modal-hint wizard-preview">{prompt}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!prompt}
            onClick={() => prompt && onInsert(prompt)}
          >
            Insert prompt
          </button>
        </div>
      </div>
    </div>
  );
}
