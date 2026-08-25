import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDeviceEditStore } from "../../engine/deviceEditStore";
import { useDeviceTrackEditStore } from "../../engine/deviceTrackEditStore";
import { optionPreviewStill } from "../../engine/optionPreviews";
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
import { MediaSourceGroup } from "./MediaSourceGroup";
import {
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
  comparison?: DeviceComparisonProps;
  settingsDisabled?: boolean;
  duplicateDisabled?: boolean;
  removeDisabled?: boolean;
  notice?: ReactNode;
  onBack: () => void;
  onSelectDevice: (deviceId: string) => void;
  onChangeDevice: (deviceId: string) => void;
  onChangeScreenMedia: (deviceId: string) => void;
  onEditScreenMedia?: (deviceId: string) => void;
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
  type: "x" | "y" | "depth" | "tilt" | "turn" | "roll" | "size" | "lid" | "delay";
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
  comparison,
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

  // Screen video start delay: seconds in the UI, `media.startMs` in the doc (0 deletes the field). After writes its own `compare.b.media` override, materialising an inherited spec first.
  const setScreenDelay = (seconds: number, preview = false) => {
    if (settingsDisabled) return;
    const base = routing.media;
    if (base?.kind !== "video") return;
    const startMs = Math.max(0, Math.round(seconds * 1000));
    const apply = (spec: DeviceMediaSpec): DeviceMediaSpec => {
      const media = { ...spec };
      if (startMs === 0) delete media.startMs;
      else media.startMs = startMs;
      return media;
    };
    const patch = after
      ? (next: SceneDoc) => {
          if (!next.compare) return;
          next.compare.b ??= {};
          next.compare.b.media ??= {};
          next.compare.b.media[device.id] = apply(next.compare.b.media[device.id] ?? base);
        }
      : (next: SceneDoc) =>
          mutateDocDevice(next, device.id, (_next, candidate) => {
            if (candidate.media?.kind === "video") candidate.media = apply(candidate.media);
          });
    patchWithGesture(patch, "screen start delay", preview);
  };

  const modelId: DeviceId = resolveAvailableDeviceId(device.model);
  const model = DEVICE_CATALOG[modelId];
  const colour = compatibleDeviceColour(modelId, routing.colour);
  const customFinish = customColourHex(colour);
  const finishName = customFinish
    ? "Custom"
    : (model.colours.find((finish) => finish.id === colour)?.name ??
      model.colours.find((finish) => finish.id === model.defaultColour)?.name ??
      "Default");
  const previewSrc = model.previews[colour] ?? model.previews[model.defaultColour];
  const mediaName = routing.media ? fileName(routing.media.src) : "No screen media";
  const mediaDetail = [
    routing.inheritsMedia && routing.media ? "Same as before" : undefined,
    screenMediaDetail ??
      (routing.media
        ? routing.media.kind === "video"
          ? "Video"
          : "Image"
        : "Choose an image or video"),
  ]
    .filter(Boolean)
    .join(" · ");
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

        <MediaSourceGroup
          label="Screen"
          previewUrl={screenMediaPreviewUrl}
          aspectRatio={screenMediaAspectRatio}
          name={mediaName}
          detail={mediaDetail}
          disabled={settingsDisabled}
          editDisabled={!routing.editVideoTarget}
          onChange={() => onChangeScreenMedia(device.id)}
          onEdit={onEditScreenMedia ? () => onEditScreenMedia(device.id) : undefined}
        >
          {routing.media?.kind === "video" && (
            <InspectorSliderRow
              icon={<DeviceControlIcon type="delay" />}
              label="Start delay"
              value={(routing.media.startMs ?? 0) / 1000}
              min={0}
              max={10}
              step={0.1}
              overflowMax
              formatValue={(v) => `${Number(v.toFixed(2))}s`}
              disabled={settingsDisabled}
              onInput={(value) => setScreenDelay(value, true)}
              onCommit={(value) => setScreenDelay(value)}
            />
          )}
        </MediaSourceGroup>

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
