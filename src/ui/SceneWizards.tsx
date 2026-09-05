import { listen } from "@tauri-apps/api/event";
import { useEffect, useId, useMemo, useState } from "react";
import { useClockStore } from "../engine/clock";
import { type HistoryChange, pushHistory } from "../engine/history";
import { fsUrl, type MediaMeta } from "../engine/media";
import {
  moveProjectScene,
  readProjectManifestSnapshot,
  removeProjectScene,
} from "../engine/projectEdit";
import { resyncFollowMediaDuration, writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { useEditorStore } from "../store/editorStore";
import {
  AVAILABLE_DEVICE_IDS,
  CUSTOM_COLOUR_PREFIX,
  customColourHex,
  DEFAULT_DEVICE_ID,
  DEVICE_CATALOG,
  type DeviceId,
  deviceColour,
  resolveAvailableDeviceId,
} from "../toolkit/device/catalog";
import type { DeviceMotionPreset, DeviceShadowMode } from "../toolkit/device/Device";
import { DEVICE_SHADOW_CHOICES } from "../toolkit/device/shadowProjector";
import { ColourPicker } from "./colour/ColourPicker";
import { applyDeviceChoice } from "./deviceChoice";
import { MediaBrowser } from "./MediaBrowser";
import { mediaCardMenu } from "./mediaCardMenu";
import { TextFieldRow } from "./SceneTextFields";
import { backgroundOptions } from "./stageOptions";
import { defaultDraft, draftToSpec, TEXT_PRESET_CATALOG } from "./textAnimationOptions";
import { useEscapeClose } from "./useEscapeClose";

/** Native scene editing and the scene picker shared by placement controls. */

export interface WizardSceneInfo {
  index: number;
  /** The TSX `defineScene` id: display only, not unique. Identify a scene by `file`, `stem` or `index`. */
  id: string;
  /** Manifest module path, e.g. `scenes/02-hero.tsx`. */
  file: string;
  /** File stem, the sidecar/thumb key. */
  stem: string;
  /** Sidecar display name, when the scene has a doc with one. */
  name: string | null;
  durationMs: number;
  startMs: number;
  doc?: SceneDoc;
}

export const MOTION_OPTIONS: { id: string; label: string }[] = [
  { id: "none", label: "None" },
  { id: "push-in", label: "Push-in settle" },
  { id: "turntable", label: "Slow turntable" },
  { id: "float", label: "Float" },
  { id: "tilt-reveal", label: "Tilt reveal" },
];

export const SHADOW_OPTIONS: { id: string; label: string }[] = DEVICE_SHADOW_CHOICES;

function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="wizard-field">
      <span className="wizard-label">{label}</span>
      {children}
    </div>
  );
}

/** The key a scene's single text line lives under: `title` unless only a legacy `headline` exists. */
function sceneTitleKey(doc: SceneDoc | undefined): "title" | "headline" {
  const managedCopyKeys = new Set(
    doc?.managedText?.items
      .filter((item) => item.type === "title" || item.type === "subtitle")
      .map((item) => item.key),
  );
  if (managedCopyKeys.has("title")) return "title";
  if (managedCopyKeys.has("headline")) return "headline";
  return doc?.text && "headline" in doc.text && !("title" in doc.text) ? "headline" : "title";
}

export function sceneWizardCanEditTitle(doc: SceneDoc | undefined): boolean {
  if (!doc) return false;
  if (doc.managedText === undefined) return true;
  const key = sceneTitleKey(doc);
  return doc.managedText.items.some(
    (item) => item.key === key && (item.type === "title" || item.type === "subtitle"),
  );
}

export function sceneWizardTitleValue(doc: SceneDoc | undefined): string {
  if (!doc || !sceneWizardCanEditTitle(doc)) return "";
  const key = sceneTitleKey(doc);
  return doc.managedText?.items.find((item) => item.key === key)?.text ?? doc.text?.[key] ?? "";
}

export function setSceneWizardTitle(doc: SceneDoc, value: string): SceneDoc {
  const next = structuredClone(doc);
  if (!sceneWizardCanEditTitle(doc)) return next;
  const key = sceneTitleKey(doc);
  const managedItem = next.managedText?.items.find((item) => item.key === key);
  if (managedItem) managedItem.text = value;
  next.text = { ...next.text, [key]: value };
  if (!value && key === "headline") delete next.text.headline;
  return next;
}

function ChipSelect({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="wizard-presets">
      {options.map((o) => (
        <button
          type="button"
          key={o.id}
          className={`chip${value === o.id ? " selected" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Text-motion chips for the wizards: preset vocabulary as default-param whole specs; params/delivery refinements live in the edit bar's Text-motion panel. */
const TEXT_ANIMATION_CHIPS = [
  { id: "default", label: "Theme default", value: undefined },
  ...TEXT_PRESET_CATALOG.map((m) => ({
    id: m.preset as string,
    label: m.label,
    value: draftToSpec(defaultDraft(m.preset)),
  })),
];

/** Background chips for the wizards: fixed-layer types keyed by type id, seeded from the active theme; image backgrounds stay an edit-bar/Claude affair since they need an asset pick, not a chip. */
function useBackgroundChips() {
  const theme = useEditorStore((s) => s.theme);
  return useMemo(
    () =>
      backgroundOptions(theme).map((o) => ({
        id: o.value?.type ?? "default",
        label: o.label,
        value: o.value,
      })),
    [theme],
  );
}

/** One catalog device with its colour swatches; the card art follows the colour. */
function DevicePicker({
  model,
  colour,
  onChange,
}: {
  model: DeviceId;
  colour: string;
  onChange: (model: DeviceId, colour: string) => void;
}) {
  return (
    <div className="device-picker">
      {AVAILABLE_DEVICE_IDS.map((id) => {
        const spec = DEVICE_CATALOG[id];
        const active = id === model;
        const activeColour = deviceColour(spec, active ? colour : spec.defaultColour);
        return (
          <div key={id} className={`device-card${active ? " selected" : ""}`}>
            <button
              type="button"
              className="device-card-main"
              aria-pressed={active}
              onClick={() => onChange(id, activeColour.id)}
            >
              <img
                src={spec.previews[activeColour.id] ?? spec.previews[spec.defaultColour]}
                alt=""
                draggable={false}
              />
              <span className="device-card-name">{spec.name}</span>
              <span className="muted">{activeColour.name}</span>
            </button>
            <fieldset className="device-swatches">
              <legend className="visually-hidden">{spec.name} colour</legend>
              {spec.colours.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  aria-pressed={active && colour === c.id}
                  aria-label={c.name}
                  title={c.name}
                  className={`swatch${active && colour === c.id ? " selected" : ""}`}
                  style={{ background: c.swatch }}
                  onClick={() => onChange(id, c.id)}
                />
              ))}
              <span
                className={`swatch-custom${active && customColourHex(colour) ? " selected" : ""}`}
              >
                <ColourPicker
                  value={(active ? customColourHex(colour) : undefined) ?? "#8a93a6"}
                  label="Custom colour"
                  onCommit={(hex) => onChange(id, CUSTOM_COLOUR_PREFIX + hex.toLowerCase())}
                />
              </span>
            </fieldset>
          </div>
        );
      })}
    </div>
  );
}

/** Scene cards with centre-frame thumbnails, selecting a scene by index (placement moved to SceneInsertTimeline). */
export function ScenePicker({
  scenes,
  thumbs,
  value,
  onChange,
}: {
  scenes: WizardSceneInfo[];
  thumbs: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="scene-picker">
      {scenes.map((s) => {
        const selected = value === String(s.index);
        return (
          <button
            type="button"
            key={s.stem}
            className={`scene-card${selected ? " selected" : ""}`}
            aria-pressed={selected}
            onClick={() => onChange(String(s.index))}
          >
            <span className="scene-card-thumb">
              {thumbs[s.stem] ? (
                <img src={fsUrl(thumbs[s.stem])} alt="" draggable={false} />
              ) : (
                <span aria-hidden>·</span>
              )}
            </span>
            <span className="scene-card-title" title={s.name ?? s.stem}>
              {s.name ?? s.stem}
            </span>
            <span className="muted">{secondsLabel(s.durationMs)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The scene whose window contains the playhead (later scene wins inside a transition). */
export function sceneIndexAtPlayhead(scenes: WizardSceneInfo[]): number {
  const ms = useClockStore.getState().currentMs;
  let found = 0;
  for (const s of scenes) {
    if (ms >= s.startMs) found = s.index;
  }
  return found;
}

// ── Edit scene ────────────────────────────────────────────────────────────────

export function EditSceneWizard({
  slug,
  projectPath,
  scenes,
  thumbs,
  onNeedThumbs,
  onSaved,
  onCancel,
}: {
  slug: string;
  projectPath: string;
  scenes: WizardSceneInfo[];
  thumbs: Record<string, string>;
  /** Ask the host to capture missing/stale thumbs; fired when the scene picker mounts. */
  onNeedThumbs: () => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [step, setStep] = useState<"pick" | "form" | "media">("pick");
  const [index, setIndex] = useState(() => sceneIndexAtPlayhead(scenes));
  const scene = scenes[index];
  const doc = scene?.doc;

  // Form state, seeded from the selected scene's sidecar when entering the form step.
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<DeviceId>(DEFAULT_DEVICE_ID);
  const [colour, setColour] = useState(DEVICE_CATALOG[DEFAULT_DEVICE_ID].defaultColour);
  const [deviceChoiceChanged, setDeviceChoiceChanged] = useState(false);
  const [media, setMedia] = useState<{
    rel: string;
    kind: "video" | "image";
    meta: MediaMeta | null;
  } | null>(null);
  const [motion, setMotion] = useState("none");
  const [shadow, setShadow] = useState("soft");
  const [background, setBackground] = useState("default");
  const [backgroundSeed, setBackgroundSeed] = useState("default");
  const [textAnim, setTextAnim] = useState("default");
  const [textAnimSeed, setTextAnimSeed] = useState("default");
  const [busy, setBusy] = useState(false);
  useEscapeClose(onCancel, !busy);
  const [error, setError] = useState<string | null>(null);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  useEffect(() => {
    const unlisten = listen("kookaburra://media-changed", () => setMediaRefresh((n) => n + 1));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  // The picker step is the only one with scene cards; it is also step one, so this reads as "on open".
  useEffect(() => {
    if (step === "pick") onNeedThumbs();
  }, [step, onNeedThumbs]);
  const pickEditMedia = (rel: string, meta: MediaMeta | null) => {
    setMedia({ rel, kind: meta?.kind === "image" ? "image" : "video", meta });
    setStep("form");
  };
  const backgroundChips = useBackgroundChips();
  // Scene management: move within the project or delete to the Trash; both land through onSaved because a scene-set change needs the host's full reload.
  const [confirmDeleteScene, setConfirmDeleteScene] = useState(false);
  useEffect(() => {
    if (!confirmDeleteScene) return;
    const timer = window.setTimeout(() => setConfirmDeleteScene(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteScene]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate disarm on selection change
  useEffect(() => setConfirmDeleteScene(false), [index]);
  async function arrange(action: () => Promise<void>, historyLabel?: string) {
    setBusy(true);
    setError(null);
    try {
      const manifestBefore = historyLabel ? await readProjectManifestSnapshot(slug) : null;
      await action();
      if (historyLabel && manifestBefore !== null) {
        pushHistory({
          label: historyLabel,
          changes: [
            {
              kind: "manifest",
              slug,
              before: manifestBefore,
              after: await readProjectManifestSnapshot(slug),
              reload: true,
            },
          ],
        });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const device = doc?.devices?.[0];

  function seedForm() {
    if (!doc) return;
    setName(doc.name ?? "");
    setTitle(sceneWizardTitleValue(doc));
    // Seeded by type; an untouched chip leaves the sidecar's background exactly as-is so a custom colour/drift/image src is never clobbered by a wizard save.
    const bg = doc.background?.type ?? "default";
    setBackground(bg);
    setBackgroundSeed(bg);
    // Same rule for text motion: seeded by the in preset; an untouched chip never clobbers custom delivery/params written by the edit bar's panel.
    const ta = doc.textAnimation?.in ?? "default";
    setTextAnim(ta);
    setTextAnimSeed(ta);
    const d = doc.devices?.[0];
    setDeviceChoiceChanged(false);
    if (d) {
      const validModel = resolveAvailableDeviceId(d.model);
      setModel(validModel);
      setColour(
        validModel === d.model
          ? (d.colour ?? DEVICE_CATALOG[validModel].defaultColour)
          : DEVICE_CATALOG[validModel].defaultColour,
      );
      setMedia(d.media ? { rel: d.media.src, kind: d.media.kind, meta: null } : null);
      setMotion(d.motion?.preset ?? "none");
      setShadow(d.shadow ?? "soft");
    }
    setStep("form");
  }

  async function save() {
    if (!scene || !doc) return;
    setBusy(true);
    setError(null);
    try {
      // Patch a copy of the loaded doc; unknown fields (camera, extra text keys) ride through untouched, only the wizard's fields change.
      const next = setSceneWizardTitle(doc, title.trim());
      next.name = name.trim() || undefined;
      if (background !== backgroundSeed) {
        if (background === "default") next.background = undefined;
        else {
          const chosen = backgroundChips.find((o) => o.id === background)?.value;
          if (chosen) next.background = chosen;
        }
      }
      if (textAnim !== textAnimSeed) {
        if (textAnim === "default") next.textAnimation = undefined;
        else {
          const chosen = TEXT_ANIMATION_CHIPS.find((o) => o.id === textAnim)?.value;
          if (chosen) next.textAnimation = chosen;
        }
      }
      const d = next.devices?.[0];
      const mediaChanged =
        (device?.media?.src ?? null) !== (media?.rel ?? null) ||
        (device?.media?.kind ?? null) !== (media?.kind ?? null);
      if (d) {
        applyDeviceChoice(d, { model, colour, changed: deviceChoiceChanged });
        d.media = media ? { ...d.media, src: media.rel, kind: media.kind } : undefined;
        d.motion = { ...d.motion, preset: motion as DeviceMotionPreset };
        d.shadow = shadow as DeviceShadowMode;
      }
      const historyChanges: HistoryChange[] = [];
      await writeSceneDoc(slug, scene.file, next);
      historyChanges.push({
        kind: "sceneDoc",
        slug,
        file: scene.file,
        sceneIndex: scene.index,
        before: structuredClone(doc),
        after: structuredClone(next),
      });
      // Duration-follow: a swapped video re-syncs the scene's project.json length.
      if (mediaChanged) {
        let resyncFailed: unknown = null;
        const manifestBefore = await readProjectManifestSnapshot(slug);
        const resynced = await resyncFollowMediaDuration(
          slug,
          scene.index,
          next,
          scene.durationMs,
          scene.file,
        ).catch((e) => {
          console.warn("[wizard] duration re-sync failed:", e);
          resyncFailed = e;
          return null;
        });
        if (!resyncFailed) {
          const manifestAfter = await readProjectManifestSnapshot(slug);
          if (manifestAfter !== manifestBefore) {
            historyChanges.push({
              kind: "manifest",
              slug,
              before: manifestBefore,
              after: manifestAfter,
              reload: false,
            });
          }
          if (resynced?.clampedDoc) {
            historyChanges.push({
              kind: "sceneDoc",
              slug,
              file: scene.file,
              sceneIndex: scene.index,
              before: structuredClone(next),
              after: structuredClone(resynced.clampedDoc),
            });
          }
        }
        if (resyncFailed) {
          // The doc write landed; only the project.json length is stale, so say so and hold the wizard open.
          setError(
            `Saved, but the scene length couldn't re-sync to the new video: ` +
              `${String(resyncFailed)}. Close and re-open Edit scene to retry.`,
          );
          setBusy(false);
          return;
        }
      }
      pushHistory({ label: "scene settings", changes: historyChanges });
      onSaved();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={`modal wizard-wide${step === "media" ? " wizard-media-wide" : ""}`}>
        <h2 id={titleId}>Edit scene</h2>

        {step === "pick" && (
          <>
            <Field label="Which scene?">
              <ScenePicker
                scenes={scenes}
                thumbs={thumbs}
                value={String(index)}
                onChange={(v) => setIndex(Number(v))}
              />
            </Field>
            {!doc && (
              <p className="modal-hint">
                This scene has no scene document yet, so there's nothing to edit here — ask Claude
                to add one, or edit the scene file directly.
              </p>
            )}
            <Field label="Arrange">
              <div className="wizard-presets">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy || index === 0}
                  onClick={() =>
                    void arrange(() => moveProjectScene(slug, index, index - 1), "scene move")
                  }
                >
                  ← Move earlier
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy || index >= scenes.length - 1}
                  onClick={() =>
                    void arrange(() => moveProjectScene(slug, index, index + 1), "scene move")
                  }
                >
                  Move later →
                </button>
                <button
                  type="button"
                  className={`btn btn-small${confirmDeleteScene ? " danger" : ""}`}
                  disabled={busy || scenes.length <= 1}
                  title="Moves the scene's files to the Trash (a project keeps at least one scene)"
                  onClick={() => {
                    if (!confirmDeleteScene) {
                      setConfirmDeleteScene(true);
                      return;
                    }
                    setConfirmDeleteScene(false);
                    void arrange(() => removeProjectScene(slug, index));
                  }}
                >
                  {confirmDeleteScene ? "Really delete?" : "Delete scene…"}
                </button>
              </div>
            </Field>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!doc || busy}
                onClick={seedForm}
              >
                Edit
              </button>
            </div>
          </>
        )}

        {step === "form" && (
          <>
            <Field label="Scene name">
              <input
                className="modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {sceneWizardCanEditTitle(doc) && (
              <TextFieldRow
                label="Title"
                value={title}
                placeholder="No title"
                onChange={setTitle}
              />
            )}
            <Field label="Background">
              <ChipSelect options={backgroundChips} value={background} onChange={setBackground} />
            </Field>
            <Field label="Text motion">
              <ChipSelect options={TEXT_ANIMATION_CHIPS} value={textAnim} onChange={setTextAnim} />
            </Field>
            {device && (
              <>
                <Field label="Device">
                  <DevicePicker
                    model={model}
                    colour={colour}
                    onChange={(m, c) => {
                      setModel(m);
                      setColour(c);
                      setDeviceChoiceChanged(true);
                    }}
                  />
                </Field>
                <Field label="Screen media">
                  <div className="wizard-media-row">
                    <span className="muted">
                      {media ? `${media.rel.replace(/^assets\//, "")} (${media.kind})` : "None"}
                    </span>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setStep("media")}
                    >
                      Change media…
                    </button>
                  </div>
                </Field>
                <Field label="Motion">
                  <ChipSelect options={MOTION_OPTIONS} value={motion} onChange={setMotion} />
                </Field>
                <Field label="Shadow">
                  <ChipSelect options={SHADOW_OPTIONS} value={shadow} onChange={setShadow} />
                </Field>
              </>
            )}
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setStep("pick")}>
                Back
              </button>
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </>
        )}

        {step === "media" && (
          <>
            <Field label="What plays on the screen?">
              <div className="wizard-media-host">
                <MediaBrowser
                  slug={slug}
                  projectPath={projectPath}
                  globalToggle
                  refreshKey={mediaRefresh}
                  onPick={pickEditMedia}
                  cardMenu={mediaCardMenu({
                    slug,
                    primaryLabel: "Select",
                    onPrimary: pickEditMedia,
                    onChanged: () => setMediaRefresh((n) => n + 1),
                    onError: setError,
                  })}
                />
              </div>
            </Field>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setStep("form")}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
