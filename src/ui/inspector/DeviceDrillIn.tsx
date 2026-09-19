import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useClockStore } from "../../engine/clock";
import { useDeviceEditStore } from "../../engine/deviceEditStore";
import {
  compareSlotMedia,
  DEVICE_SCREEN_SLOTS,
  type DeviceScreenSlot,
  deviceSlotMedia,
  setCompareSlotMedia,
  setDeviceSlotMedia,
} from "../../engine/deviceScreens";
import { useDeviceTrackEditStore } from "../../engine/deviceTrackEditStore";
import {
  FOLD_POWER_WINDOW_DEG,
  FOLD_SWITCH_DEG,
  resolveFoldTransition,
} from "../../engine/foldTransition";
import { optionPreviewStill } from "../../engine/optionPreviews";
import { nearestDeviceKey, resolveDeviceTrack } from "../../engine/sceneDeviceTrack";
import type { SceneDoc, SceneDocDeviceSpec } from "../../engine/sceneDocSchema";
import {
  AVAILABLE_DEVICE_IDS,
  CUSTOM_COLOUR_PREFIX,
  customColourHex,
  DEVICE_CATALOG,
  type DeviceId,
  resolveAvailableDeviceId,
} from "../../toolkit/device/catalog";
import {
  type DeviceMediaSpec,
  type DeviceMotionPreset,
  type DevicePlacement,
  type DeviceShadowMode,
  effectiveDeviceShadowMode,
} from "../../toolkit/device/Device";
import { DEVICE_SHADOW_CHOICES } from "../../toolkit/device/shadowProjector";
import type { V3 } from "../../toolkit/types";
import { ComparisonSideIcon } from "../ComparisonSideIcon";
import { ColourPicker } from "../colour/ColourPicker";
import { OptionCard } from "../OptionCard";
import { CompareSideSelector } from "./CompareSideSelector";
import { activeCompareSide, type CompareSide, deviceSideRouting } from "./compareSideRouting";
import { setCompareDeviceAppearance } from "./comparisonTarget";
import {
  changeSceneDeviceModel,
  compatibleDeviceColour,
  duplicateDevice,
  removeDevice,
  resetDeviceLayoutDelta,
  setDeviceRotationPose,
} from "./deviceEditorModel";
import {
  addFoldAnimation,
  FOLD_PRESETS,
  type FoldPresetId,
  foldDegEditing,
  setFoldPoseScreens,
  writeFoldDeg,
} from "./foldEditorModel";
import { MediaSourceGroup } from "./MediaSourceGroup";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  DrillHeaderAction,
  GizmoModeIcon,
  InspectorSliderRow,
  type SegmentedOption,
  SegmentedRow,
  ToggleRow,
} from "./rows";

export type DeviceDocPatch = (next: SceneDoc) => void;
export type DevicePatchDoc = (
  patch: DeviceDocPatch,
  opts?: { history?: string | false },
) => Promise<void>;
export type DevicePatchDocResult = (
  patch: (next: SceneDoc) => unknown,
  opts?: { history?: string | false },
) => Promise<boolean>;

/** The Before/After routing this drill runs when the scene has a comparison: the shared side plus the setter that moves every comparison-aware inspector with it. */
export interface DeviceComparisonProps {
  side: CompareSide;
  onSideChange: (side: CompareSide) => void;
}

export interface DeviceDrillInProps {
  doc: SceneDoc;
  deviceId: string;
  backLabel?: string;
  screenMediaPreviewUrl?: string;
  screenMediaAspectRatio?: number;
  screenMediaDetail?: string;
  /** A foldable's outside display; unused by single-screen devices. */
  coverMediaPreviewUrl?: string;
  coverMediaAspectRatio?: number;
  coverMediaDetail?: string;
  comparison?: DeviceComparisonProps;
  /** The scene's slot on the project timeline: lets a foldable's fold edits land on the key nearest the playhead. */
  slot?: { startMs: number; durationMs: number };
  settingsDisabled?: boolean;
  duplicateDisabled?: boolean;
  removeDisabled?: boolean;
  notice?: ReactNode;
  onBack: () => void;
  onSelectDevice: (deviceId: string) => void;
  onChangeDevice: (deviceId: string) => void;
  onChangeScreenMedia: (deviceId: string, screen?: DeviceScreenSlot) => void;
  onEditScreenMedia?: (deviceId: string, screen?: DeviceScreenSlot) => void;
  onOpenArrangement: (deviceId: string) => void;
  onDuplicate?: (deviceId: string) => void;
  onRemove?: (deviceId: string) => void;
  onDeviceRemoved?: () => void;
  patchDoc: DevicePatchDoc;
  patchDocResult: DevicePatchDocResult;
  commitFromBaseline: (baseline: SceneDoc, patch: DeviceDocPatch) => Promise<void>;
}

export interface DeviceModelDrillInProps {
  model: DeviceId;
  deviceCount?: number;
  deviceLabel?: string;
  onBack: () => void;
  backLabel?: string;
  onSelectModel: (model: DeviceId, applyAll: boolean) => void;
}

type DeviceMutation = (doc: SceneDoc, device: SceneDocDeviceSpec) => void;
type DeviceAxis = 0 | 1 | 2;

const ZERO: V3 = [0, 0, 0];

const GIZMO_OPTIONS: SegmentedOption<"translate" | "rotate" | "scale">[] = [
  { value: "translate", label: "Move", icon: <GizmoModeIcon mode="translate" /> },
  { value: "rotate", label: "Rotate", icon: <GizmoModeIcon mode="rotate" /> },
  { value: "scale", label: "Scale", icon: <GizmoModeIcon mode="scale" /> },
];

const DEVICE_MOTIONS: Array<{
  id: DeviceMotionPreset;
  label: string;
}> = [
  { id: "none", label: "None" },
  { id: "push-in", label: "Push-in settle" },
  { id: "turntable", label: "Slow turntable" },
  { id: "float", label: "Float" },
  { id: "tilt-reveal", label: "Tilt reveal" },
];

const DEVICE_SHADOWS = DEVICE_SHADOW_CHOICES;

const DEVICE_POSES: Array<{ id: string; label: string; rotationDeg: V3 }> = [
  { id: "front", label: "Front on", rotationDeg: [0, 0, 0] },
  { id: "editorial", label: "Editorial", rotationDeg: [-6, 14, 0] },
  { id: "mirrored", label: "Mirrored", rotationDeg: [-6, -14, 0] },
];

const LAYOUT_LABELS = {
  row: "Row",
  "toe-in": "Toe-in",
  arc: "Arc",
  cascade: "Cascade",
  hero: "Hero",
  "depth-pair": "Depth",
} as const;

export function deviceNavigationFocusTarget(
  direction: "previous" | "next",
  deviceIndex: number,
  deviceCount: number,
): "previous" | "next" | null {
  if (direction === "previous") {
    if (deviceIndex > 0) return "previous";
    return deviceIndex < deviceCount - 1 ? "next" : null;
  }
  if (deviceIndex < deviceCount - 1) return "next";
  return deviceIndex > 0 ? "previous" : null;
}

export async function changeFirstClassDeviceModel(
  patchDocResult: DevicePatchDocResult,
  deviceId: string,
  model: DeviceId,
  applyAll = false,
): Promise<boolean> {
  return patchDocResult((next) => changeSceneDeviceModel(next, deviceId, model, applyAll), {
    history: applyAll ? "change all device models" : "change device model",
  });
}

export async function duplicateFirstClassDevice(
  patchDocResult: DevicePatchDocResult,
  deviceId: string,
  onSelectDevice: (deviceId: string) => void,
): Promise<boolean> {
  let duplicateId: string | null = null;
  const succeeded = await patchDocResult(
    (next) => {
      duplicateId = duplicateDevice(next, deviceId);
      return duplicateId !== null;
    },
    { history: "duplicate device" },
  );
  if (succeeded && duplicateId) onSelectDevice(duplicateId);
  return succeeded;
}

export interface RemoveFirstClassDeviceResult {
  succeeded: boolean;
  nextDeviceId: string | null;
}

export async function removeFirstClassDevice(
  patchDocResult: DevicePatchDocResult,
  deviceId: string,
): Promise<RemoveFirstClassDeviceResult> {
  let nextDeviceId: string | null = null;
  const succeeded = await patchDocResult(
    (next) => {
      if (!next.devices?.some((device) => device.id === deviceId)) return false;
      nextDeviceId = removeDevice(next, deviceId);
      return true;
    },
    { history: "remove device" },
  );
  return { succeeded, nextDeviceId: succeeded ? nextDeviceId : null };
}

function mutateDocDevice(next: SceneDoc, deviceId: string, mutate: DeviceMutation): void {
  const device = next.devices?.find((candidate) => candidate.id === deviceId);
  if (device) mutate(next, device);
}

function setPositionAxis(
  next: SceneDoc,
  device: SceneDocDeviceSpec,
  axis: DeviceAxis,
  value: number,
) {
  if (next.deviceLayout) {
    const devices = { ...(next.deviceLayout.devices ?? {}) };
    const delta = { ...(devices[device.id] ?? {}) };
    const offset: V3 = [...(delta.offset ?? ZERO)];
    offset[axis] = value;
    delta.offset = offset;
    devices[device.id] = delta;
    next.deviceLayout = { ...next.deviceLayout, devices };
  } else {
    const position: V3 = [...(device.placement?.position ?? ZERO)];
    position[axis] = value;
    device.placement = { ...device.placement, position };
  }
  if (axis === 1 && device.placement?.ground) {
    device.placement = { ...device.placement };
    delete device.placement.ground;
  }
}

function setRotationAxis(
  next: SceneDoc,
  device: SceneDocDeviceSpec,
  axis: DeviceAxis,
  value: number,
) {
  if (next.deviceLayout) {
    const devices = { ...(next.deviceLayout.devices ?? {}) };
    const delta = { ...(devices[device.id] ?? {}) };
    const rotationDeg: V3 = [...(delta.rotationDeg ?? ZERO)];
    rotationDeg[axis] = value;
    delta.rotationDeg = rotationDeg;
    devices[device.id] = delta;
    next.deviceLayout = { ...next.deviceLayout, devices };
  } else {
    const rotationDeg: V3 = [...(device.placement?.rotationDeg ?? ZERO)];
    rotationDeg[axis] = value;
    device.placement = { ...device.placement, rotationDeg };
  }
}

function setScale(next: SceneDoc, device: SceneDocDeviceSpec, value: number) {
  if (next.deviceLayout) {
    const devices = { ...(next.deviceLayout.devices ?? {}) };
    devices[device.id] = { ...(devices[device.id] ?? {}), scale: value };
    next.deviceLayout = { ...next.deviceLayout, devices };
  } else {
    device.placement = { ...device.placement, scale: value };
  }
}

function resetTransform(next: SceneDoc, device: SceneDocDeviceSpec): void {
  if (next.deviceLayout) {
    next.deviceLayout = resetDeviceLayoutDelta(next.deviceLayout, device.id);
    return;
  }
  const placement: DevicePlacement = { ...(device.placement ?? {}) };
  placement.position = [0, 0, 0];
  placement.rotationDeg = [0, 0, 0];
  placement.scale = 1;
  device.placement = placement;
}

function fileName(src: string): string {
  return src.split("/").filter(Boolean).at(-1) ?? src;
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

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function DeviceControlIcon({
  type,
}: {
  type: "x" | "y" | "depth" | "tilt" | "turn" | "roll" | "size" | "lid" | "delay" | "fold";
}) {
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
    tilt: <path d="M4 12.5 12 3.5M4 8.5v4h4" />,
    turn: (
      <>
        <path d="M3.5 8c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4-2 4-4.5 4" />
        <path d="m10.7 10.1 1.8 1.9 1.4-2.3" />
      </>
    ),
    roll: (
      <>
        <path d="M13.4 8A5.4 5.4 0 114.9 3.6" />
        <path d="M4.2 1.8v3.6h3.6" />
      </>
    ),
    size: <path d="M3 9.6V13h3.4M13 6.4V3H9.6M3.2 12.8 7.4 8.6M12.8 3.2 8.6 7.4" />,
    lid: (
      <>
        <path d="M3 12.5h10" />
        <path d="M4.5 11.5 6 4.5h6l1.5 7" />
      </>
    ),
    fold: (
      <>
        <path d="M8 3.2v9.6" />
        <path d="M8 4.2 2.8 5.8v6L8 11.8M8 4.2l5.2 1.6v6L8 11.8" />
      </>
    ),
    delay: (
      <>
        <circle cx="8" cy="8.8" r="4.8" />
        <path d="M8 6.4v2.4l1.9 1.2" />
        <path d="M6.4 2.2h3.2" />
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

/** Top-down hinge glyphs: the two panels as seen from above, hinge at the centre dot. */
function FoldGlyph({
  kind,
}: {
  kind:
    | FoldPresetId
    | "unfold"
    | "fold"
    | "tent"
    | "back"
    | "both"
    | "transition"
    | "intensity"
    | "blur"
    | "darken"
    | "switch";
}) {
  const glyph = {
    closed: <path d="M3.4 7h9.2M3.4 9h9.2M3.4 7v2" />,
    flex: <path d="M3.4 12.4V4h9.2" />,
    book: <path d="M2.8 10.6 8 4.6l5.2 6" />,
    open: <path d="M2.4 8h11.2M8 6.8v2.4" />,
    unfold: (
      <>
        <path d="M2.4 11h11.2" />
        <path d="M5.2 7.4 3 9.2M10.8 7.4 13 9.2M5.2 7.4V5M10.8 7.4V5" />
      </>
    ),
    fold: (
      <>
        <path d="M6.4 3.4v9.2M9.6 3.4v9.2" />
        <path d="M2.4 8h2.4M13.6 8h-2.4M3.8 6.6 5 8l-1.2 1.4M12.2 6.6 11 8l1.2 1.4" />
      </>
    ),
    tent: <path d="M2.6 12.2 8 3.8l5.4 8.4M1.8 12.2h12.4" />,
    back: (
      <>
        <rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1.6" />
        <path d="M8 3.6v8.8" />
        <circle cx="5.3" cy="6.2" r="1" />
      </>
    ),
    both: (
      <>
        <rect x="2.4" y="4" width="4.6" height="8" rx="1.2" />
        <rect x="9" y="4" width="4.6" height="8" rx="1.2" />
        <path d="M4.7 6.2v3.6M11.3 6.2v3.6" />
      </>
    ),
    transition: (
      <>
        <rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1.6" />
        <path d="M6 5.6v4.8M8.4 6.2v3.6M10.6 7v2" />
      </>
    ),
    intensity: <path d="M2.8 11.6h10.4M2.8 11.6 13.2 5v6.6" />,
    blur: (
      <>
        <circle cx="8" cy="8" r="2" />
        <path d="M8 2.8v1.4M8 11.8v1.4M2.8 8h1.4M11.8 8h1.4M4.3 4.3l1 1M10.7 10.7l1 1M4.3 11.7l1-1M10.7 5.3l1-1" />
      </>
    ),
    darken: (
      <>
        <circle cx="8" cy="8" r="4.8" />
        <path d="M8 3.2a4.8 4.8 0 000 9.6z" fill="currentColor" stroke="none" />
      </>
    ),
    switch: (
      <>
        <path d="M2.8 12.2h10.4" />
        <path d="M8 12.2 12.4 5.4M8 12.2V4.4" />
        <path d="M8 6.8a5.4 5.4 0 013 1" />
      </>
    ),
  }[kind];
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

const FOLD_PRESET_OPTIONS: SegmentedOption<FoldPresetId | "custom">[] = FOLD_PRESETS.map(
  (preset) => ({ value: preset.id, label: preset.label, icon: <FoldGlyph kind={preset.id} /> }),
);

/** Whole-device poses that only make sense with a hinge: a rotation and a fold angle together. */
const FOLD_POSES: Array<{
  id: "book" | "tent" | "back";
  label: string;
  rotationDeg: V3;
  foldDeg: number;
  /** A tent faces its outside display out while folded past the power switch, so it needs both lit. */
  bothScreensOn?: true;
}> = [
  { id: "book", label: "Book upright", rotationDeg: [4, -20, 0], foldDeg: 120 },
  // Solved, not eyeballed: hinge horizontal on top, the panels' bisector straight down, then a 20 degree turn.
  { id: "tent", label: "Tent", rotationDeg: [38, -20, -75], foldDeg: 70, bothScreensOn: true },
  { id: "back", label: "Back", rotationDeg: [4, 160, 0], foldDeg: 180 },
];

function DeviceGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="2.5" width="8" height="15" rx="2" />
      <path d="M8.5 4.5h3" />
    </svg>
  );
}

function DeviceMotionIcon({ preset }: { preset: DeviceMotionPreset }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {preset === "none" ? (
        <path d="M4 10h12" />
      ) : preset === "push-in" ? (
        <>
          <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
          <path d="m7 10 2 2 4-4" />
        </>
      ) : preset === "turntable" ? (
        <>
          <path d="M4 9.8c0-2.8 2.7-5 6-5 2.6 0 4.8 1.3 5.6 3.2" />
          <path d="m13.3 6.8 2.5 1.5.7-2.8" />
          <path d="M16 10.2c0 2.8-2.7 5-6 5-2.6 0-4.8-1.3-5.6-3.2" />
        </>
      ) : preset === "float" ? (
        <>
          <rect x="5" y="6.5" width="10" height="7" rx="1.5" />
          <path d="M10 2.5v2M10 15.5v2" />
        </>
      ) : (
        <path d="M5 4.5l10.5 2v7L5 15.5z" />
      )}
    </svg>
  );
}

/** Keyframes: the lane's own diamond on a track, so the toggle reads as the timeline it opens. */
function KeyframeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 10h3M14.5 10h3" />
      <path d="m10 5.5 4.5 4.5L10 14.5 5.5 10z" />
    </svg>
  );
}

function DevicePoseIcon({ pose }: { pose: (typeof DEVICE_POSES)[number]["id"] }) {
  const transform = pose === "front" ? undefined : pose === "editorial" ? "skewY(-7)" : "skewY(7)";
  return (
    <svg
      width="28"
      height="34"
      viewBox="0 0 28 34"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform={transform}>
        <rect x="7" y="2.5" width="14" height="29" rx="3" />
        <path d="M11.5 5h5" />
        <path d="M9.5 27.5h9" opacity="0.45" />
      </g>
    </svg>
  );
}

function sameVector(a: V3, b: V3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function ArrangementIcon() {
  return (
    <svg
      className="device-editor-arrangement-icon"
      width="28"
      height="18"
      viewBox="0 0 28 18"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <rect x="3.5" y="3" width="5" height="12" rx="1.5" opacity="0.6" />
      <rect x="11.5" y="3" width="5" height="12" rx="1.5" />
      <rect x="19.5" y="3" width="5" height="12" rx="1.5" opacity="0.6" />
    </svg>
  );
}

export function DeviceDrillIn({
  doc,
  deviceId,
  backLabel = "Scene",
  screenMediaPreviewUrl,
  screenMediaAspectRatio,
  screenMediaDetail,
  coverMediaPreviewUrl,
  coverMediaAspectRatio,
  coverMediaDetail,
  comparison,
  slot,
  settingsDisabled = false,
  duplicateDisabled = false,
  removeDisabled = false,
  notice,
  onBack,
  onSelectDevice,
  onChangeDevice,
  onChangeScreenMedia,
  onEditScreenMedia,
  onOpenArrangement,
  onDuplicate,
  onRemove,
  onDeviceRemoved,
  patchDoc,
  patchDocResult,
  commitFromBaseline,
}: DeviceDrillInProps) {
  const dragBaseline = useRef<SceneDoc | null>(null);
  const pendingGesture = useRef<(() => void) | null>(null);
  const previousDeviceButtonRef = useRef<HTMLButtonElement>(null);
  const nextDeviceButtonRef = useRef<HTMLButtonElement>(null);
  const pendingNavigationFocus = useRef<"previous" | "next" | null>(null);
  const gizmoMode = useDeviceEditStore((state) => state.gizmoMode);
  const trackOpen = useDeviceTrackEditStore((state) => state.open);
  const devices = doc.devices ?? [];
  const deviceIndex = devices.findIndex((candidate) => candidate.id === deviceId);
  const device = devices[deviceIndex];
  const [foldNotice, setFoldNotice] = useState<string | null>(null);
  // Re-render only when the key a fold edit lands on changes, never per tick (the camera-section idiom); the writes snapshot the live clock.
  const foldKeyed = (doc.deviceTrack?.keys.length ?? 0) > 0;
  useClockStore((state) => {
    if (!slot || !foldKeyed) return null;
    const local = Math.min(slot.durationMs, Math.max(0, state.currentMs - slot.startMs));
    return nearestDeviceKey(resolveDeviceTrack(doc), local)?.id ?? null;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: device identity closes the previous gesture session
  useEffect(
    () => () => {
      const flush = pendingGesture.current;
      pendingGesture.current = null;
      dragBaseline.current = null;
      flush?.();
    },
    [deviceId],
  );

  useLayoutEffect(() => {
    const direction = pendingNavigationFocus.current;
    if (!direction || !device) return;
    const targetDirection = deviceNavigationFocusTarget(direction, deviceIndex, devices.length);
    const target =
      targetDirection === "previous"
        ? previousDeviceButtonRef.current
        : targetDirection === "next"
          ? nextDeviceButtonRef.current
          : null;
    target?.focus({ preventScroll: true });
    pendingNavigationFocus.current = null;
  }, [device, deviceIndex, devices.length]);

  if (!device) {
    return (
      <div className="inspector-drill device-editor-drill">
        <DrillBack label={backLabel} title="Device" onClick={onBack} />
        <div className="inspector-drill-body">
          <p className="modal-hint">This device is no longer in the scene.</p>
        </div>
      </div>
    );
  }

  const patchWithGesture = (patch: (next: SceneDoc) => void, history: string, preview: boolean) => {
    if (preview) {
      if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
      const baseline = dragBaseline.current;
      pendingGesture.current = () => {
        void commitFromBaseline(baseline, patch);
      };
      void patchDoc(patch, { history: false });
      return;
    }
    const baseline = dragBaseline.current;
    pendingGesture.current = null;
    dragBaseline.current = null;
    if (baseline) void commitFromBaseline(baseline, patch);
    else void patchDoc(patch, { history });
  };

  const patchDevice = (mutate: DeviceMutation, history: string, preview = false) => {
    if (settingsDisabled) return;
    patchWithGesture((next) => mutateDocDevice(next, device.id, mutate), history, preview);
  };

  const duplicate = () => {
    if (duplicateDisabled) return;
    if (onDuplicate) {
      onDuplicate(device.id);
      return;
    }
    void duplicateFirstClassDevice(patchDocResult, device.id, onSelectDevice);
  };

  const remove = () => {
    if (removeDisabled) return;
    if (onRemove) {
      onRemove(device.id);
      return;
    }
    void removeFirstClassDevice(patchDocResult, device.id).then((result) => {
      if (!result.succeeded) return;
      if (result.nextDeviceId) onSelectDevice(result.nextDeviceId);
      else if (onDeviceRemoved) onDeviceRemoved();
      else onBack();
    });
  };

  const selectAdjacentDevice = (direction: "previous" | "next", index: number) => {
    const candidate = devices[index];
    if (!candidate) return;
    pendingNavigationFocus.current = direction;
    onSelectDevice(candidate.id);
  };

  // The device track is one per scene, so its toggle reveals the lane rather than editing this device; a scene that already carries keys always shows it.
  const keyframesOn = trackOpen || doc.deviceTrack !== undefined;
  const setKeyframesOn = (on: boolean) => {
    if (settingsDisabled) return;
    useDeviceTrackEditStore.getState().setOpen(on);
    if (!on && doc.deviceTrack !== undefined) {
      void patchDoc(
        (next) => {
          delete next.deviceTrack;
        },
        { history: "device keyframes off" },
      );
    }
  };

  // The After side edits the narrow `compare.b` surface: finish, shadow and screen media. Model, arrangement, position, motion and lid stay shared, so they only render for Before.
  const side = comparison ? activeCompareSide(doc, comparison.side) : "a";
  const after = side === "b";
  const routing = deviceSideRouting(doc, device.id, side);
  const coverRouting = deviceSideRouting(doc, device.id, side, "cover");
  const setAppearance = (
    field: "colour" | "shadow",
    value: string | DeviceShadowMode | undefined,
  ) => {
    if (settingsDisabled) return;
    void patchDoc((next) => setCompareDeviceAppearance(next, device.id, field, value), {
      history: `after device ${field === "colour" ? "finish" : "shadow"}`,
    });
  };
  const setFinish = (value: string) => {
    if (after) {
      setAppearance("colour", value);
      return;
    }
    patchDevice((_next, candidate) => {
      candidate.colour = value;
    }, "device finish");
  };
  const setShadow = (value: DeviceShadowMode) => {
    if (after) {
      setAppearance("shadow", value);
      return;
    }
    patchDevice((_next, candidate) => {
      candidate.shadow = value;
    }, "device shadow");
  };
  const matchBefore = () => {
    if (settingsDisabled) return;
    void patchDoc(
      (next) => {
        setCompareDeviceAppearance(next, device.id, "colour", undefined);
        setCompareDeviceAppearance(next, device.id, "shadow", undefined);
      },
      { history: "match the before side" },
    );
  };

  // Screen video start delay: seconds in the UI, `startMs` in the doc (0 deletes the field). After writes its own `compare.b` override, materialising an inherited spec first.
  const patchScreenVideo = (
    screen: DeviceScreenSlot,
    apply: (spec: DeviceMediaSpec) => DeviceMediaSpec,
    history: string,
    preview: boolean,
  ) => {
    if (settingsDisabled) return;
    const base = (screen === "cover" ? coverRouting : routing).media;
    if (base?.kind !== "video") return;
    const patch = after
      ? (next: SceneDoc) =>
          setCompareSlotMedia(
            next,
            device.id,
            screen,
            apply(compareSlotMedia(next, device.id, screen) ?? base),
          )
      : (next: SceneDoc) =>
          mutateDocDevice(next, device.id, (_next, candidate) => {
            const own = deviceSlotMedia(candidate, screen);
            if (own?.kind === "video") setDeviceSlotMedia(candidate, screen, apply(own));
          });
    patchWithGesture(patch, history, preview);
  };
  const setScreenDelay = (seconds: number, preview = false, screen: DeviceScreenSlot = "main") => {
    const startMs = Math.max(0, Math.round(seconds * 1000));
    patchScreenVideo(
      screen,
      (spec) => {
        const media = { ...spec };
        if (startMs === 0) delete media.startMs;
        else media.startMs = startMs;
        return media;
      },
      "screen start delay",
      preview,
    );
  };
  // The inside video begins as the fold opens; its Start delay then counts from that moment.
  const setStartOnOpen = (on: boolean) =>
    patchScreenVideo(
      "main",
      (spec) => {
        const media = { ...spec };
        if (on) media.startOn = "open";
        else delete media.startOn;
        return media;
      },
      "screen start",
      false,
    );

  const modelId: DeviceId = resolveAvailableDeviceId(device.model);
  const model = DEVICE_CATALOG[modelId];

  // Fold edits land where the scene reads the angle: the key nearest the playhead once devices are keyframed, else the device itself.
  const foldLocalMs = () =>
    slot
      ? Math.min(slot.durationMs, Math.max(0, useClockStore.getState().currentMs - slot.startMs))
      : 0;
  const foldDeg = model.fold
    ? foldDegEditing(doc, device.id, foldLocalMs(), model.fold.defaultDeg)
    : 0;
  const setFold = (value: number, preview = false) => {
    if (settingsDisabled) return;
    const at = foldLocalMs();
    setFoldNotice(null);
    patchWithGesture(
      (next) => writeFoldDeg(next, device.id, value, at),
      "device fold angle",
      preview,
    );
  };
  const animateFold = (direction: "unfold" | "fold") => {
    if (settingsDisabled || !model.fold || !slot) return;
    const at = foldLocalMs();
    const { openDeg } = model.fold;
    const add = (next: SceneDoc) =>
      addFoldAnimation(next, device.id, direction, at, slot.durationMs, openDeg);
    // Probed on a copy first, so a refusal says why instead of silently doing nothing.
    if (!add(structuredClone(doc))) {
      setFoldNotice("No room here. Move the playhead clear of the existing animation.");
      return;
    }
    setFoldNotice(null);
    void patchDoc((next) => void add(next), {
      history: direction === "unfold" ? "unfold device" : "fold device",
    });
    useDeviceTrackEditStore.getState().setOpen(true);
  };
  const applyFoldPose = (pose: (typeof FOLD_POSES)[number]) => {
    if (settingsDisabled) return;
    const at = foldLocalMs();
    void patchDoc(
      (next) => {
        setDeviceRotationPose(next, device.id, pose.rotationDeg);
        writeFoldDeg(next, device.id, pose.foldDeg, at);
        mutateDocDevice(next, device.id, (_next, candidate) =>
          setFoldPoseScreens(candidate, pose.bothScreensOn === true),
        );
      },
      { history: "device pose" },
    );
  };
  // Defaults are never written: a field at its default is removed, and an emptied block goes with it.
  const transition = resolveFoldTransition(device.foldTransition);
  const bothScreensOn = device.bothScreensOn === true;
  const setTransition = (
    field: "enabled" | "intensity" | "blur" | "darken" | "switchDeg",
    value: number | boolean,
    preview = false,
  ) =>
    patchDevice(
      (_next, candidate) => {
        const block: Record<string, number | boolean> = { ...candidate.foldTransition };
        const atDefault =
          field === "enabled"
            ? value === true
            : field === "switchDeg"
              ? value === FOLD_SWITCH_DEG
              : value === 1;
        if (atDefault) delete block[field];
        else block[field] = value;
        if (Object.keys(block).length === 0) delete candidate.foldTransition;
        else candidate.foldTransition = block;
      },
      "device screen transition",
      preview,
    );
  const setBothScreensOn = (on: boolean) =>
    patchDevice((_next, candidate) => setFoldPoseScreens(candidate, on), "device screens");
  const colour = compatibleDeviceColour(modelId, routing.colour);
  const customFinish = customColourHex(colour);
  const finishName = customFinish
    ? "Custom"
    : (model.colours.find((finish) => finish.id === colour)?.name ??
      model.colours.find((finish) => finish.id === model.defaultColour)?.name ??
      "Default");
  const previewSrc = model.previews[colour] ?? model.previews[model.defaultColour];
  // One media group per display: a foldable names its two, every other device keeps the single "Screen".
  const screenGroups = (model.coverScreen ? DEVICE_SCREEN_SLOTS : (["main"] as const)).map(
    (screen) => {
      const cover = screen === "cover";
      const sideRouting = cover ? coverRouting : routing;
      const media = sideRouting.media;
      const probed = cover ? coverMediaDetail : screenMediaDetail;
      return {
        screen,
        routing: sideRouting,
        label: model.coverScreen ? (cover ? "Outside screen" : "Inside screen") : "Screen",
        previewUrl: cover ? coverMediaPreviewUrl : screenMediaPreviewUrl,
        aspectRatio: cover ? coverMediaAspectRatio : screenMediaAspectRatio,
        name: media ? fileName(media.src) : "No screen media",
        detail: [
          sideRouting.inheritsMedia && media ? "Same as before" : undefined,
          probed ??
            (media ? (media.kind === "video" ? "Video" : "Image") : "Choose an image or video"),
        ]
          .filter(Boolean)
          .join(" · "),
      };
    },
  );
  const layout = doc.deviceLayout;
  const delta = layout?.devices?.[device.id];
  const position = layout ? (delta?.offset ?? ZERO) : (device.placement?.position ?? ZERO);
  const rotation = layout ? (delta?.rotationDeg ?? ZERO) : (device.placement?.rotationDeg ?? ZERO);
  const scale = layout ? (delta?.scale ?? 1) : (device.placement?.scale ?? 1);
  const arrangementLabel = layout ? LAYOUT_LABELS[layout.preset] : "Free position";

  return (
    <div className="inspector-drill device-editor-drill">
      <DrillBack
        label={backLabel}
        title="Device"
        onClick={onBack}
        actions={
          <>
            <DrillHeaderAction
              kind="duplicate"
              label="Duplicate device"
              disabled={duplicateDisabled}
              onClick={duplicate}
            />
            <DrillHeaderAction
              kind="remove"
              label="Remove device"
              disabled={removeDisabled}
              onClick={remove}
            />
          </>
        }
      />
      <div className="inspector-scene-head device-editor-identity">
        <div className="inspector-scene-id">
          <div className="inspector-scene-title">{model.name}</div>
          <div className="inspector-scene-sub">
            Device {deviceIndex + 1} of {devices.length}
          </div>
        </div>
        <div className="wizard-presets device-editor-navigation">
          <button
            ref={previousDeviceButtonRef}
            type="button"
            className="chip"
            aria-label="Previous device"
            title="Previous device"
            disabled={deviceIndex <= 0}
            onClick={() => selectAdjacentDevice("previous", deviceIndex - 1)}
          >
            <NavigationIcon direction="previous" />
          </button>
          <button
            ref={nextDeviceButtonRef}
            type="button"
            className="chip"
            aria-label="Next device"
            title="Next device"
            disabled={deviceIndex >= devices.length - 1}
            onClick={() => selectAdjacentDevice("next", deviceIndex + 1)}
          >
            <NavigationIcon direction="next" />
          </button>
        </div>
      </div>

      <div className="inspector-drill-body inspector-section-body device-editor-body">
        {comparison && <CompareSideSelector value={side} onChange={comparison.onSideChange} />}
        {notice != null && <div className="inspector-stub-note device-editor-notice">{notice}</div>}
        <section className="device-editor-preview-card" aria-label="Device preview and finish">
          <div className="device-editor-preview">
            <img src={previewSrc} alt={`${model.name}, ${finishName}`} draggable={false} />
            <span className="device-editor-finish-name">{finishName}</span>
          </div>
          <fieldset
            className="device-editor-finishes"
            aria-label={after ? "After device finish" : "Device finish"}
          >
            <span className="device-editor-finishes-label">Finish</span>
            {model.colours.map((finish) => (
              <button
                key={finish.id}
                type="button"
                className={`device-editor-finish-swatch${colour === finish.id ? " selected" : ""}`}
                style={{ background: finish.swatch }}
                aria-label={finish.name}
                aria-pressed={colour === finish.id}
                title={finish.name}
                disabled={settingsDisabled}
                onClick={() => setFinish(finish.id)}
              />
            ))}
            <span className={`device-editor-custom-finish${customFinish ? " selected" : ""}`}>
              <ColourPicker
                value={customFinish ?? "#8a93a6"}
                label="Custom finish"
                pressed={customFinish !== undefined}
                disabled={settingsDisabled}
                onCommit={(hex) => setFinish(CUSTOM_COLOUR_PREFIX + hex.toLowerCase())}
              />
            </span>
          </fieldset>
          {after ? (
            routing.overridesAppearance && (
              <button
                type="button"
                className="device-editor-change-device"
                disabled={settingsDisabled}
                onClick={matchBefore}
              >
                <ComparisonSideIcon side="before" size={16} />
                <span>Match the before side</span>
              </button>
            )
          ) : (
            <button
              type="button"
              className="device-editor-change-device"
              disabled={settingsDisabled}
              onClick={() => onChangeDevice(device.id)}
            >
              <DeviceGlyph />
              <span>Change device</span>
              <ChevronIcon />
            </button>
          )}
        </section>

        {screenGroups.map((group) => (
          <MediaSourceGroup
            key={group.screen}
            label={group.label}
            previewUrl={group.previewUrl}
            aspectRatio={group.aspectRatio}
            name={group.name}
            detail={group.detail}
            disabled={settingsDisabled}
            editDisabled={!group.routing.editVideoTarget}
            onChange={() => onChangeScreenMedia(device.id, group.screen)}
            onEdit={
              onEditScreenMedia ? () => onEditScreenMedia(device.id, group.screen) : undefined
            }
          >
            {group.routing.media?.kind === "video" && (
              <InspectorSliderRow
                icon={<DeviceControlIcon type="delay" />}
                label="Start delay"
                value={(group.routing.media.startMs ?? 0) / 1000}
                min={0}
                max={10}
                step={0.1}
                overflowMax
                formatValue={(v) => `${Number(v.toFixed(2))}s`}
                disabled={settingsDisabled}
                onInput={(value) => setScreenDelay(value, true, group.screen)}
                onCommit={(value) => setScreenDelay(value, false, group.screen)}
              />
            )}
            {model.fold && group.screen === "main" && group.routing.media?.kind === "video" && (
              <ToggleRow
                icon={<FoldGlyph kind="unfold" />}
                label="Start when opened"
                description="Plays from the moment the fold opens. Start delay then counts from there."
                checked={group.routing.media.startOn === "open"}
                disabled={settingsDisabled}
                onChange={setStartOnOpen}
              />
            )}
          </MediaSourceGroup>
        ))}

        {!after && model.fold && (
          <DrillGroup
            label="Fold"
            hint={
              foldKeyed
                ? "Edits the keyframe nearest the playhead."
                : "Unfold and Fold add an animation at the playhead."
            }
          >
            <SegmentedRow
              ariaLabel="Fold pose"
              options={FOLD_PRESET_OPTIONS}
              value={FOLD_PRESETS.find((preset) => preset.deg === foldDeg)?.id ?? "custom"}
              disabled={settingsDisabled}
              onChange={(id) => {
                const preset = FOLD_PRESETS.find((candidate) => candidate.id === id);
                if (preset) setFold(preset.deg);
              }}
            />
            <InspectorSliderRow
              icon={<DeviceControlIcon type="fold" />}
              label="Fold angle"
              value={foldDeg}
              min={0}
              max={model.fold.openDeg}
              step={1}
              formatValue={(v) => `${Math.round(v)}°`}
              disabled={settingsDisabled}
              onInput={(value) => setFold(value, true)}
              onCommit={(value) => setFold(value)}
            />
            <ActionRow
              icon={<FoldGlyph kind="unfold" />}
              label="Unfold"
              value="Closed to open"
              chevron={false}
              disabled={settingsDisabled || !slot}
              onClick={() => animateFold("unfold")}
            />
            <ActionRow
              icon={<FoldGlyph kind="fold" />}
              label="Fold"
              value="Open to closed"
              chevron={false}
              disabled={settingsDisabled || !slot}
              onClick={() => animateFold("fold")}
            />
            {foldNotice && <span className="drill-group-hint">{foldNotice}</span>}
            <fieldset className="device-editor-pose-grid">
              <legend className="visually-hidden">Foldable pose</legend>
              {FOLD_POSES.map((pose) => {
                const selected = sameVector(rotation, pose.rotationDeg) && foldDeg === pose.foldDeg;
                return (
                  <button
                    key={pose.id}
                    type="button"
                    className={`device-editor-pose-choice${selected ? " selected" : ""}`}
                    aria-pressed={selected}
                    disabled={settingsDisabled}
                    onClick={() => applyFoldPose(pose)}
                  >
                    <FoldGlyph kind={pose.id} />
                    <span>{pose.label}</span>
                  </button>
                );
              })}
            </fieldset>
            <ToggleRow
              icon={<FoldGlyph kind="both" />}
              label="Keep both screens on"
              description="Lights the outside and inside displays at every angle, instead of handing over as it opens. Turns off the blur between screens."
              checked={bothScreensOn}
              disabled={settingsDisabled}
              onChange={setBothScreensOn}
            />
          </DrillGroup>
        )}

        {!after && model.fold && (
          <DrillGroup
            label="Screen transition"
            hint="Follows the fold angle, so any fold animation gets it."
          >
            <ToggleRow
              icon={<FoldGlyph kind="transition" />}
              label="Blur between screens"
              description={
                bothScreensOn
                  ? "Off while Keep both screens on is set: with both displays lit there is no handover to blur."
                  : "Blurs and dims the interface off the outside screen and clears it across the inside one as the device opens."
              }
              checked={transition.enabled && !bothScreensOn}
              disabled={settingsDisabled || bothScreensOn}
              onChange={(on) => setTransition("enabled", on)}
            />
            {transition.enabled &&
              !bothScreensOn &&
              (
                [
                  ["intensity", "Intensity", "intensity"],
                  ["blur", "Blur amount", "blur"],
                  ["darken", "Darkening", "darken"],
                ] as const
              ).map(([field, label, glyph]) => (
                <InspectorSliderRow
                  key={field}
                  icon={<FoldGlyph kind={glyph} />}
                  label={label}
                  value={Math.round(transition[field] * 100)}
                  min={0}
                  max={100}
                  step={1}
                  formatValue={(v) => `${Math.round(v)}%`}
                  disabled={settingsDisabled}
                  onInput={(value) => setTransition(field, value / 100, true)}
                  onCommit={(value) => setTransition(field, value / 100)}
                />
              ))}
            <InspectorSliderRow
              icon={<FoldGlyph kind="switch" />}
              label="Switch angle"
              value={transition.switchDeg}
              min={FOLD_POWER_WINDOW_DEG}
              max={180 - FOLD_POWER_WINDOW_DEG}
              step={1}
              formatValue={(v) => `${Math.round(v)}°`}
              disabled={settingsDisabled}
              onInput={(value) => setTransition("switchDeg", value, true)}
              onCommit={(value) => setTransition("switchDeg", value)}
            />
          </DrillGroup>
        )}

        {!after && (
          <DrillGroup label="Arrangement">
            <button
              type="button"
              className="device-editor-arrangement-row"
              disabled={settingsDisabled}
              onClick={() => onOpenArrangement(device.id)}
            >
              <ArrangementIcon />
              <span className="device-editor-arrangement-copy">
                <span>{arrangementLabel}</span>
                <span>
                  {devices.length === 1
                    ? "Positions this device"
                    : `Arranges all ${devices.length} devices`}
                </span>
              </span>
              <ChevronIcon />
            </button>
          </DrillGroup>
        )}

        <fieldset className="device-editor-settings" disabled={settingsDisabled}>
          <legend className="visually-hidden">Device settings</legend>
          {!after && (
            <DrillGroup label="Position">
              <SegmentedRow
                ariaLabel="Device transform"
                options={GIZMO_OPTIONS}
                value={gizmoMode}
                onChange={(mode) => useDeviceEditStore.getState().setGizmoMode(mode)}
                className="device-editor-transform-modes"
              />
              <span className="drill-group-hint">
                Drag the gizmo in the preview, or set values here.
              </span>
              <div className="device-editor-transform-controls">
                {gizmoMode === "translate" &&
                  (["Left-right", "Up-down", "Depth"] as const).map((label, axis) => (
                    <InspectorSliderRow
                      key={label}
                      icon={
                        <DeviceControlIcon type={axis === 0 ? "x" : axis === 1 ? "y" : "depth"} />
                      }
                      label={label}
                      value={position[axis]}
                      min={axis === 0 ? -3 : axis === 1 ? -1.5 : -2}
                      max={axis === 0 ? 3 : axis === 1 ? 1.5 : 2}
                      step={0.01}
                      overflowMin
                      overflowMax
                      onInput={(value) =>
                        patchDevice(
                          (next, candidate) =>
                            setPositionAxis(next, candidate, axis as DeviceAxis, value),
                          "device position",
                          true,
                        )
                      }
                      onCommit={(value) =>
                        patchDevice(
                          (next, candidate) =>
                            setPositionAxis(next, candidate, axis as DeviceAxis, value),
                          "device position",
                        )
                      }
                    />
                  ))}
                {gizmoMode === "rotate" && (
                  <>
                    <fieldset className="device-editor-pose-grid">
                      <legend className="visually-hidden">Visual pose</legend>
                      {DEVICE_POSES.map((pose) => {
                        const selected = sameVector(rotation, pose.rotationDeg);
                        return (
                          <button
                            key={pose.id}
                            type="button"
                            className={`device-editor-pose-choice${selected ? " selected" : ""}`}
                            aria-pressed={selected}
                            onClick={() =>
                              void patchDoc(
                                (next) => setDeviceRotationPose(next, device.id, pose.rotationDeg),
                                { history: "device pose" },
                              )
                            }
                          >
                            <DevicePoseIcon pose={pose.id} />
                            <span>{pose.label}</span>
                          </button>
                        );
                      })}
                    </fieldset>
                    {(["Tilt", "Turn", "Roll"] as const).map((label, axis) => (
                      <InspectorSliderRow
                        key={label}
                        icon={
                          <DeviceControlIcon
                            type={axis === 0 ? "tilt" : axis === 1 ? "turn" : "roll"}
                          />
                        }
                        label={label}
                        value={rotation[axis]}
                        min={-180}
                        max={180}
                        step={1}
                        onInput={(value) =>
                          patchDevice(
                            (next, candidate) =>
                              setRotationAxis(next, candidate, axis as DeviceAxis, value),
                            "device rotation",
                            true,
                          )
                        }
                        onCommit={(value) =>
                          patchDevice(
                            (next, candidate) =>
                              setRotationAxis(next, candidate, axis as DeviceAxis, value),
                            "device rotation",
                          )
                        }
                      />
                    ))}
                  </>
                )}
                {gizmoMode === "scale" && (
                  <InspectorSliderRow
                    icon={<DeviceControlIcon type="size" />}
                    label="Size"
                    value={scale}
                    min={0.25}
                    max={2}
                    step={0.01}
                    onInput={(value) =>
                      patchDevice(
                        (next, candidate) => setScale(next, candidate, value),
                        "device size",
                        true,
                      )
                    }
                    onCommit={(value) =>
                      patchDevice(
                        (next, candidate) => setScale(next, candidate, value),
                        "device size",
                      )
                    }
                  />
                )}
              </div>
              <ToggleRow
                label="Rest on floor"
                description="Sits the device on the staged floor. No effect without one."
                checked={device.placement?.ground ?? false}
                onChange={(checked) =>
                  patchDevice((_next, candidate) => {
                    candidate.placement = { ...candidate.placement };
                    if (checked) candidate.placement.ground = true;
                    else delete candidate.placement.ground;
                  }, "device floor placement")
                }
              />
              <button
                type="button"
                className="btn device-editor-reset-position"
                onClick={() =>
                  patchDevice(
                    (next, candidate) => resetTransform(next, candidate),
                    "reset device position",
                  )
                }
              >
                Reset position
              </button>
              {model.lid && (
                <InspectorSliderRow
                  icon={<DeviceControlIcon type="lid" />}
                  label="Lid angle"
                  value={device.lidDeg ?? model.lid.defaultDeg}
                  min={0}
                  max={model.lid.openDeg}
                  step={1}
                  onInput={(value) =>
                    patchDevice(
                      (_next, candidate) => {
                        candidate.lidDeg = value;
                      },
                      "device lid angle",
                      true,
                    )
                  }
                  onCommit={(value) =>
                    patchDevice((_next, candidate) => {
                      candidate.lidDeg = value;
                    }, "device lid angle")
                  }
                />
              )}
            </DrillGroup>
          )}

          {!after && (
            <DrillGroup label="Motion">
              <fieldset className="device-editor-motion-list">
                <legend className="visually-hidden">Motion</legend>
                {DEVICE_MOTIONS.map((motion) => {
                  const selected = (device.motion?.preset ?? "none") === motion.id;
                  return (
                    <button
                      type="button"
                      key={motion.id}
                      aria-pressed={selected}
                      className={`device-editor-motion-choice${selected ? " selected" : ""}`}
                      onClick={() =>
                        patchDevice((_next, candidate) => {
                          candidate.motion = { ...candidate.motion, preset: motion.id };
                        }, "device motion")
                      }
                    >
                      <DeviceMotionIcon preset={motion.id} />
                      <span>{motion.label}</span>
                    </button>
                  );
                })}
              </fieldset>
              <span className="drill-group-hint">
                Moves the device itself. For a cinematic move, animate the Camera instead.
              </span>
              <ToggleRow
                icon={<KeyframeIcon />}
                label="Keyframes"
                description="Opens the Devices lane, where keys move every device in the scene. The preset above still plays on top."
                checked={keyframesOn}
                onChange={setKeyframesOn}
              />
            </DrillGroup>
          )}

          <DrillGroup label="Shadow">
            <fieldset className="option-grid device-editor-shadow-grid">
              <legend className="visually-hidden">
                {after ? "After device shadow" : "Device shadow"}
              </legend>
              {DEVICE_SHADOWS.map((shadow) => (
                <OptionCard
                  key={shadow.id}
                  label={shadow.label}
                  image={optionPreviewStill(`shadow-${shadow.id}`)}
                  selected={effectiveDeviceShadowMode(routing.shadow) === shadow.id}
                  onSelect={() => setShadow(shadow.id)}
                />
              ))}
            </fieldset>
          </DrillGroup>
        </fieldset>
      </div>
    </div>
  );
}

export function DeviceModelDrillIn({
  model,
  deviceCount = 1,
  deviceLabel,
  onBack,
  backLabel = "Scene",
  onSelectModel,
}: DeviceModelDrillInProps) {
  const [applyAll, setApplyAll] = useState(true);
  return (
    <div className="inspector-drill">
      <DrillBack label={backLabel} title="Change device" onClick={onBack} />
      <div className="inspector-drill-body">
        {deviceCount > 1 && (
          <fieldset
            className="wizard-presets device-model-apply-group"
            aria-label="Apply device model to"
          >
            {[
              { all: true, label: "All devices" },
              { all: false, label: deviceLabel ?? "This device" },
            ].map((option) => (
              <button
                type="button"
                key={option.label}
                aria-pressed={applyAll === option.all}
                className={`chip${applyAll === option.all ? " selected" : ""}`}
                onClick={() => setApplyAll(option.all)}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
        )}
        <fieldset className="inspector-device-switcher" aria-label="Device model">
          {AVAILABLE_DEVICE_IDS.map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={model === id}
              title={DEVICE_CATALOG[id].name}
              className={`inspector-device-switch${model === id ? " selected" : ""}`}
              disabled={model === id && (deviceCount === 1 || !applyAll)}
              onClick={() => onSelectModel(id, deviceCount > 1 && applyAll)}
            >
              <span className="inspector-device-switch-preview">
                <img
                  src={DEVICE_CATALOG[id].previews[DEVICE_CATALOG[id].defaultColour]}
                  alt=""
                  draggable={false}
                />
              </span>
              <span className="inspector-device-switch-name">{DEVICE_CATALOG[id].name}</span>
            </button>
          ))}
        </fieldset>
        <p className="modal-hint">
          Pick a model to apply it immediately. Finish and motion stay in the Device editor.
        </p>
      </div>
    </div>
  );
}
