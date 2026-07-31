import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { SceneInsertTimeline } from "./SceneInsertTimeline";
import { HeaderIconField, TextFieldRow } from "./SceneTextFields";
import { backgroundOptions } from "./stageOptions";
import { defaultDraft, draftToSpec, TEXT_PRESET_CATALOG } from "./textAnimationOptions";
import { useEscapeClose } from "./useEscapeClose";
import { detectWindowRecording } from "./windowRecordingDetect";

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

type SceneKind =
  | "device"
  | "deviceonly"
  | "comparison"
  | "title"
  | "titleicon"
  | "appversion"
  | "layeredscreenshot"
  | "video"
  | "image"
  | "videowindow"
  | "overlaystart"
  | "overlayend"
  | "overlaypanel"
  | "blank";

const KIND_OPTIONS: { id: SceneKind; label: string; blurb: string }[] = [
  { id: "device", label: "Device + title", blurb: "A titled phone playing your media" },
  { id: "deviceonly", label: "Device only", blurb: "A centred phone with no title copy" },
  { id: "comparison", label: "Before / after", blurb: "Two phones comparing old and new" },
  { id: "title", label: "Title", blurb: "A title on the theme background" },
  { id: "titleicon", label: "Title + icon", blurb: "A title with an icon above it" },
  { id: "appversion", label: "App version", blurb: "Your app icon, name and version" },
  { id: "layeredscreenshot", label: "Layered screenshot", blurb: "A 3D stack of app screens" },
  { id: "video", label: "Video", blurb: "A video filling the whole frame" },
  { id: "image", label: "Image", blurb: "An image filling the whole frame" },
  { id: "videowindow", label: "Video window", blurb: "A floating screen recording" },
  { id: "overlaystart", label: "Cutout start", blurb: "Panel text beside a scene window" },
  { id: "overlayend", label: "Cutout end", blurb: "A scene window beside panel text" },
  { id: "overlaypanel", label: "Overlay title", blurb: "A full-panel title, no scene window" },
  { id: "blank", label: "Blank", blurb: "An empty scene to compose freely" },
];

/** Kinds whose panel body takes bullet lines at create time (same storage as the Edit text drill-in). */
const BULLET_KINDS: SceneKind[] = ["overlaystart", "overlayend", "overlaypanel"];

/** Kinds whose media step picks the window/backdrop video, starting on the bundled sample. */
const VIDEO_MEDIA_KINDS: SceneKind[] = ["video", "videowindow"];
/** Kinds with no text fields at all (the device stays centred). */
const NO_TEXT_KINDS: SceneKind[] = ["video", "image", "deviceonly"];
/** Kinds whose composition renders a subtitle on its own; blank/layeredscreenshot text rides TextFallback, which needs a title. */
const SUBTITLE_KINDS: SceneKind[] = [
  "device",
  "comparison",
  "title",
  "titleicon",
  "appversion",
  "videowindow",
  "overlaystart",
  "overlayend",
  "overlaypanel",
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

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="wizard-field">
      <span className="wizard-label">{label}</span>
      {children}
    </div>
  );
}

/** Split-square glyph for the comparison media steps: the filled half is the screen being picked (before = left, after = right, the scene's own layout). */
function SideChipGlyph({ side }: { side: "before" | "after" }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x={side === "before" ? 3.2 : 8}
        y="4.2"
        width="4.8"
        height="7.6"
        rx="1"
        fill="currentColor"
      />
    </svg>
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
            <span className="scene-card-title" title={s.name ?? s.id}>
              {s.name ?? s.id}
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
  onDone: (result: ScaffoldedScene) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [step, setStep] = useState<"type" | "device" | "media" | "mediaB" | "details">("type");
  const [kind, setKind] = useState<SceneKind>("device");
  const [model, setModel] = useState<DeviceId>("iphone-17-pro");
  const [colour, setColour] = useState(DEVICE_CATALOG["iphone-17-pro"].defaultColour);
  const [media, setMedia] = useState<{
    rel: string;
    kind: "video" | "image";
    meta: MediaMeta | null;
  } | null>(null);
  // The comparison kind's second (after) screen; every other kind leaves it null.
  const [mediaB, setMediaB] = useState<{
    rel: string;
    kind: "video" | "image";
    meta: MediaMeta | null;
  } | null>(null);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [bullets, setBullets] = useState("");
  const [titleColor, setTitleColor] = useState<string | null>(null);
  const [subtitleColor, setSubtitleColor] = useState<string | null>(null);
  const [headerIcon, setHeaderIcon] = useState("🚀");
  // Seeded after the scene under the playhead, the place a new scene usually belongs.
  const [placement, setPlacement] = useState(() => `after:${sceneIndexAtPlayhead(scenes)}`);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onCancel, !busy);
  const [error, setError] = useState<string | null>(null);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  // A file dropped on the window imports in the background; follow the app-wide broadcast so the open media grid shows it.
  useEffect(() => {
    const unlisten = listen("kookaburra://media-changed", () => setMediaRefresh((n) => n + 1));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  const pickWizardMedia = (rel: string, meta: MediaMeta | null) => {
    const fallback = kind === "layeredscreenshot" ? "image" : "video";
    const picked = { rel, kind: meta?.kind ?? fallback, meta };
    if (step === "mediaB") {
      setMediaB(picked);
      setStep("details");
      return;
    }
    setMedia(picked);
    setStep(kind === "comparison" ? "mediaB" : "details");
  };

  const position = useMemo(() => {
    if (placement === "start") return 0;
    if (placement === "end") return undefined;
    const after = Number(placement.replace(/^after:/, ""));
    return Number.isFinite(after) ? after + 1 : undefined;
  }, [placement]);

  // Kind + insertion position, e.g. "Title 3"; a pencil edit pins the name instead.
  const kindWord =
    {
      device: "Device",
      deviceonly: "Device",
      comparison: "Comparison",
      title: "Title",
      titleicon: "Title",
      appversion: "App version",
      layeredscreenshot: "Layered screenshot",
      video: "Video",
      image: "Image",
      videowindow: "Video window",
      overlaystart: "Overlay",
      overlayend: "Overlay",
      overlaypanel: "Panel",
      blank: "Blank",
    }[kind] ?? "Scene";
  const generatedName = `${kindWord} ${(position ?? scenes.length) + 1}`;
  const sceneName = nameOverride ?? generatedName;
  const titlePlaceholder =
    kind === "title" || kind === "titleicon"
      ? "e.g. Ship faster"
      : kind === "appversion"
        ? "e.g. Your App"
        : kind === "device"
          ? "Optional, sits above the device"
          : kind === "comparison"
            ? "Optional, sits above the pair"
            : kind.startsWith("overlay")
              ? "The panel headline"
              : "Optional";
  // The lockup's hero line is the version; its label is muted, the reverse of a title scene.
  const isLockup = kind === "appversion";

  const isDeviceKind = kind === "device" || kind === "deviceonly";
  const isComparison = kind === "comparison";
  const takesMedia =
    isDeviceKind ||
    isComparison ||
    kind === "layeredscreenshot" ||
    kind === "image" ||
    VIDEO_MEDIA_KINDS.includes(kind);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const finalName = sceneName.trim() || generatedName;
      const recording =
        kind === "videowindow" ? await detectWindowRecording(media?.meta ?? null) : null;
      const result = await invoke<ScaffoldedScene>("scaffold_scene", {
        slug,
        options: {
          kind,
          name: finalName,
          title: NO_TEXT_KINDS.includes(kind) ? null : title.trim() || null,
          subtitle: SUBTITLE_KINDS.includes(kind) ? subtitle.trim() || null : null,
          bullets: BULLET_KINDS.includes(kind) ? bullets.trim() || null : null,
          deviceModel: isDeviceKind ? model : null,
          colour: isDeviceKind ? colour : null,
          mediaRel: takesMedia ? (media?.rel ?? null) : null,
          mediaKind: takesMedia ? (media?.kind ?? null) : null,
          mediaRelB: isComparison ? (mediaB?.rel ?? null) : null,
          mediaKindB: isComparison ? (mediaB?.kind ?? null) : null,
          headerIcon: kind === "titleicon" ? headerIcon.trim() || null : null,
          recording,
          position: position ?? null,
        },
      });
      const textStyle: Record<string, string> = {};
      if (titleColor) textStyle.titleColor = titleColor;
      if (subtitleColor) textStyle.subtitleColor = subtitleColor;
      if (Object.keys(textStyle).length > 0) {
        // The scaffolder doesn't know text styling; patch the fresh sidecar via the same validated write path as the edit bar.
        try {
          const docFile = result.file.replace(/\.tsx$/, ".json");
          const text = await invoke<string | null>("read_scene_doc", { slug, file: docFile });
          const parsed = text ? parseSceneDoc(JSON.parse(text), `${slug}/${docFile}`) : undefined;
          if (parsed) {
            parsed.textStyle = textStyle;
            await writeSceneDoc(slug, result.file, parsed);
          }
        } catch (e) {
          // The scene already exists at this point; block the close so the user learns the colours didn't apply instead of silently shipping a half-configured scene.
          console.warn("[wizard] sidecar patch failed:", e);
          setError(
            `The scene was created, but its text colours couldn't be ` +
              `written: ${String(e)}. Close this and use Edit scene to apply them.`,
          );
          setBusy(false);
          return;
        }
      }
      onDone(result);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const detailsReady = !busy;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        className={`modal wizard-wide${step === "media" || step === "mediaB" ? " wizard-media-wide" : ""}${
          step === "type" ? " wizard-kind-wide" : ""
        }${step === "details" ? " wizard-place-wide" : ""}`}
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
                  // The video kinds' media step starts on the sample so "Use the sample video" is a one-click accept.
                  if (VIDEO_MEDIA_KINDS.includes(kind) && media?.kind !== "video") {
                    setMedia({ rel: SAMPLE_LAPTOP_VIDEO, kind: "video", meta: null });
                  }
                  setStep(
                    isDeviceKind || isComparison
                      ? "device"
                      : kind === "layeredscreenshot" ||
                          kind === "image" ||
                          VIDEO_MEDIA_KINDS.includes(kind)
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

        {(step === "media" || step === "mediaB") && (
          <>
            <Field
              label={
                isComparison ? (
                  <span className="wizard-side-label">
                    <span className={`wizard-side-chip${step === "mediaB" ? " after" : ""}`}>
                      <SideChipGlyph side={step === "mediaB" ? "after" : "before"} />
                      {step === "mediaB" ? "After" : "Before"}
                    </span>
                    {step === "mediaB"
                      ? "What plays on the After screen?"
                      : "What plays on the Before screen?"}
                  </span>
                ) : kind === "layeredscreenshot" ? (
                  "First screen (the builder grows the stack from here)"
                ) : kind === "video" ? (
                  "What fills the frame?"
                ) : kind === "image" ? (
                  "What image fills the frame?"
                ) : kind === "videowindow" ? (
                  "What plays in the window?"
                ) : (
                  "What plays on the screen?"
                )
              }
            >
              <div className="wizard-media-host">
                <MediaBrowser
                  slug={slug}
                  projectPath={projectPath}
                  kinds={
                    VIDEO_MEDIA_KINDS.includes(kind)
                      ? ["video"]
                      : kind === "image"
                        ? ["image"]
                        : undefined
                  }
                  kindToggle={kind === "layeredscreenshot"}
                  kindDefault={kind === "layeredscreenshot" ? "image" : undefined}
                  globalToggle
                  refreshKey={mediaRefresh}
                  selectedRel={
                    isComparison
                      ? step === "mediaB"
                        ? (mediaB?.rel ?? null)
                        : (media?.rel ?? null)
                      : VIDEO_MEDIA_KINDS.includes(kind) || kind === "image"
                        ? (media?.rel ?? null)
                        : undefined
                  }
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
                onClick={() =>
                  setStep(
                    step === "mediaB" ? "media" : isDeviceKind || isComparison ? "device" : "type",
                  )
                }
              >
                Back
              </button>
              {VIDEO_MEDIA_KINDS.includes(kind) ? (
                <button type="button" className="btn" onClick={() => setStep("details")}>
                  Use the sample video
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (step === "mediaB") {
                      setMediaB(null);
                      setStep("details");
                      return;
                    }
                    setMedia(null);
                    setStep(isComparison ? "mediaB" : "details");
                  }}
                >
                  {kind === "layeredscreenshot"
                    ? "Skip (empty stack)"
                    : kind === "image"
                      ? "Skip (Theme background)"
                      : "Skip (Empty screen)"}
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
            {VIDEO_MEDIA_KINDS.includes(kind) && media && (
              <p className="modal-hint">
                {kind === "video" ? "Background video" : "Window video"}:{" "}
                {media.rel.replace(/^assets\//, "")} (the scene will follow its length)
              </p>
            )}
            {isDeviceKind && media && (
              <p className="modal-hint">
                Screen media: {media.rel.replace(/^assets\//, "")} ({media.kind})
                {media.kind === "video" && " — the scene will follow its length"}
              </p>
            )}
            {isComparison && (media || mediaB) && (
              <p className="modal-hint">
                Before: {media ? media.rel.replace(/^assets\//, "") : "empty screen"}
                {" · "}After: {mediaB ? mediaB.rel.replace(/^assets\//, "") : "empty screen"}
                {(media?.kind === "video" || mediaB?.kind === "video") &&
                  " — the scene will follow the longer video"}
              </p>
            )}
            {!NO_TEXT_KINDS.includes(kind) && (
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
            {SUBTITLE_KINDS.includes(kind) && (
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
            {kind === "titleicon" && (
              <HeaderIconField
                value={headerIcon}
                selected={headerIcon}
                hint="Drawn above the headline. An emoji, or a project image path."
                slug={slug}
                projectPath={projectPath}
                onChange={setHeaderIcon}
                onPick={setHeaderIcon}
              />
            )}
            {BULLET_KINDS.includes(kind) && (
              <TextFieldRow
                label="Bullets"
                value={bullets}
                placeholder="one bullet per line"
                onChange={setBullets}
              />
            )}
            <Field label="Where?">
              <SceneInsertTimeline
                scenes={scenes}
                thumbs={thumbs}
                value={placement}
                onChange={setPlacement}
              />
            </Field>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setStep(
                    isDeviceKind || kind === "layeredscreenshot" || VIDEO_MEDIA_KINDS.includes(kind)
                      ? "media"
                      : "type",
                  )
                }
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
