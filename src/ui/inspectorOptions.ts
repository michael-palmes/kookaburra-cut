import type { AspectName } from "../engine/format";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { DEVICE_CATALOG, isDeviceId } from "../toolkit/device/catalog";

/** Pure row/section models for the right-hand inspector: what the panel shows, per tab and per capability, is enumerated here as data and structure-pinned in unit tests. The Scene-tab capability gating mirrors the deleted EditBar's rules verbatim. InspectorPanel renders these models and never invents rows of its own. */

export interface ProjectRowModel {
  id: "media" | "theme" | "aspect" | "music" | "playback";
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
  aspect: AspectName;
  soundtrackName: string | null;
  playbackLabel: string;
}): ProjectRowModel[] {
  if (!input.isWorkspace) {
    return [
      { id: "theme", label: "Theme", value: input.themeName, chevron: false },
      { id: "aspect", label: "Aspect ratio", value: input.aspect, chevron: true },
      { id: "playback", label: "Playback options", value: input.playbackLabel, chevron: true },
    ];
  }
  return [
    { id: "media", label: "Media library", chevron: true },
    { id: "theme", label: "Theme", value: input.themeName, chevron: true },
    { id: "aspect", label: "Aspect ratio", value: input.aspect, chevron: true },
    { id: "music", label: "Music", value: input.soundtrackName ?? "None", chevron: true },
    { id: "playback", label: "Playback options", value: input.playbackLabel, chevron: true },
  ];
}

export type SceneSectionId = "text" | "device" | "style" | "camera" | "motion";

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

/** The Scene tab's sections for one scene, mirroring the deleted EditBar's capability gating verbatim: text rows need a non-empty `doc.text`; device rows need `doc.devices[0]` (Edit video additionally `media.kind === "video"`); style rows need a doc; Transition needs a second scene; Camera and Duration are always present. */
export function sceneSections(input: {
  doc: SceneDoc | undefined;
  slotsCount: number;
}): SceneSectionModel[] {
  const { doc, slotsCount } = input;
  const device = doc?.devices?.[0];
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

  if (device) {
    const rows: SceneRowModel[] = [{ id: "device.media", label: "Change media", chevron: true }];
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
    rows.push({ id: "device.remove", label: "Remove device", danger: true, chevron: false });
    sections.push({ id: "device", label: "Media & device", rows });
  } else if (doc) {
    sections.push({
      id: "device",
      label: "Media & device",
      rows: [{ id: "device.add", label: "Add device", chevron: false }],
    });
  }

  if (doc) {
    // The whole Style group is drill-ins: Background is the ONE surface for both the fixed layer and staging (colour/gradient write through to the stage), Shadow a card picker.
    sections.push({
      id: "style",
      label: "Style",
      rows: [
        { id: "style.theme", label: "Theme", chevron: true },
        { id: "style.background", label: "Background", chevron: true },
        ...(device ? [{ id: "style.shadow", label: "Shadow", chevron: true }] : []),
      ],
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
