import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useMemo, useState } from "react";
import { useClockStore } from "../engine/clock";
import { type HistoryChange, pushHistory } from "../engine/history";
import { fsUrl, type MediaMeta } from "../engine/media";
import { optionPreviewStill } from "../engine/optionPreviews";
import {
  moveProjectScene,
  readProjectManifestSnapshot,
  removeProjectScene,
} from "../engine/projectEdit";
import { resyncFollowMediaDuration, writeSceneDoc } from "../engine/sceneDoc";
import { parseSceneDoc, type SceneDoc } from "../engine/sceneDocSchema";
import { useEditorStore } from "../store/editorStore";
import type { Theme } from "../theme/tokens";
import {
  CUSTOM_COLOUR_PREFIX,
  customColourHex,
  DEVICE_CATALOG,
  DEVICE_IDS,
  type DeviceId,
  deviceColour,
} from "../toolkit/device/catalog";
import type { DeviceMotionPreset, DeviceShadowMode } from "../toolkit/device/Device";
import { ColourPicker } from "./colour/ColourPicker";
import { MediaBrowser } from "./MediaBrowser";
import { mediaCardMenu } from "./mediaCardMenu";
import { TextFieldRow } from "./SceneTextFields";
import { backgroundOptions } from "./stageOptions";
import { defaultDraft, draftToSpec, TEXT_PRESET_CATALOG } from "./textAnimationOptions";
import { useEscapeClose } from "./useEscapeClose";

/** New/Edit-scene wizards + shared scene picker: scaffold/edit paths are fully native (no Claude session needed); only the optional polish-description paste needs one, and the host (TerminalPanel) owns pasting and the post-write reload. */

export interface WizardSceneInfo {
  index: number;
  /** Slot id (the TSX `defineScene` id). */
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

export interface ScaffoldedScene {
  file: string;
  docFile: string;
  sceneId: string;
  durationMs: number;
}

type SceneKind = "device" | "title" | "appversion" | "blank" | "layeredscreenshot" | "video";

const KIND_OPTIONS: { id: SceneKind; label: string; blurb: string }[] = [
  { id: "device", label: "Device + media", blurb: "A phone playing your video or image" },
  { id: "title", label: "Title", blurb: "A title on the theme background" },
  { id: "appversion", label: "App version", blurb: "Your app icon, name and version" },
  { id: "layeredscreenshot", label: "Layered screenshot", blurb: "A 3D stack of app screens" },
  { id: "video", label: "Video", blurb: "A video filling the whole frame" },
  { id: "blank", label: "Blank", blurb: "An empty scene to compose freely" },
];

/** The video kind's starting background, shipped in every project (`ensureSampleAssets`). */
const SAMPLE_LAPTOP_VIDEO = "assets/sample-laptop-recording.mp4";

export const MOTION_OPTIONS: { id: string; label: string }[] = [
  { id: "none", label: "None" },
  { id: "push-in", label: "Push-in settle" },
  { id: "turntable", label: "Slow turntable" },
  { id: "float", label: "Float" },
  { id: "tilt-reveal", label: "Tilt reveal" },
];

export const SHADOW_OPTIONS: { id: string; label: string }[] = [
  { id: "soft", label: "Soft contact" },
  { id: "long", label: "Long & smooth" },
  { id: "sun", label: "Sun sweep" },
  { id: "none", label: "None" },
];

function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wizard-field">
      <span className="wizard-label">{label}</span>
      {children}
    </div>
  );
}

/** The key a scene's single text line lives under: `title` unless only a legacy `headline` exists. */
function sceneTitleKey(doc: SceneDoc | undefined): "title" | "headline" {
  return doc?.text && "headline" in doc.text && !("title" in doc.text) ? "headline" : "title";
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
      {DEVICE_IDS.map((id) => {
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

function PlacementStartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path
        d="M6 4.5 9.5 8 6 11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="10.5" y="5" width="3.5" height="6" rx="0.75" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function PlacementEndIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 3v10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M10 4.5 6.5 8 10 11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="2" y="5" width="3.5" height="6" rx="0.75" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

/** Scene cards with centre-frame thumbnails; `placement` mode adds At-start/At-end pseudo-cards and encodes value as "start" | "end" | "after:<index>", `select` mode uses the scene index as a string. */
export function ScenePicker({
  scenes,
  thumbs,
  mode,
  value,
  onChange,
}: {
  scenes: WizardSceneInfo[];
  thumbs: Record<string, string>;
  mode: "select" | "placement";
  value: string;
  onChange: (value: string) => void;
}) {
  const card = (
    key: string,
    title: string,
    subtitle: string | null,
    thumb: string | null,
    selected: boolean,
    onPick: () => void,
    icon?: React.ReactNode,
  ) => (
    <button
      type="button"
      key={key}
      className={`scene-card${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onClick={onPick}
    >
      <span className="scene-card-thumb">
        {thumb ? (
          <img src={fsUrl(thumb)} alt="" draggable={false} />
        ) : (
          (icon ?? <span aria-hidden>·</span>)
        )}
      </span>
      <span className="scene-card-title" title={title}>
        {title}
      </span>
      {subtitle && <span className="muted">{subtitle}</span>}
    </button>
  );

  return (
    <div className="scene-picker">
      {mode === "placement" &&
        card(
          "start",
          "At the start",
          null,
          null,
          value === "start",
          () => onChange("start"),
          <PlacementStartIcon />,
        )}
      {scenes.map((s) =>
        card(
          s.stem,
          s.name ?? s.id,
          secondsLabel(s.durationMs),
          thumbs[s.stem] ?? null,
          mode === "placement" ? value === `after:${s.index}` : value === String(s.index),
          () => onChange(mode === "placement" ? `after:${s.index}` : String(s.index)),
        ),
      )}
      {mode === "placement" &&
        card(
          "end",
          "At the end",
          null,
          null,
          value === "end",
          () => onChange("end"),
          <PlacementEndIcon />,
        )}
    </div>
  );
}

/** The scene whose window contains the playhead (later scene wins inside a transition). */
export function sceneIndexAtPlayhead(scenes: WizardSceneInfo[]): number {
  const ms = useClockStore.getState().currentMs;
  let found = 0;
  for (const s of scenes) {
    if (ms >= s.startMs && ms < s.startMs + s.durationMs) found = s.index;
  }
  return found;
}

// ── New scene ─────────────────────────────────────────────────────────────────

export function NewSceneWizard({
  slug,
  projectPath,
  scenes,
  thumbs,
  theme,
  sessionRunning,
  onDone,
  onCancel,
}: {
  slug: string;
  projectPath: string;
  scenes: WizardSceneInfo[];
  /** Scene-thumb paths by stem (host loads them lazily on open). */
  thumbs: Record<string, string>;
  /** The project's theme, for the text-colour swatch defaults. */
  theme: Theme;
  /** A Claude session is running; enables the polish-description paste. */
  sessionRunning: boolean;
  /** Scaffold succeeded; `prompt` is the polish paste when a description was given. */
  onDone: (result: ScaffoldedScene, prompt: string | null) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [step, setStep] = useState<"type" | "device" | "media" | "details">("type");
  const [kind, setKind] = useState<SceneKind>("device");
  const [model, setModel] = useState<DeviceId>("iphone-17-pro");
  const [colour, setColour] = useState(DEVICE_CATALOG["iphone-17-pro"].defaultColour);
  const [media, setMedia] = useState<{ rel: string; kind: "video" | "image" } | null>(null);
  const [motion, setMotion] = useState("none");
  const [shadow, setShadow] = useState("soft");
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [titleColor, setTitleColor] = useState<string | null>(null);
  const [subtitleColor, setSubtitleColor] = useState<string | null>(null);
  const [background, setBackground] = useState("default");
  // A user click pins the chip; until then it tracks the placement's previous scene.
  const [backgroundTouched, setBackgroundTouched] = useState(false);
  const [textAnim, setTextAnim] = useState("default");
  const [placement, setPlacement] = useState("end");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  useEscapeClose(onCancel, !busy);
  const [error, setError] = useState<string | null>(null);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const pickWizardMedia = (rel: string, meta: MediaMeta | null) => {
    const fallback = kind === "layeredscreenshot" ? "image" : "video";
    setMedia({ rel, kind: meta?.kind ?? fallback });
    setStep("details");
  };
  const backgroundChips = useBackgroundChips();

  const position = useMemo(() => {
    if (placement === "start") return 0;
    if (placement === "end") return undefined;
    const after = Number(placement.replace(/^after:/, ""));
    return Number.isFinite(after) ? after + 1 : undefined;
  }, [placement]);

  // Kind + insertion position, e.g. "Title 3"; a pencil edit pins the name instead.
  const kindWord =
    kind === "device"
      ? "Device"
      : kind === "title"
        ? "Title"
        : kind === "appversion"
          ? "App version"
          : kind === "layeredscreenshot"
            ? "Layered screenshot"
            : kind === "video"
              ? "Video"
              : "Blank";
  const generatedName = `${kindWord} ${(position ?? scenes.length) + 1}`;
  const sceneName = nameOverride ?? generatedName;
  const titlePlaceholder =
    kind === "title"
      ? "e.g. Ship faster"
      : kind === "appversion"
        ? "e.g. Your App"
        : kind === "device"
          ? "Optional, sits above the device"
          : "Optional";
  // The lockup's hero line is the version; its label is muted, the reverse of a title scene.
  const isLockup = kind === "appversion";

  // Only an explicit doc.background is worth inheriting; an unset one already means theme default.
  const previousScene = position === undefined ? scenes[scenes.length - 1] : scenes[position - 1];
  const previousBackground = previousScene?.doc?.background;
  const backgroundChipsForNew = useMemo(
    () =>
      previousBackground
        ? [
            {
              id: "same-as-previous",
              label: "Same as previous",
              value: structuredClone(previousBackground),
            },
            ...backgroundChips,
          ]
        : backgroundChips,
    [backgroundChips, previousBackground],
  );
  useEffect(() => {
    if (backgroundTouched) return;
    setBackground(previousBackground ? "same-as-previous" : "default");
  }, [previousBackground, backgroundTouched]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const finalName = sceneName.trim() || generatedName;
      const result = await invoke<ScaffoldedScene>("scaffold_scene", {
        slug,
        options: {
          kind,
          name: finalName,
          title: title.trim() || null,
          subtitle: kind === "title" || kind === "appversion" ? subtitle.trim() || null : null,
          deviceModel: kind === "device" ? model : null,
          colour: kind === "device" ? colour : null,
          mediaRel:
            kind === "device" || kind === "layeredscreenshot" || kind === "video"
              ? (media?.rel ?? null)
              : null,
          mediaKind:
            kind === "device" || kind === "layeredscreenshot" || kind === "video"
              ? (media?.kind ?? null)
              : null,
          motionPreset: kind === "device" ? motion : null,
          shadow: kind === "device" ? shadow : null,
          position: position ?? null,
        },
      });
      // The scaffolder already wrote a video scene's background (the video itself); the details step hides the chips, so nothing to patch.
      const chosenBackground =
        kind === "video"
          ? undefined
          : backgroundChipsForNew.find((o) => o.id === background)?.value;
      const chosenTextAnim =
        kind === "video" ? undefined : TEXT_ANIMATION_CHIPS.find((o) => o.id === textAnim)?.value;
      const textStyle: Record<string, string> = {};
      if (titleColor) textStyle.titleColor = titleColor;
      if (subtitleColor && (kind === "title" || kind === "appversion")) {
        textStyle.subtitleColor = subtitleColor;
      }
      if (chosenBackground || chosenTextAnim || Object.keys(textStyle).length > 0) {
        // The scaffolder doesn't know backgrounds/text motion; patch the fresh sidecar via the same validated write path as the edit bar, and never fail the scaffold if the patch fails.
        try {
          const docFile = result.file.replace(/\.tsx$/, ".json");
          const text = await invoke<string | null>("read_scene_doc", { slug, file: docFile });
          const parsed = text ? parseSceneDoc(JSON.parse(text), `${slug}/${docFile}`) : undefined;
          if (parsed) {
            if (chosenBackground) parsed.background = chosenBackground;
            if (chosenTextAnim) parsed.textAnimation = chosenTextAnim;
            if (Object.keys(textStyle).length > 0) parsed.textStyle = textStyle;
            await writeSceneDoc(slug, result.file, parsed);
          }
        } catch (e) {
          // The scene already exists at this point; block the close so the user learns the chips didn't apply instead of silently shipping a half-configured scene.
          console.warn("[wizard] sidecar patch failed:", e);
          setError(
            `The scene was created, but its background/text choices couldn't be ` +
              `written: ${String(e)}. Close this and use Edit scene to apply them.`,
          );
          setBusy(false);
          return;
        }
      }
      const desc = description.trim();
      const prompt = desc
        ? `Polish the new scene ${result.file}: ${desc}. Its machine-editable values (text, ` +
          `devices, duration mode) live in ${result.docFile} — prefer editing that sidecar; ` +
          `use the TSX for composition. Keep every scene-authoring rule.`
        : null;
      onDone(result, prompt);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const detailsReady = !busy;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        className={`modal wizard-wide${step === "media" ? " wizard-media-wide" : ""}${
          step === "type" ? " wizard-kind-wide" : ""
        }`}
      >
        <h2 id={titleId}>New scene</h2>

        {step === "type" && (
          <>
            <div className="kind-picker">
              {KIND_OPTIONS.map((k) => {
                const preview = optionPreviewStill(`kind-${k.id}`);
                return (
                  <button
                    type="button"
                    key={k.id}
                    className={`kind-card${kind === k.id ? " selected" : ""}`}
                    aria-pressed={kind === k.id}
                    onClick={() => setKind(k.id)}
                  >
                    {preview && <img className="kind-card-preview" src={preview} alt="" />}
                    <span className="kind-card-label">{k.label}</span>
                    <span className="muted">{k.blurb}</span>
                  </button>
                );
              })}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  // The video kind's media step starts on the sample so "Use the sample video" is a one-click accept.
                  if (kind === "video" && media?.kind !== "video") {
                    setMedia({ rel: SAMPLE_LAPTOP_VIDEO, kind: "video" });
                  }
                  setStep(
                    kind === "device"
                      ? "device"
                      : kind === "layeredscreenshot" || kind === "video"
                        ? "media"
                        : "details",
                  );
                }}
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === "device" && (
          <>
            <Field label="Device">
              <DevicePicker
                model={model}
                colour={colour}
                onChange={(m, c) => {
                  setModel(m);
                  setColour(c);
                }}
              />
            </Field>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setStep("type")}>
                Back
              </button>
              <button type="button" className="btn primary" onClick={() => setStep("media")}>
                Next
              </button>
            </div>
          </>
        )}

        {step === "media" && (
          <>
            <Field
              label={
                kind === "layeredscreenshot"
                  ? "First screen (the builder grows the stack from here)"
                  : kind === "video"
                    ? "What fills the frame?"
                    : "What plays on the screen?"
              }
            >
              <div className="wizard-media-host">
                <MediaBrowser
                  slug={slug}
                  projectPath={projectPath}
                  kinds={kind === "video" ? ["video"] : undefined}
                  kindToggle={kind === "layeredscreenshot"}
                  kindDefault={kind === "layeredscreenshot" ? "image" : undefined}
                  globalToggle
                  refreshKey={mediaRefresh}
                  selectedRel={kind === "video" ? (media?.rel ?? null) : undefined}
                  onPick={pickWizardMedia}
                  cardMenu={mediaCardMenu({
                    slug,
                    primaryLabel: "Select",
                    onPrimary: pickWizardMedia,
                    onChanged: () => setMediaRefresh((n) => n + 1),
                    onError: setError,
                  })}
                />
              </div>
            </Field>
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setStep(kind === "device" ? "device" : "type")}
              >
                Back
              </button>
              {kind === "video" ? (
                <button type="button" className="btn" onClick={() => setStep("details")}>
                  Use the sample video
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setMedia(null);
                    setStep("details");
                  }}
                >
                  {kind === "layeredscreenshot" ? "Skip (empty stack)" : "Skip (Empty screen)"}
                </button>
              )}
            </div>
          </>
        )}

        {step === "details" && (
          <>
            <div className="wizard-scene-name">
              <span className="wizard-scene-name-label">Scene name</span>
              {editingName ? (
                <input
                  className="modal-input wizard-scene-name-input"
                  value={sceneName}
                  // biome-ignore lint/a11y/noAutofocus: entered by clicking the pencil, so it IS the focus target
                  autoFocus
                  aria-label="Scene name"
                  onChange={(e) => setNameOverride(e.target.value)}
                  onBlur={() => {
                    setEditingName(false);
                    setNameOverride((v) => (v?.trim() ? v : null));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      setNameOverride(null);
                      setEditingName(false);
                    }
                  }}
                />
              ) : (
                <>
                  <span className="wizard-scene-name-value">{sceneName}</span>
                  <button
                    type="button"
                    className="wizard-scene-name-edit"
                    aria-label="Edit scene name"
                    title="Edit scene name"
                    onClick={() => setEditingName(true)}
                  >
                    ✎
                  </button>
                </>
              )}
            </div>
            {kind === "video" && media && (
              <p className="modal-hint">
                Background video: {media.rel.replace(/^assets\//, "")} (the scene will follow its
                length)
              </p>
            )}
            {kind === "device" && (
              <>
                {media && (
                  <p className="modal-hint">
                    Screen media: {media.rel.replace(/^assets\//, "")} ({media.kind})
                    {media.kind === "video" && " — the scene will follow its length"}
                  </p>
                )}
                <Field label="Motion">
                  <ChipSelect options={MOTION_OPTIONS} value={motion} onChange={setMotion} />
                </Field>
                <Field label="Shadow">
                  <ChipSelect options={SHADOW_OPTIONS} value={shadow} onChange={setShadow} />
                </Field>
              </>
            )}
            {kind !== "video" && (
              <TextFieldRow
                label={isLockup ? "App name" : "Title"}
                value={title}
                placeholder={titlePlaceholder}
                onChange={setTitle}
                colour={{
                  value: titleColor ?? (isLockup ? theme.colors.muted : theme.colors.text),
                  defaultValue: isLockup ? theme.colors.muted : theme.colors.text,
                  onCommit: setTitleColor,
                  onReset: () => setTitleColor(null),
                }}
              />
            )}
            {(kind === "title" || isLockup) && (
              <TextFieldRow
                label={isLockup ? "Version" : "Subtitle"}
                value={subtitle}
                placeholder={isLockup ? "e.g. 3.1.5" : "Optional supporting line"}
                onChange={setSubtitle}
                colour={{
                  value: subtitleColor ?? (isLockup ? theme.colors.text : theme.colors.muted),
                  defaultValue: isLockup ? theme.colors.text : theme.colors.muted,
                  onCommit: setSubtitleColor,
                  onReset: () => setSubtitleColor(null),
                }}
              />
            )}
            {kind !== "video" && (
              <>
                <Field label="Background">
                  <ChipSelect
                    options={backgroundChipsForNew}
                    value={background}
                    onChange={(id) => {
                      setBackgroundTouched(true);
                      setBackground(id);
                    }}
                  />
                </Field>
                <Field label="Text motion">
                  <ChipSelect
                    options={TEXT_ANIMATION_CHIPS}
                    value={textAnim}
                    onChange={setTextAnim}
                  />
                </Field>
              </>
            )}
            <Field label="Where?">
              <ScenePicker
                scenes={scenes}
                thumbs={thumbs}
                mode="placement"
                value={placement}
                onChange={setPlacement}
              />
            </Field>
            <Field
              label={
                sessionRunning
                  ? "Anything else? (pastes a prompt for Claude)"
                  : "Anything else? (start Claude Code to use this)"
              }
            >
              <textarea
                className="modal-input wizard-textarea"
                disabled={!sessionRunning}
                placeholder="e.g. add a caption under the phone and fade everything in"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setStep(kind === "device" || kind === "video" ? "media" : "type")}
              >
                Back
              </button>
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!detailsReady}
                onClick={() => void submit()}
              >
                {busy ? "Creating…" : "Create scene"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Edit scene ────────────────────────────────────────────────────────────────

export function EditSceneWizard({
  slug,
  projectPath,
  scenes,
  thumbs,
  onSaved,
  onCancel,
}: {
  slug: string;
  projectPath: string;
  scenes: WizardSceneInfo[];
  thumbs: Record<string, string>;
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
  const [model, setModel] = useState<DeviceId>("iphone-17-pro");
  const [colour, setColour] = useState(DEVICE_CATALOG["iphone-17-pro"].defaultColour);
  const [media, setMedia] = useState<{ rel: string; kind: "video" | "image" } | null>(null);
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
  const pickEditMedia = (rel: string, meta: MediaMeta | null) => {
    setMedia({ rel, kind: meta?.kind === "image" ? "image" : "video" });
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
    setTitle(doc.text?.[sceneTitleKey(doc)] ?? "");
    // Seeded by type; an untouched chip leaves the sidecar's background exactly as-is so a custom colour/drift/image src is never clobbered by a wizard save.
    const bg = doc.background?.type ?? "default";
    setBackground(bg);
    setBackgroundSeed(bg);
    // Same rule for text motion: seeded by the in preset; an untouched chip never clobbers custom delivery/params written by the edit bar's panel.
    const ta = doc.textAnimation?.in ?? "default";
    setTextAnim(ta);
    setTextAnimSeed(ta);
    const d = doc.devices?.[0];
    if (d) {
      const validModel = (d.model in DEVICE_CATALOG ? d.model : "iphone-15-pro") as DeviceId;
      setModel(validModel);
      setColour(d.colour ?? DEVICE_CATALOG[validModel].defaultColour);
      setMedia(d.media ? { rel: d.media.src, kind: d.media.kind } : null);
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
      const next: SceneDoc = structuredClone(doc);
      next.name = name.trim() || undefined;
      const titleKey = sceneTitleKey(doc);
      next.text = { ...next.text, [titleKey]: title.trim() };
      // An empty legacy headline is dropped as before; an empty `title` stays so the panel field remains visible.
      if (!title.trim() && titleKey === "headline") delete next.text.headline;
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
        d.model = model;
        d.colour = colour;
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
        await resyncFollowMediaDuration(slug, scene.index, next, scene.durationMs).catch((e) => {
          console.warn("[wizard] duration re-sync failed:", e);
          resyncFailed = e;
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
                mode="select"
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
            <TextFieldRow label="Title" value={title} placeholder="No title" onChange={setTitle} />
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
