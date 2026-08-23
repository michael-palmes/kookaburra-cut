import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { useImageEditStore } from "../../engine/imageEditStore";
import type {
  SceneDoc,
  SceneDocMediaSpec,
  SceneMediaHost,
  SceneMediaKind,
  SceneMediaMotionPreset,
} from "../../engine/sceneDocSchema";
import { editSceneDocMedia, resolveSceneDocMedia } from "../../engine/sceneMedia";
import { resolveVideoWindowRadius } from "../../engine/sceneVideoWindow";
import {
  OVERLAY_MEDIA_SIZE_RANGE,
  STAGE_MEDIA_SIZE_RANGE,
} from "../../toolkit/media/imageGizmoCommit";
import { ColourPicker } from "../colour/ColourPicker";
import { DebouncedRange } from "../TextAnimationPicker";
import { MediaSourceGroup } from "./MediaSourceGroup";
import { duplicateSceneMedia, removeSceneMedia } from "./mediaEditorModel";
import {
  DrillBack,
  DrillGroup,
  DrillHeaderAction,
  GizmoModeIcon,
  InspectorSliderRow,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
  ToggleRow,
} from "./rows";

/** The one media drill: every entry in `doc.media`, still or video, edited through the same shell. Per-kind differences are data (the motion catalogue, the Video group, the Stage cast-shadow toggle), not a second component, and every write goes through `editSceneDocMedia` so the first edit of a legacy doc promotes it. */

export type MediaDocPatch = (next: SceneDoc) => void;
export type MediaPatchDoc = (
  patch: MediaDocPatch,
  opts?: { history?: string | false },
) => Promise<void>;

export interface MediaDrillInProps {
  doc: SceneDoc;
  mediaId: string;
  sourcePreviewUrl?: string;
  /** The source's pixel aspect, which shapes the thumbnail; omitted until the probe lands. */
  sourceAspectRatio?: number;
  /** The source's dimensions (and duration for a clip); falls back to the kind. */
  sourceDetail?: string;
  overlayAvailable: boolean;
  sourceButtonRef?: Ref<HTMLButtonElement>;
  sourceDisabled?: boolean;
  settingsDisabled?: boolean;
  duplicateDisabled?: boolean;
  removeDisabled?: boolean;
  backLabel?: string;
  onBack: () => void;
  onSelectMedia: (mediaId: string) => void;
  onChangeSource: (mediaId: string) => void;
  /** Opens the rendered-media editor for this entry; omitted where there is no entry to re-point yet (the inherited-decoration shell). */
  onEditSource?: (mediaId: string) => void;
  onMediaRemoved?: () => void;
  /** Override every entity write, for example to atomically promote a virtual legacy decoration. */
  mutateMedia?: (mutate: MediaMutation, opts: MediaMutationOptions) => Promise<void>;
  /** Override the first-class duplicate path when the displayed entry is virtual. */
  onDuplicate?: () => void;
  /** Override the first-class remove path when the displayed entry is virtual. */
  onRemove?: () => void;
  patchDoc: MediaPatchDoc;
  commitFromBaseline: (baseline: SceneDoc, patch: MediaDocPatch) => Promise<void>;
  notice?: ReactNode;
}

export type MediaMutation = (entry: SceneDocMediaSpec) => void;

export interface MediaMutationOptions {
  history: string | false;
  baseline?: SceneDoc;
}

function MediaHostIcon({ host }: { host: SceneMediaHost }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {host === "stage" ? (
        <>
          <path d="m10 3.2 6 3.3v7L10 16.8l-6-3.3v-7z" />
          <path d="m4 6.5 6 3.4 6-3.4M10 9.9v6.9" />
        </>
      ) : host === "window" ? (
        <>
          <rect x="2.5" y="5.5" width="11" height="9" rx="1.5" />
          <path d="M2.5 8.4h11" />
          <path d="M16.5 4.5v9" />
        </>
      ) : (
        <>
          <rect x="3.5" y="4" width="13" height="12" rx="1.5" />
          <circle cx="7" cy="7.5" r="1" />
          <path d="m5.5 13 3.2-3.2 2.1 2.1 1.5-1.5 2.2 2.6" />
        </>
      )}
    </svg>
  );
}

const MEDIA_HOST_OPTIONS: SegmentedOption<SceneMediaHost>[] = [
  {
    value: "stage",
    label: "Stage",
    title: "A 3D card among devices and objects",
    icon: <MediaHostIcon host="stage" />,
  },
  {
    value: "overlay",
    label: "Overlay",
    title: "Frame-relative editorial artwork",
    icon: <MediaHostIcon host="overlay" />,
  },
  {
    value: "window",
    label: "Window",
    title: "A window floating in the scene's world",
    icon: <MediaHostIcon host="window" />,
  },
];

/** The Window host is the video window's own home, so it is offered to clips alone; a still asking for it would render nowhere. */
function mediaHostOptions(kind: SceneMediaKind): SegmentedOption<SceneMediaHost>[] {
  return kind === "video"
    ? MEDIA_HOST_OPTIONS
    : MEDIA_HOST_OPTIONS.filter((option) => option.value !== "window");
}

const GIZMO_OPTIONS: SegmentedOption<"translate" | "rotate" | "scale">[] = [
  { value: "translate", label: "Move", icon: <GizmoModeIcon mode="translate" /> },
  { value: "rotate", label: "Rotate", icon: <GizmoModeIcon mode="rotate" /> },
  { value: "scale", label: "Scale", icon: <GizmoModeIcon mode="scale" /> },
];

const REMOVE_CONFIRMATION_MS = 3_000;

export function armMediaRemoveConfirmation(onDisarm: () => void): () => void {
  const timeout = setTimeout(onDisarm, REMOVE_CONFIRMATION_MS);
  return () => clearTimeout(timeout);
}

function MediaControlIcon({ type }: { type: "x" | "y" | "depth" | "size" | "roll" }) {
  const glyph = {
    x: <path d="M2.6 8h10.8M4.8 5.8 2.6 8l2.2 2.2M11.2 5.8 13.4 8l-2.2 2.2" />,
    y: <path d="M8 2.6v10.8M5.8 4.8 8 2.6l2.2 2.2M5.8 11.2 8 13.4l2.2-2.2" />,
    depth: (
      <>
        <rect x="8.2" y="2.4" width="5.4" height="5.4" rx="1" />
        <rect x="2.4" y="8.2" width="5.4" height="5.4" rx="1" />
        <path d="M8.2 7.8 7.8 8.2" />
      </>
    ),
    size: <path d="M3 9.6V13h3.4M13 6.4V3H9.6M3.2 12.8 7.4 8.6M12.8 3.2 8.6 7.4" />,
    roll: (
      <>
        <path d="M13.4 8A5.4 5.4 0 114.9 3.6" />
        <path d="M4.2 1.8v3.6h3.6" />
      </>
    ),
  }[type];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function NavigationIcon({ direction }: { direction: "previous" | "next" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "previous" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} />
    </svg>
  );
}

/** Motion pictograms shared by both kinds: turn spins, float bobs on Y, drift sways in rotation, tilt swings flush from a tilted start, push grows from 90%. */
function MediaMotionIcon({ preset }: { preset: SceneMediaMotionPreset }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {preset === "none" ? (
        <rect x="4.5" y="5.5" width="11" height="9" rx="1.5" />
      ) : preset === "turntable" ? (
        <>
          <path d="M4 9.8c0-2.8 2.7-5 6-5 2.6 0 4.8 1.3 5.6 3.2" />
          <path d="m13.3 6.8 2.5 1.5.7-2.8" />
          <path d="M16 10.2c0 2.8-2.7 5-6 5-2.6 0-4.8-1.3-5.6-3.2" />
        </>
      ) : preset === "float" ? (
        <>
          <rect x="4.5" y="6.5" width="11" height="7" rx="1.5" />
          <path d="M10 2.5v2M10 15.5v2" />
        </>
      ) : preset === "drift" ? (
        <rect x="4.5" y="6.5" width="11" height="7" rx="1.5" transform="rotate(-9 10 10)" />
      ) : preset === "tilt-reveal" ? (
        <path d="M5 4.5l10.5 2v7L5 15.5z" />
      ) : (
        <>
          <rect x="3.5" y="5" width="13" height="10" rx="1.5" />
          <rect x="6.5" y="7.5" width="7" height="5" rx="1" />
        </>
      )}
    </svg>
  );
}

const MOTION_LABELS: Record<SceneMediaMotionPreset, { label: string; title: string }> = {
  none: { label: "None", title: "No motion" },
  turntable: { label: "Turn", title: "Slow turntable" },
  float: { label: "Float", title: "A gentle vertical bob" },
  drift: { label: "Drift", title: "A slow rotational sway" },
  "tilt-reveal": { label: "Tilt", title: "Swings flush from a tilted start" },
  "push-in": { label: "Push", title: "Eases up from 90% to full size" },
};

/** The presets each kind ever had: a still turns, a clip drifts. Offering the other one would fake motion the sampler leaves inert. */
const MOTION_PRESETS: Record<SceneMediaKind, SceneMediaMotionPreset[]> = {
  image: ["none", "turntable", "float", "tilt-reveal", "push-in"],
  video: ["none", "float", "drift", "tilt-reveal", "push-in"],
};

function motionOptions(kind: SceneMediaKind): SegmentedOption<SceneMediaMotionPreset>[] {
  return MOTION_PRESETS[kind].map((preset) => ({
    value: preset,
    label: MOTION_LABELS[preset].label,
    title: MOTION_LABELS[preset].title,
    icon: <MediaMotionIcon preset={preset} />,
  }));
}

/** No chrome at all, the four radius presets, and (never offered, only reflected) a hand-set radius. */
type CornerPreset = "none" | "subtle" | "macos" | "rounded";
type CornerChoice = CornerPreset | "custom";

/** Corner-preset glyphs: one magnified top-left corner drawn at the preset's real rounding; "none" is the chrome-free plane. */
function MediaCornerIcon({ id }: { id: CornerPreset }) {
  if (id === "none") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="4.5" y="4.5" width="11" height="11" />
        <path d="M4.5 15.5 15.5 4.5" opacity="0.5" />
      </svg>
    );
  }
  const r = { subtle: 1.5, macos: 3.5, rounded: 7 }[id];
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d={`M16.5 4.5H${4.5 + r}A${r} ${r} 0 0 0 4.5 ${4.5 + r}V16.5`} />
    </svg>
  );
}

const CORNER_LABELS: Record<CornerPreset, { label: string; title: string }> = {
  none: { label: "None", title: "A bare plane, no window chrome" },
  subtle: { label: "Subtle", title: "A whisper of rounding" },
  macos: { label: "macOS", title: "The macOS window look" },
  rounded: { label: "Rounded", title: "Boldly rounded corners" },
};

const CORNER_OPTIONS: SegmentedOption<CornerChoice>[] = (
  Object.keys(CORNER_LABELS) as CornerPreset[]
).map((id) => ({
  value: id,
  label: CORNER_LABELS[id].label,
  title: CORNER_LABELS[id].title,
  icon: <MediaCornerIcon id={id} />,
}));

const DEFAULT_WINDOW_BORDER = {
  enabled: true,
  color: "#ffffff",
  width: 0.0035,
  opacity: 0.12,
} as const;

const DEFAULT_WINDOW_SHADOW = {
  opacity: 0.32,
  blur: 0.14,
  offset: [0, -0.05] as [number, number],
};

function mediaFileName(src: string): string {
  return src.split("/").filter(Boolean).at(-1) ?? src;
}

function cornerChoice(entry: SceneDocMediaSpec): CornerChoice {
  if (!entry.window) return "none";
  // "sharp" stays valid in the schema but has no segment; it reads as custom (radius 0 on the slider).
  if (typeof entry.window.radius !== "string" || entry.window.radius === "sharp") return "custom";
  return entry.window.radius;
}

function mutateDocMedia(next: SceneDoc, mediaId: string, mutate: MediaMutation) {
  const media = resolveSceneDocMedia(next);
  const entry = media.find((candidate) => candidate.id === mediaId);
  if (!entry) return;
  mutate(entry);
  editSceneDocMedia(next, () => media);
}

export async function duplicateFirstClassMedia(
  patchDoc: MediaPatchDoc,
  mediaId: string,
  onSelectMedia: (mediaId: string) => void,
): Promise<void> {
  let duplicateId: string | null = null;
  await patchDoc(
    (next) => {
      duplicateId = duplicateSceneMedia(next, mediaId);
    },
    { history: "duplicate media" },
  );
  if (duplicateId) onSelectMedia(duplicateId);
}

export async function removeFirstClassMedia(
  patchDoc: MediaPatchDoc,
  mediaId: string,
  onMediaRemoved?: () => void,
): Promise<void> {
  await patchDoc((next) => removeSceneMedia(next, mediaId), { history: "remove media" });
  onMediaRemoved?.();
}

export function MediaDrillIn({
  doc,
  mediaId,
  sourcePreviewUrl,
  sourceAspectRatio,
  sourceDetail,
  overlayAvailable,
  sourceButtonRef,
  sourceDisabled = false,
  settingsDisabled = false,
  duplicateDisabled = false,
  removeDisabled = false,
  backLabel = "Scene",
  onBack,
  onSelectMedia,
  onChangeSource,
  onEditSource,
  onMediaRemoved,
  mutateMedia,
  onDuplicate,
  onRemove,
  patchDoc,
  commitFromBaseline,
  notice,
}: MediaDrillInProps) {
  const dragBaseline = useRef<SceneDoc | null>(null);
  const pendingGesture = useRef<(() => void) | null>(null);
  const [removeConfirmMediaId, setRemoveConfirmMediaId] = useState<string | null>(null);
  const gizmoMode = useImageEditStore((state) => state.gizmoMode);
  const media = resolveSceneDocMedia(doc);
  const mediaIndex = media.findIndex((candidate) => candidate.id === mediaId);
  const entry = media[mediaIndex];

  useEffect(
    () => () => {
      const flush = pendingGesture.current;
      pendingGesture.current = null;
      dragBaseline.current = null;
      flush?.();
    },
    [],
  );

  useEffect(() => {
    if (removeConfirmMediaId == null) return;
    return armMediaRemoveConfirmation(() => setRemoveConfirmMediaId(null));
  }, [removeConfirmMediaId]);

  if (!entry) {
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} title="Media" onClick={onBack} />
        <div className="inspector-drill-body">
          <p className="modal-hint">This media is no longer in the scene.</p>
        </div>
      </div>
    );
  }

  const kindLabel = entry.kind === "video" ? "Video" : "Image";

  const patchMedia = (mutate: MediaMutation, history: string, preview = false) => {
    if (settingsDisabled) return;
    if (preview) {
      if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
      const baseline = dragBaseline.current;
      if (mutateMedia) {
        pendingGesture.current = () => {
          void mutateMedia(mutate, { history, baseline });
        };
        void mutateMedia(mutate, { history: false });
      } else {
        const patch = (next: SceneDoc) => mutateDocMedia(next, entry.id, mutate);
        pendingGesture.current = () => {
          void commitFromBaseline(baseline, patch);
        };
        void patchDoc(patch, { history: false });
      }
      return;
    }

    const baseline = dragBaseline.current;
    pendingGesture.current = null;
    dragBaseline.current = null;
    if (mutateMedia) {
      void mutateMedia(mutate, baseline ? { history, baseline } : { history });
      return;
    }
    const patch = (next: SceneDoc) => mutateDocMedia(next, entry.id, mutate);
    if (baseline) void commitFromBaseline(baseline, patch);
    else void patchDoc(patch, { history });
  };
  const chooseHost = (host: SceneMediaHost) => {
    if (settingsDisabled || host === entry.host || (host === "overlay" && !overlayAvailable))
      return;
    patchMedia((candidate) => (candidate.host = host), `move media to ${host}`);
  };
  const chooseCorners = (choice: CornerChoice) => {
    if (choice === "custom") return;
    patchMedia((candidate) => {
      if (choice === "none") {
        delete candidate.window;
        return;
      }
      candidate.window = { ...(candidate.window ?? {}), radius: choice };
    }, "media corners");
  };
  const patchWindow = (
    mutate: (window: NonNullable<SceneDocMediaSpec["window"]>) => void,
    history: string,
    preview = false,
  ) =>
    patchMedia(
      (candidate) => {
        candidate.window ??= { radius: "macos" };
        mutate(candidate.window);
      },
      history,
      preview,
    );
  const duplicate = () => {
    if (duplicateDisabled) return;
    if (onDuplicate) {
      onDuplicate();
      return;
    }
    void duplicateFirstClassMedia(patchDoc, entry.id, onSelectMedia);
  };
  const remove = () => {
    if (removeDisabled) return;
    if (removeConfirmMediaId !== entry.id) {
      setRemoveConfirmMediaId(entry.id);
      return;
    }
    setRemoveConfirmMediaId(null);
    if (onRemove) {
      onRemove();
      return;
    }
    void removeFirstClassMedia(patchDoc, entry.id, onMediaRemoved);
  };

  const stage = entry.stage;
  const overlay = entry.overlay;
  const fileName = mediaFileName(entry.src);
  const windowed = entry.window !== undefined;
  // The ranges follow the sizing rule each host renders by: a Window-hosted entry fits inside its size box, a frame-layer one's size IS its width, and any clip on the Stage keeps the window family's wider world-unit range.
  const stageSizeRange =
    entry.kind === "video" ? STAGE_MEDIA_SIZE_RANGE.window : STAGE_MEDIA_SIZE_RANGE.image;
  const overlaySizeRange =
    entry.host === "window" ? OVERLAY_MEDIA_SIZE_RANGE.window : OVERLAY_MEDIA_SIZE_RANGE.image;
  const border = entry.window?.border ?? DEFAULT_WINDOW_BORDER;
  const shadow = entry.window?.shadow ?? DEFAULT_WINDOW_SHADOW;
  const castShadowAvailable = entry.kind === "image" && entry.host === "stage";

  return (
    <div className="inspector-drill media-drill">
      <DrillBack
        label={backLabel}
        title={kindLabel}
        onClick={onBack}
        actions={
          <>
            <DrillHeaderAction
              kind="duplicate"
              label="Duplicate media"
              disabled={duplicateDisabled}
              onClick={duplicate}
            />
            <DrillHeaderAction
              kind="remove"
              label={removeConfirmMediaId === entry.id ? "Confirm remove media" : "Remove media"}
              disabled={removeDisabled}
              armed={removeConfirmMediaId === entry.id}
              onClick={remove}
            />
          </>
        }
      />
      <div className="inspector-scene-head media-drill-identity">
        <div className="inspector-scene-preview">
          {sourcePreviewUrl && <img src={sourcePreviewUrl} alt="" draggable={false} />}
        </div>
        <div className="inspector-scene-id">
          <div className="inspector-scene-title" title={fileName}>
            {fileName}
          </div>
          <div className="inspector-scene-sub">
            {kindLabel} · {mediaIndex + 1} of {media.length}
          </div>
        </div>
        <div className="wizard-presets">
          <button
            type="button"
            className="chip"
            aria-label="Previous media"
            title="Previous media"
            disabled={mediaIndex <= 0}
            onClick={() => onSelectMedia(media[mediaIndex - 1].id)}
          >
            <NavigationIcon direction="previous" />
          </button>
          <button
            type="button"
            className="chip"
            aria-label="Next media"
            title="Next media"
            disabled={mediaIndex >= media.length - 1}
            onClick={() => onSelectMedia(media[mediaIndex + 1].id)}
          >
            <NavigationIcon direction="next" />
          </button>
        </div>
      </div>

      <div className="inspector-drill-body inspector-section-body media-drill-body">
        {notice != null && <div className="inspector-stub-note media-drill-notice">{notice}</div>}
        <MediaSourceGroup
          label={kindLabel}
          previewUrl={sourcePreviewUrl}
          aspectRatio={sourceAspectRatio}
          name={fileName}
          detail={sourceDetail ?? kindLabel}
          disabled={sourceDisabled}
          changeButtonRef={sourceButtonRef}
          onChange={() => onChangeSource(entry.id)}
          onEdit={onEditSource ? () => onEditSource(entry.id) : undefined}
        />

        <fieldset className="media-settings-fieldset" disabled={settingsDisabled}>
          <legend className="visually-hidden">Media settings</legend>
          <DrillGroup label="Host">
            <SegmentedRow
              className="subtabs-compact"
              ariaLabel="Media host"
              options={mediaHostOptions(entry.kind).map((option) =>
                option.value === "overlay"
                  ? {
                      ...option,
                      disabled: !overlayAvailable,
                      title: overlayAvailable
                        ? option.title
                        : "Add an Overlay to this scene before moving media there",
                    }
                  : option,
              )}
              value={entry.host}
              disabled={settingsDisabled}
              onChange={chooseHost}
            />
            {!overlayAvailable && (
              <span className="drill-group-hint">
                Add an Overlay to this scene before moving media there.
              </span>
            )}
          </DrillGroup>

          {entry.host === "stage" ? (
            <DrillGroup label="Transform">
              <SegmentedRow
                ariaLabel="Media transform"
                options={GIZMO_OPTIONS}
                value={gizmoMode}
                onChange={(mode) => {
                  if (!settingsDisabled) useImageEditStore.getState().setGizmoMode(mode);
                }}
              />
              {gizmoMode === "translate" && (
                <>
                  <InspectorSliderRow
                    icon={<MediaControlIcon type="x" />}
                    label="X"
                    value={stage.position[0]}
                    min={-4}
                    max={4}
                    step={0.01}
                    onInput={(value) =>
                      patchMedia(
                        (candidate) => {
                          candidate.stage.position = [
                            value,
                            candidate.stage.position[1],
                            candidate.stage.position[2],
                          ];
                        },
                        "media position",
                        true,
                      )
                    }
                    onCommit={(value) =>
                      patchMedia((candidate) => {
                        candidate.stage.position = [
                          value,
                          candidate.stage.position[1],
                          candidate.stage.position[2],
                        ];
                      }, "media position")
                    }
                  />
                  <InspectorSliderRow
                    icon={<MediaControlIcon type="y" />}
                    label="Y"
                    value={stage.position[1]}
                    min={-3}
                    max={3}
                    step={0.01}
                    onInput={(value) =>
                      patchMedia(
                        (candidate) => {
                          candidate.stage.position = [
                            candidate.stage.position[0],
                            value,
                            candidate.stage.position[2],
                          ];
                        },
                        "media position",
                        true,
                      )
                    }
                    onCommit={(value) =>
                      patchMedia((candidate) => {
                        candidate.stage.position = [
                          candidate.stage.position[0],
                          value,
                          candidate.stage.position[2],
                        ];
                      }, "media position")
                    }
                  />
                  <InspectorSliderRow
                    icon={<MediaControlIcon type="depth" />}
                    label="Depth"
                    value={stage.position[2]}
                    min={-4}
                    max={4}
                    step={0.01}
                    onInput={(value) =>
                      patchMedia(
                        (candidate) => {
                          candidate.stage.position = [
                            candidate.stage.position[0],
                            candidate.stage.position[1],
                            value,
                          ];
                        },
                        "media depth",
                        true,
                      )
                    }
                    onCommit={(value) =>
                      patchMedia((candidate) => {
                        candidate.stage.position = [
                          candidate.stage.position[0],
                          candidate.stage.position[1],
                          value,
                        ];
                      }, "media depth")
                    }
                  />
                </>
              )}
              {gizmoMode === "rotate" && (
                <div className="inspector-pose-grid">
                  {(["X °", "Y °", "Z °"] as const).map((label, axis) => (
                    <NumberField
                      key={label}
                      label={label}
                      value={stage.rotationDeg[axis]}
                      decimals={1}
                      min={-180}
                      max={180}
                      step={1}
                      onCommit={(value) =>
                        patchMedia((candidate) => {
                          const rotation: [number, number, number] = [
                            ...candidate.stage.rotationDeg,
                          ];
                          rotation[axis] = value;
                          candidate.stage.rotationDeg = rotation;
                        }, "media rotation")
                      }
                    />
                  ))}
                </div>
              )}
              {gizmoMode === "scale" && (
                <InspectorSliderRow
                  icon={<MediaControlIcon type="size" />}
                  label="Size"
                  value={stage.size}
                  min={stageSizeRange[0]}
                  max={stageSizeRange[1]}
                  step={0.01}
                  onInput={(value) =>
                    patchMedia(
                      (candidate) => {
                        candidate.stage.size = value;
                      },
                      "media size",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchMedia((candidate) => {
                      candidate.stage.size = value;
                    }, "media size")
                  }
                />
              )}
            </DrillGroup>
          ) : (
            <>
              <DrillGroup label="Placement">
                <InspectorSliderRow
                  icon={<MediaControlIcon type="x" />}
                  label="X"
                  value={overlay.position[0]}
                  min={-1}
                  max={1}
                  step={0.01}
                  onInput={(value) =>
                    patchMedia(
                      (candidate) => {
                        candidate.overlay.position = [value, candidate.overlay.position[1]];
                      },
                      "media position",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchMedia((candidate) => {
                      candidate.overlay.position = [value, candidate.overlay.position[1]];
                    }, "media position")
                  }
                />
                <InspectorSliderRow
                  icon={<MediaControlIcon type="y" />}
                  label="Y"
                  value={overlay.position[1]}
                  min={-1}
                  max={1}
                  step={0.01}
                  onInput={(value) =>
                    patchMedia(
                      (candidate) => {
                        candidate.overlay.position = [candidate.overlay.position[0], value];
                      },
                      "media position",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchMedia((candidate) => {
                      candidate.overlay.position = [candidate.overlay.position[0], value];
                    }, "media position")
                  }
                />
                <InspectorSliderRow
                  icon={<MediaControlIcon type="size" />}
                  label="Size"
                  value={overlay.size}
                  min={overlaySizeRange[0]}
                  max={overlaySizeRange[1]}
                  step={0.01}
                  onInput={(value) =>
                    patchMedia(
                      (candidate) => {
                        candidate.overlay.size = value;
                      },
                      "media size",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchMedia((candidate) => {
                      candidate.overlay.size = value;
                    }, "media size")
                  }
                />
                <InspectorSliderRow
                  icon={<MediaControlIcon type="roll" />}
                  label="Roll"
                  value={overlay.rotationDeg}
                  min={-180}
                  max={180}
                  step={1}
                  onInput={(value) =>
                    patchMedia(
                      (candidate) => {
                        candidate.overlay.rotationDeg = value;
                      },
                      "media roll",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchMedia((candidate) => {
                      candidate.overlay.rotationDeg = value;
                    }, "media roll")
                  }
                />
              </DrillGroup>
              {/* Crop and layer belong to the frame layer; a Window-hosted entry draws in the world, where neither applies. */}
              {entry.host === "overlay" && (
                <DrillGroup label="Appearance">
                  <ToggleRow
                    label="Circle crop"
                    description="Crop the source to a circle."
                    checked={overlay.shape === "circle"}
                    onChange={(checked) =>
                      patchMedia((candidate) => {
                        candidate.overlay.shape = checked ? "circle" : "none";
                      }, "media crop")
                    }
                  />
                  <SegmentedRow
                    ariaLabel="Media layer"
                    options={[
                      { value: "above" as const, label: "Above" },
                      { value: "below" as const, label: "Below" },
                    ]}
                    value={overlay.layer}
                    onChange={(layer) =>
                      patchMedia((candidate) => {
                        candidate.overlay.layer = layer;
                      }, "media layer")
                    }
                  />
                </DrillGroup>
              )}
            </>
          )}

          <DrillGroup label="Corners">
            <SegmentedRow
              className="subtabs-compact"
              ariaLabel="Corner style"
              options={CORNER_OPTIONS}
              value={cornerChoice(entry)}
              onChange={chooseCorners}
            />
            {windowed && (
              <>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Corner radius</span>
                  <DebouncedRange
                    value={resolveVideoWindowRadius(entry.window?.radius)}
                    min={0}
                    max={0.2}
                    step={0.005}
                    label="Corner radius"
                    disabled={settingsDisabled}
                    onInput={(value) =>
                      patchWindow(
                        (window) => {
                          window.radius = { custom: value };
                        },
                        "media corner radius",
                        true,
                      )
                    }
                    onCommit={(value) =>
                      patchWindow((window) => {
                        window.radius = { custom: value };
                      }, "media corner radius")
                    }
                  />
                </div>
                <ToggleRow
                  label="Window recording"
                  description="Crops the margins and shadow baked into a macOS window capture."
                  checked={entry.window?.recording === true}
                  onChange={(on) =>
                    patchWindow((window) => {
                      window.recording = on;
                      // An early branch-only build stored the mode on the radius; normalise it away on first touch.
                      if ((window.radius as unknown) === "recording") window.radius = "macos";
                    }, "window recording")
                  }
                />
              </>
            )}
          </DrillGroup>

          {windowed && (
            <DrillGroup label="Border">
              <ToggleRow
                label="Show border"
                description="A thin edge line around the window."
                checked={border.enabled}
                onChange={(on) =>
                  patchWindow((window) => {
                    window.border = { ...border, enabled: on };
                  }, "window border")
                }
              />
              {border.enabled && (
                <>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Colour</span>
                    <ColourPicker
                      value={border.color}
                      label="Border colour"
                      onCommit={(hex) =>
                        patchWindow((window) => {
                          window.border = { ...border, color: hex };
                        }, "window border")
                      }
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Width</span>
                    <DebouncedRange
                      value={border.width}
                      min={0}
                      max={0.02}
                      step={0.0005}
                      label="Border width"
                      disabled={settingsDisabled}
                      onInput={(value) =>
                        patchWindow(
                          (window) => {
                            window.border = { ...border, width: value };
                          },
                          "window border",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchWindow((window) => {
                          window.border = { ...border, width: value };
                        }, "window border")
                      }
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Strength</span>
                    <DebouncedRange
                      value={border.opacity}
                      min={0}
                      max={1}
                      step={0.02}
                      label="Border strength"
                      disabled={settingsDisabled}
                      onInput={(value) =>
                        patchWindow(
                          (window) => {
                            window.border = { ...border, opacity: value };
                          },
                          "window border",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchWindow((window) => {
                          window.border = { ...border, opacity: value };
                        }, "window border")
                      }
                    />
                  </div>
                </>
              )}
            </DrillGroup>
          )}

          {(windowed || castShadowAvailable) && (
            <DrillGroup label="Shadow">
              {castShadowAvailable && (
                <ToggleRow
                  label="Cast shadow"
                  description="Cast the media silhouette onto stage surfaces."
                  checked={entry.castShadow ?? false}
                  onChange={(checked) =>
                    patchMedia((candidate) => {
                      if (checked) candidate.castShadow = true;
                      else delete candidate.castShadow;
                    }, "media shadow")
                  }
                />
              )}
              {windowed && (
                <>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Strength</span>
                    <DebouncedRange
                      value={shadow.opacity}
                      min={0}
                      max={0.8}
                      step={0.02}
                      label="Shadow strength"
                      disabled={settingsDisabled}
                      onInput={(value) =>
                        patchWindow(
                          (window) => {
                            window.shadow = { ...shadow, opacity: value };
                          },
                          "window shadow",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchWindow((window) => {
                          window.shadow = { ...shadow, opacity: value };
                        }, "window shadow")
                      }
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Softness</span>
                    <DebouncedRange
                      value={shadow.blur}
                      min={0}
                      max={0.4}
                      step={0.01}
                      label="Shadow softness"
                      disabled={settingsDisabled}
                      onInput={(value) =>
                        patchWindow(
                          (window) => {
                            window.shadow = { ...shadow, blur: value };
                          },
                          "window shadow",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchWindow((window) => {
                          window.shadow = { ...shadow, blur: value };
                        }, "window shadow")
                      }
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Drop</span>
                    <DebouncedRange
                      value={shadow.offset[1]}
                      min={-0.2}
                      max={0.2}
                      step={0.01}
                      label="Shadow drop"
                      disabled={settingsDisabled}
                      onInput={(value) =>
                        patchWindow(
                          (window) => {
                            window.shadow = { ...shadow, offset: [shadow.offset[0], value] };
                          },
                          "window shadow",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchWindow((window) => {
                          window.shadow = { ...shadow, offset: [shadow.offset[0], value] };
                        }, "window shadow")
                      }
                    />
                  </div>
                </>
              )}
            </DrillGroup>
          )}

          {entry.kind === "video" && (
            <DrillGroup label="Video">
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Start time (s)</span>
                <NumberField
                  label="Start time"
                  value={(entry.video?.startMs ?? 0) / 1000}
                  decimals={2}
                  min={0}
                  step={0.1}
                  onCommit={(value) =>
                    patchMedia((candidate) => {
                      const startMs = Math.max(0, Math.round(value * 1000));
                      candidate.video = { ...(candidate.video ?? {}), startMs };
                      if (startMs === 0) delete candidate.video.startMs;
                    }, "video start")
                  }
                />
              </div>
              <ToggleRow
                label="Loop"
                description="Restart the clip when it reaches the end."
                checked={entry.video?.loop === true}
                onChange={(checked) =>
                  patchMedia((candidate) => {
                    candidate.video = { ...(candidate.video ?? {}), loop: checked };
                    if (!checked) delete candidate.video.loop;
                  }, "video loop")
                }
              />
            </DrillGroup>
          )}

          <DrillGroup label="Motion">
            <SegmentedRow
              className="subtabs-compact"
              ariaLabel="Media motion"
              options={motionOptions(entry.kind)}
              value={entry.motion?.preset ?? "none"}
              onChange={(preset) =>
                patchMedia((candidate) => {
                  candidate.motion = { preset };
                }, "media motion")
              }
            />
          </DrillGroup>
        </fieldset>
      </div>
    </div>
  );
}
