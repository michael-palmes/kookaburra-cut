import type { AspectName } from "../engine/format";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { DEVICE_CATALOG, isDeviceId } from "../toolkit/device/catalog";
import type { FrameSpec } from "../toolkit/frame/types";

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

export interface SceneRowModel {
  id: string;
  label: string;
  /** Filled in by the panel where live values exist; absent in the pure model. */
  value?: string;
  /** Danger styling + no chevron (Remove device). */
  danger?: boolean;
  chevron: boolean;
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
      { id: "device.rotation", label: "Rotation", chevron: true },
    );
    if (isDeviceId(device.model) && DEVICE_CATALOG[device.model].lid) {
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
        { id: "frame.panel", label: "Panel colour", chevron: true },
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
    rows: [{ id: "camera.animate", label: "Animate scene", chevron: true }],
  });

  const motionRows: SceneRowModel[] = [];
  if (slotsCount > 1) {
    motionRows.push({ id: "motion.transition", label: "Transition", chevron: true });
  }
  motionRows.push({ id: "motion.duration", label: "Duration", chevron: false });
  sections.push({ id: "motion", label: "Motion", rows: motionRows });

  return sections;
}
