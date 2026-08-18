import type { AspectName } from "../engine/format";
import { frameTextAlign } from "../engine/framePanelLayout";
import type { ResolvedManagedTextGroup } from "../engine/managedText";
import type {
  SceneDoc,
  SceneDocChart,
  SceneDocDeviceSpec,
  SceneManagedTextItem,
} from "../engine/sceneDocSchema";
import type { ChartType } from "../toolkit/chart/types";
import { DEVICE_CATALOG, isDeviceId, resolveAvailableDeviceSpec } from "../toolkit/device/catalog";
import type { FrameSpec } from "../toolkit/frame/types";
import { textIconInspectorScreenForRoute } from "./inspectorTitles";

/** Pure row/section models for the right-hand inspector: what the panel shows, per tab and per capability, is enumerated here as data and structure-pinned in unit tests. The Scene-tab capability gating mirrors the deleted EditBar's rules verbatim. InspectorPanel renders these models and never invents rows of its own. */

export interface ProjectRowModel {
  id:
    | "media"
    | "scenes"
    | "theme"
    | "typography"
    | "appIcon"
    | "aspect"
    | "music"
    | "render"
    | "playback";
  label: string;
  /** Right-aligned value text (11px tertiary). */
  value?: string;
  /** Renders the trailing › and accepts clicks; false = read-only display row. */
  chevron: boolean;
}

/** The Project tab. Workspace projects get the full set; bundled dev projects keep only what applies without native writes: Aspect ratio (app state) and a read-only Theme value (decision 12). */
export function projectRows(input: {
  isWorkspace: boolean;
  themeName: string;
  /** "Theme fonts" when no override; else the override summary. */
  typographyLabel: string;
  aspect: AspectName;
  soundtrackName: string | null;
  playbackLabel: string;
  renderLabel: string;
  scenesCount: number;
}): ProjectRowModel[] {
  if (!input.isWorkspace) {
    return [
      { id: "theme", label: "Theme", value: input.themeName, chevron: false },
      { id: "playback", label: "Playback options", value: input.playbackLabel, chevron: true },
      { id: "aspect", label: "Aspect ratio", value: input.aspect, chevron: true },
    ];
  }
  return [
    {
      id: "scenes",
      label: "Scenes",
      value: `${input.scenesCount} scene${input.scenesCount === 1 ? "" : "s"}`,
      chevron: true,
    },
    { id: "theme", label: "Theme", value: input.themeName, chevron: true },
    { id: "typography", label: "Typography", value: input.typographyLabel, chevron: true },
    { id: "media", label: "Media library", chevron: true },
    { id: "appIcon", label: "App icon", chevron: true },
    { id: "playback", label: "Playback options", value: input.playbackLabel, chevron: true },
    { id: "render", label: "Render", value: input.renderLabel, chevron: true },
    { id: "aspect", label: "Aspect ratio", value: input.aspect, chevron: true },
    { id: "music", label: "Music", value: input.soundtrackName ?? "None", chevron: true },
  ];
}

/** Chart-type vocabulary, in the schema's own order: the type grid's tile labels and the Chart row's value both read it, so one wording serves the whole inspector. */
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  column: "Column",
  stackedColumn: "Stacked column",
  bar: "Bar",
  stackedBar: "Stacked bar",
  line: "Line",
  area: "Area",
  stackedArea: "Stacked area",
  pie: "Pie",
};

export const CHART_TYPE_IDS = Object.keys(CHART_TYPE_LABELS) as ChartType[];

/** Scene-tab value for the Chart row: dimension then type, e.g. "3D column". A panel-mounted chart is always flat, whatever the block says (`resolveChart` coerces it). */
export function chartRowValue(chart: SceneDocChart): string {
  const dimension = chart.mount !== "panel" && chart.dimension === "3d" ? "3D" : "2D";
  const label = CHART_TYPE_LABELS[chart.type] ?? CHART_TYPE_LABELS.column;
  return `${dimension} ${label.toLowerCase()}`;
}

export type SceneSectionId =
  | "text"
  | "device"
  | "objects"
  | "frame"
  | "style"
  | "camera"
  | "motion";

/** Row label for a staged object, derived purely from its library id (manifest names resolve async, so the model stays sync): "ws:coffee-mug" reads "Coffee mug". */
export function objectRowLabel(objectId: string): string {
  const slug = objectId.startsWith("ws:") ? objectId.slice(3) : objectId;
  const words = slug.replace(/-/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Object";
}

export type SceneOverviewGroupId = "text" | "devices" | "images" | "videos" | "objects";

export type SceneOverviewContentType =
  | "text"
  | "device"
  | "image"
  | "video"
  | "object"
  | "chart"
  | "screenshotStack"
  | "comparison";

export type SceneOverviewSettingType =
  | "overlay"
  | "theme"
  | "background"
  | "camera"
  | "lighting"
  | "transition"
  | "duration";

export type SceneOverviewSelectionTarget =
  | { kind: "text"; id: string }
  | { kind: "device"; id: string }
  | { kind: "image"; id: string }
  | { kind: "legacyImage"; id: string }
  | { kind: "videoWindow" }
  | { kind: "object"; id: string }
  | { kind: "chart" }
  | { kind: "screenshotStack" }
  | { kind: "comparison" };

export interface SceneOverviewMediaHint {
  kind: "image" | "video";
  src: string;
}

export interface SceneOverviewRowModel {
  id: string;
  type: SceneOverviewContentType | SceneOverviewSettingType;
  label: string;
  value?: string;
  thumbnail?: string;
  mediaHint?: SceneOverviewMediaHint;
  selectionTarget?: SceneOverviewSelectionTarget;
  openRoute: string | null;
  readOnly?: boolean;
}

export interface SceneOverviewGroupModel {
  id: SceneOverviewGroupId;
  label: string;
  addType: Extract<SceneOverviewContentType, "text" | "device" | "image" | "video" | "object">;
  rows: SceneOverviewRowModel[];
}

export interface SceneOverviewAddOptionModel {
  id: SceneOverviewContentType;
  label: string;
  singleton: boolean;
  disabled: boolean;
  disabledReason?: "Already in scene" | "Create an overlay first" | "Scene document unavailable";
}

export interface SceneOverviewInput {
  doc: SceneDoc | undefined;
  frame?: FrameSpec;
  durationMs: number;
  slotsCount: number;
  themeName?: string;
  overlayValue?: string;
  backgroundValue?: string;
  cameraValue?: string;
  lightingValue?: string;
  transitionValue?: string;
  fallbackText?: string;
  /** Resolved managed or mounted virtual items. Present-empty intentionally suppresses fallback rows. */
  textItems?: readonly SceneManagedTextItem[];
  /** Content-level Text groups. When present, each group becomes one atomic overview row. */
  textGroups?: readonly ResolvedManagedTextGroup[];
}

export interface SceneOverviewModel {
  groups: SceneOverviewGroupModel[];
  standalone: SceneOverviewRowModel[];
  settings: SceneOverviewRowModel[];
  addOptions: SceneOverviewAddOptionModel[];
}

const OVERVIEW_GROUP_LABELS: Record<SceneOverviewGroupId, string> = {
  text: "Text",
  devices: "Devices",
  images: "Images",
  videos: "Videos",
  objects: "Objects",
};

const DEVICE_LAYOUT_LABELS: Record<NonNullable<SceneDoc["deviceLayout"]>["preset"], string> = {
  row: "Row",
  "toe-in": "Toe-in",
  arc: "Arc",
  cascade: "Cascade",
  hero: "Hero",
  "depth-pair": "Depth",
};

function assetBasename(src: string): string {
  return src.split("/").pop() || src;
}

function sentenceCase(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Untitled";
}

function lineLabel(value: string, fallback: string): string {
  const line = value.split("\n")[0]?.replace(/\s+/g, " ").trim();
  return line || sentenceCase(fallback);
}

function textAlignmentValue(doc: SceneDoc, frame: FrameSpec | undefined): string {
  const alignment =
    frame && frame.enabled !== false && frame.claimsSceneText !== false
      ? frameTextAlign(frame)
      : (doc.textLayout?.align ?? "center");
  return alignment === "center" ? "Centre" : sentenceCase(alignment);
}

function groupTextAlignmentValue(group: ResolvedManagedTextGroup, fallback: string): string {
  return group.align ? (group.align === "center" ? "Centre" : sentenceCase(group.align)) : fallback;
}

function managedTextGroupLabel(group: ResolvedManagedTextGroup): string {
  const item =
    group.items.find((candidate) => candidate.type === "title" && candidate.text?.trim()) ??
    group.items.find((candidate) => candidate.type === "subtitle" && candidate.text?.trim()) ??
    group.items.find(
      (candidate) =>
        candidate.type === "bullets" && candidate.points?.some((point) => point.text.trim()),
    ) ??
    group.items.find(
      (candidate) => candidate.type === "icon" && (candidate.icon ?? candidate.text)?.trim(),
    );
  if (!item) return "Text";
  const copy =
    item.type === "bullets"
      ? (item.points?.find((point) => point.text.trim())?.text ?? "")
      : item.type === "icon"
        ? (item.icon ?? item.text ?? "")
        : (item.text ?? "");
  return lineLabel(copy, "Text");
}

function deviceOverviewValue(
  doc: SceneDoc,
  device: NonNullable<SceneDoc["devices"]>[number],
): string | undefined {
  if (device.media?.src) return assetBasename(device.media.src);
  if (doc.deviceLayout) return DEVICE_LAYOUT_LABELS[doc.deviceLayout.preset];
  if (!isDeviceId(device.model)) return undefined;
  const spec = DEVICE_CATALOG[device.model];
  return spec.colours.find((colour) => colour.id === (device.colour ?? spec.defaultColour))?.name;
}

function deviceOverviewThumbnail(
  device: NonNullable<SceneDoc["devices"]>[number],
): string | undefined {
  if (!isDeviceId(device.model)) return undefined;
  const spec = DEVICE_CATALOG[device.model];
  return spec.previews[device.colour ?? spec.defaultColour] ?? spec.previews[spec.defaultColour];
}

function placementValue(placement: NonNullable<SceneDoc["objects"]>[number]["placement"]): string {
  if (placement?.ground) return "Floor";
  const x = placement?.position?.[0] ?? 0;
  if (x < -0.15) return "Left";
  if (x > 0.15) return "Right";
  return "Centre";
}

function chartOverviewValue(chart: SceneDocChart): string {
  const series = chart.data.series.length;
  return `${CHART_TYPE_LABELS[chart.type]} · ${series} series`;
}

function comparisonOverviewValue(doc: SceneDoc): string | undefined {
  const type = doc.compare?.mask?.type;
  if (!type) return "Before and after";
  return {
    linear: "Linear wipe",
    circle: "Circle reveal",
    radial: "Radial reveal",
    blend: "Blend",
  }[type];
}

function overlayOverviewValue(frame: FrameSpec | undefined): string {
  if (!frame) return "Off";
  if (frame.cutout.shape === "none") return "Full panel";
  const side = frame.cutout.side === "end" ? "End" : "Start";
  const size = Math.round((frame.cutout.size ?? 0.55) * 100);
  return `${side} · ${size}%`;
}

function backgroundOverviewValue(doc: SceneDoc | undefined): string {
  if (!doc || doc.background === undefined) return "Theme default";
  return {
    none: "None",
    color: "Colour",
    gradient: "Gradient",
    shader: "Animated",
    scene3d: "3D",
    image: "Image",
    video: "Video",
  }[doc.background.type];
}

function durationOverviewValue(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function addOptions(doc: SceneDoc | undefined): SceneOverviewAddOptionModel[] {
  const definitions: Array<{
    id: SceneOverviewContentType;
    label: string;
    singleton: boolean;
    present: boolean;
  }> = [
    { id: "device", label: "Device", singleton: false, present: false },
    { id: "text", label: "Text", singleton: false, present: false },
    { id: "image", label: "Image", singleton: false, present: false },
    { id: "video", label: "Video", singleton: true, present: !!doc?.videoWindow },
    { id: "object", label: "Object", singleton: false, present: false },
    { id: "chart", label: "Chart", singleton: true, present: !!doc?.chart },
    {
      id: "screenshotStack",
      label: "Screenshot stack",
      singleton: true,
      present: !!doc?.layeredScreenshot,
    },
    { id: "comparison", label: "Comparison", singleton: true, present: !!doc?.compare },
  ];
  return definitions.map(({ id, label, singleton, present }) => {
    const disabledReason = !doc
      ? "Scene document unavailable"
      : singleton && present
        ? "Already in scene"
        : undefined;
    return { id, label, singleton, disabled: disabledReason !== undefined, disabledReason };
  });
}

/** The redesigned Scene overview as deterministic data: empty groups are omitted and row order never depends on edit recency. */
export function deriveSceneOverview(input: SceneOverviewInput): SceneOverviewModel {
  const { doc, frame } = input;
  const groupedRows: Record<SceneOverviewGroupId, SceneOverviewRowModel[]> = {
    text: [],
    devices: [],
    images: [],
    videos: [],
    objects: [],
  };

  if (doc) {
    const textValue = textAlignmentValue(doc, frame);
    if (input.textGroups !== undefined) {
      for (const [index, group] of input.textGroups.entries()) {
        const preview = managedTextGroupLabel(group);
        groupedRows.text.push({
          id: `text:${group.key}`,
          type: "text",
          label: `Text ${index + 1}: ${preview}`,
          value: groupTextAlignmentValue(group, textValue),
          selectionTarget: { kind: "text", id: group.key },
          openRoute: "text",
        });
      }
    } else if (input.textItems !== undefined) {
      for (const item of input.textItems) {
        const copy =
          item.type === "icon"
            ? (item.icon ?? item.text ?? "")
            : item.type === "bullets"
              ? ((item.points ?? [])
                  .map((point) => point.text)
                  .filter(Boolean)
                  .join(" · ") ?? "")
              : (item.text ?? "");
        groupedRows.text.push({
          id: `text:${item.key}`,
          type: "text",
          label: lineLabel(copy, item.type === "icon" ? "Icon" : item.key),
          value: textValue,
          selectionTarget: { kind: "text", id: item.key },
          openRoute: "text",
        });
      }
    } else {
      for (const [key, value] of Object.entries(doc.text ?? {})) {
        groupedRows.text.push({
          id: `text:${key}`,
          type: "text",
          label: lineLabel(value, key),
          value: textValue,
          selectionTarget: { kind: "text", id: key },
          openRoute: "text",
        });
      }
    }
    if (
      input.textGroups === undefined &&
      input.textItems === undefined &&
      groupedRows.text.length === 0 &&
      input.fallbackText?.trim()
    ) {
      groupedRows.text.push({
        id: "text:fallback",
        type: "text",
        label: lineLabel(input.fallbackText, "Text"),
        value: textValue,
        openRoute: "text",
        readOnly: true,
      });
    }

    for (const [index, device] of (doc.devices ?? []).entries()) {
      const id = device.id || `device-${index + 1}`;
      const mediaHint = device.media?.src
        ? { kind: device.media.kind, src: device.media.src }
        : undefined;
      groupedRows.devices.push({
        id: `device:${id}`,
        type: "device",
        label: isDeviceId(device.model)
          ? DEVICE_CATALOG[device.model].name
          : sentenceCase(device.model),
        value: deviceOverviewValue(doc, device),
        thumbnail: deviceOverviewThumbnail(device),
        mediaHint,
        selectionTarget: { kind: "device", id },
        openRoute: "device",
      });
    }

    if (doc.videoWindow) {
      groupedRows.videos.push({
        id: "video:window",
        type: "video",
        label: assetBasename(doc.videoWindow.media.src),
        value: "Window",
        mediaHint: { kind: "video", src: doc.videoWindow.media.src },
        selectionTarget: { kind: "videoWindow" },
        openRoute: "videoWindow.edit",
      });
    }

    for (const object of doc.objects ?? []) {
      groupedRows.objects.push({
        id: `object:${object.id}`,
        type: "object",
        label: objectRowLabel(object.objectId),
        value: placementValue(object.placement),
        selectionTarget: { kind: "object", id: object.id },
        openRoute: "objects.placement",
      });
    }
  }

  for (const image of doc?.images ?? []) {
    groupedRows.images.push({
      id: `image:${image.id}`,
      type: "image",
      label: assetBasename(image.src),
      value: image.host === "stage" ? "Stage" : "Overlay",
      thumbnail: image.src,
      mediaHint: { kind: "image", src: image.src },
      selectionTarget: { kind: "image", id: image.id },
      openRoute: "image.edit",
    });
  }

  for (const decoration of frame?.decorations ?? []) {
    if (!decoration.src) continue;
    groupedRows.images.push({
      id: `image:legacy:${decoration.id}`,
      type: "image",
      label: assetBasename(decoration.src),
      value: `${Math.round(decoration.size * 100)}%`,
      thumbnail: decoration.src,
      mediaHint: { kind: "image", src: decoration.src },
      selectionTarget: { kind: "legacyImage", id: decoration.id },
      openRoute: "legacyImage.edit",
      readOnly: true,
    });
  }

  const groupOrder: Array<{
    id: SceneOverviewGroupId;
    addType: SceneOverviewGroupModel["addType"];
  }> = [
    { id: "text", addType: "text" },
    { id: "devices", addType: "device" },
    { id: "images", addType: "image" },
    { id: "videos", addType: "video" },
    { id: "objects", addType: "object" },
  ];
  const groups = groupOrder.flatMap(({ id, addType }) =>
    groupedRows[id].length > 0
      ? [{ id, label: OVERVIEW_GROUP_LABELS[id], addType, rows: groupedRows[id] }]
      : [],
  );

  const standalone: SceneOverviewRowModel[] = [];
  if (doc?.chart) {
    standalone.push({
      id: "chart",
      type: "chart",
      label: "Chart",
      value: chartOverviewValue(doc.chart),
      selectionTarget: { kind: "chart" },
      openRoute: "chart.edit",
    });
  }
  if (doc?.layeredScreenshot) {
    const layers = doc.layeredScreenshot.layers.length;
    standalone.push({
      id: "screenshotStack",
      type: "screenshotStack",
      label: "Screenshot stack",
      value: `${layers} layer${layers === 1 ? "" : "s"}`,
      selectionTarget: { kind: "screenshotStack" },
      openRoute: "layeredScreenshot.edit",
    });
  }
  if (doc?.compare) {
    standalone.push({
      id: "comparison",
      type: "comparison",
      label: "Comparison",
      value: comparisonOverviewValue(doc),
      selectionTarget: { kind: "comparison" },
      openRoute: "compare.edit",
    });
  }

  const settings: SceneOverviewRowModel[] = [
    {
      id: "overlay",
      type: "overlay",
      label: "Overlay",
      value: input.overlayValue ?? overlayOverviewValue(frame),
      openRoute: doc ? "frame" : null,
    },
    {
      id: "theme",
      type: "theme",
      label: "Theme",
      value: input.themeName ?? doc?.themeId ?? "Project theme",
      openRoute: doc ? "style.theme" : null,
    },
    {
      id: "background",
      type: "background",
      label: "Background",
      value: input.backgroundValue ?? backgroundOverviewValue(doc),
      openRoute: doc ? "style.background" : null,
    },
    {
      id: "camera",
      type: "camera",
      label: "Camera",
      value: input.cameraValue ?? (doc?.cameraMode === "rig" ? "Free" : "Orbit"),
      openRoute: "camera",
    },
    {
      id: "lighting",
      type: "lighting",
      label: "Lighting",
      value: input.lightingValue ?? (doc?.lighting ? "Custom" : "Theme"),
      openRoute: doc ? "lighting" : null,
    },
    {
      id: "transition",
      type: "transition",
      label: "Transition",
      value: input.transitionValue ?? "None",
      openRoute: input.slotsCount > 1 ? "motion.transition" : null,
    },
    {
      id: "duration",
      type: "duration",
      label: "Duration",
      value: durationOverviewValue(input.durationMs),
      openRoute: null,
    },
  ];

  return { groups, standalone, settings, addOptions: addOptions(doc) };
}

export interface SceneRowModel {
  id: string;
  label: string;
  /** Filled in by the panel where live values exist; absent in the pure model. */
  value?: string;
  /** Danger styling + no chevron (Remove device). */
  danger?: boolean;
  disabled?: boolean;
  chevron: boolean;
}

export function comparisonDeviceVideoRows(
  before: SceneDocDeviceSpec["media"],
  after: SceneDocDeviceSpec["media"],
): SceneRowModel[] {
  return [
    {
      id: "device.media",
      label: "Change video",
      value: "Before / After",
      chevron: true,
    },
    {
      id: "device.editVideo",
      label: "Edit video",
      value: "Before / After",
      chevron: true,
      disabled: before?.kind !== "video" && after?.kind !== "video",
    },
  ];
}

export interface ComparisonVideoSideOption {
  side: "before" | "after";
  label: "Before" | "After";
  disabled: boolean;
}

/** The compact comparison media picker: Change accepts either side, Edit disables only the sides that are not videos. */
export function comparisonDeviceVideoSides(
  before: SceneDocDeviceSpec["media"],
  after: SceneDocDeviceSpec["media"],
  action: "change" | "edit",
): ComparisonVideoSideOption[] {
  return [
    { side: "before", label: "Before", disabled: action === "edit" && before?.kind !== "video" },
    { side: "after", label: "After", disabled: action === "edit" && after?.kind !== "video" },
  ];
}

export interface SceneSectionModel {
  id: SceneSectionId;
  label: string;
  rows: SceneRowModel[];
}

/** The Scene tab's sections for one scene, mirroring the deleted EditBar's capability gating verbatim: text rows need a non-empty `doc.text`; device rows act on the SELECTED device (`selectedDeviceId`, falling back to `doc.devices[0]`; Edit video additionally `media.kind === "video"`); style rows need a doc; the Overlay section offers Add overlay until the deck declares a frame (`deckFrame`) or the sidecar carries its own cutout, its rows depending on whether this scene resolves to a visible frame (`frame`); Transition needs a second scene; Camera and Duration are always present. */
export function sceneSections(input: {
  doc: SceneDoc | undefined;
  slotsCount: number;
  /** The project's deck-wide overlay is declared (project.json `frame`). A sidecar frame with a cutout stands alone (`mergeFrameSpec`), so either source produces an overlay to edit. */
  deckFrame?: boolean;
  /** This scene's RESOLVED overlay (deck merged with the sidecar override), `undefined` when it renders full-bleed (opted out); drives the enabled state and the row set. */
  frame?: FrameSpec | undefined;
  /** Which device the device rows target; absent or stale falls back to the first device. */
  selectedDeviceId?: string;
}): SceneSectionModel[] {
  const { doc, slotsCount, deckFrame = false, frame, selectedDeviceId } = input;
  const devices = doc?.devices ?? [];
  const device = devices.find((d) => d.id === selectedDeviceId) ?? devices[0];
  const hasText = Object.keys(doc?.text ?? {}).length > 0;

  const sections: SceneSectionModel[] = [];

  if (hasText && doc) {
    sections.push({
      id: "text",
      label: "Text",
      rows: [
        { id: "text.edit", label: "Edit text", chevron: true },
        { id: "text.motion", label: "Text motion", chevron: true },
      ],
    });
  } else if (doc) {
    sections.push({
      id: "text",
      label: "Text",
      rows: [{ id: "text.add", label: "Add text", chevron: false }],
    });
  }

  // The Device panel: the device's own controls (media, model, pose, shadow). The screenshot stack
  // and video window are their own top-level entries now, not device rows.
  if (device) {
    const rows: SceneRowModel[] = [{ id: "device.media", label: "Change video", chevron: true }];
    if (device.media?.kind === "video") {
      rows.push({ id: "device.editVideo", label: "Edit video", chevron: true });
    }
    rows.push(
      { id: "device.change", label: "Change device", chevron: true },
      { id: "device.position", label: "Arrangement", chevron: true },
    );
    if (resolveAvailableDeviceSpec(device.model).lid) {
      rows.push({ id: "device.lid", label: "Lid angle", chevron: false });
    }
    rows.push({ id: "style.shadow", label: "Shadow", chevron: true });
    rows.push({ id: "device.duplicate", label: "Duplicate device", chevron: false });
    rows.push({ id: "device.add", label: "Add another device", chevron: false });
    rows.push({ id: "device.remove", label: "Remove device", danger: true, chevron: false });
    sections.push({ id: "device", label: devices.length > 1 ? "Devices" : "Device", rows });
  } else if (doc) {
    sections.push({
      id: "device",
      label: "Device",
      rows: [{ id: "device.add", label: "Add device", chevron: false }],
    });
  }

  // The Objects section: one row per staged library object plus the add affordance.
  const objects = doc?.objects ?? [];
  if (objects.length > 0) {
    sections.push({
      id: "objects",
      label: objects.length > 1 ? "Objects" : "Object",
      rows: [
        ...objects.map((o) => ({
          id: `objects.edit:${o.id}`,
          label: objectRowLabel(o.objectId),
          chevron: true,
        })),
        { id: "objects.add", label: "Add object", chevron: false },
      ],
    });
  } else if (doc) {
    sections.push({
      id: "objects",
      label: "Object",
      rows: [{ id: "objects.add", label: "Add object", chevron: false }],
    });
  }

  if (deckFrame || doc?.frame?.cutout !== undefined) {
    // The Overlay section: the enabled toggle opts this scene in/out of its overlay (the deck's,
    // or the sidecar's own standalone cutout); the cutout and panel rows appear only while it's
    // shown. All edits write the sidecar `frame` override.
    const rows: SceneRowModel[] = [
      { id: "frame.enabled", label: "Show on this scene", chevron: false },
    ];
    if (frame) {
      rows.push(
        { id: "frame.cutout", label: "Cutout", chevron: true },
        { id: "frame.panel", label: "Panel", chevron: true },
        { id: "frame.icon", label: "Panel icon", chevron: true },
        { id: "frame.chip", label: "Chip", chevron: true },
        { id: "frame.decorations", label: "Decorations", chevron: true },
        { id: "frame.text", label: "Scene text", chevron: true },
      );
    }
    sections.push({ id: "frame", label: "Overlay", rows });
  } else if (doc) {
    sections.push({
      id: "frame",
      label: "Overlay",
      rows: [{ id: "frame.add", label: "Add overlay", chevron: false }],
    });
  }

  sections.push({
    id: "camera",
    label: "Camera",
    rows: [],
  });

  const motionRows: SceneRowModel[] = [];
  if (slotsCount > 1) {
    motionRows.push({ id: "motion.transition", label: "Transition", chevron: true });
  }
  motionRows.push({ id: "motion.duration", label: "Duration", chevron: false });
  sections.push({ id: "motion", label: "Motion", rows: motionRows });

  return sections;
}

/** What a scene offers the open inspector screen, for `drillStackForScene`. */
export interface SceneDrillCapability {
  hasDoc: boolean;
  /** Keys of the scene's `text` block: the fields the Text drill and its per-key font screens expose. */
  textKeys: string[];
  hasDevice: boolean;
  hasObject: boolean;
  /** The scene resolves an overlay to edit (the deck's, or its own cutout). */
  hasOverlay: boolean;
}

/** True for the screens that FOLLOW the playhead across a scene change: sections and settings whose editor reads only the scene's own doc, so the same screen over a new scene simply shows the new scene's values. Detail screens carrying a scene-scoped selection or session (device, overlay, comparison and object editors, media pickers, the transition boundary) are deliberately absent, so they pop back to their section. */
export function drillFollowsScene(id: string, scene: SceneDrillCapability): boolean {
  if (id.startsWith("text.font:")) return scene.textKeys.includes(id.slice("text.font:".length));
  if (id.startsWith("text.motion:")) {
    return scene.textKeys.includes(id.slice("text.motion:".length));
  }
  const textIconScreen = textIconInspectorScreenForRoute(id);
  if (textIconScreen) return scene.textKeys.includes(textIconScreen.itemKey);
  if (id.startsWith("lighting.")) return scene.hasDoc;
  switch (id) {
    case "camera":
      return true;
    case "text":
    case "lighting":
    case "style.theme":
    case "style.background":
      return scene.hasDoc;
    case "device":
      return scene.hasDevice;
    case "objects":
      return scene.hasObject;
    case "frame":
      return scene.hasOverlay;
    default:
      return false;
  }
}

/** The drill stack a scene change keeps: the longest leading run of screens the new scene still has. A detail screen pops to its section, a section the new scene lacks pops to the row list (`[]`). */
export function drillStackForScene(stack: string[], scene: SceneDrillCapability): string[] {
  const at = stack.findIndex((id) => !drillFollowsScene(id, scene));
  return at < 0 ? stack : stack.slice(0, at);
}
