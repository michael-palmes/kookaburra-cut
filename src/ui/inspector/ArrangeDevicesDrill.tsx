import { useEffect, useRef } from "react";
import type {
  DeviceLayoutPreset,
  SceneDoc,
  SceneDocDeviceLayoutDelta,
} from "../../engine/sceneDocSchema";
import { DEVICE_LAYOUT_PRESETS } from "../../engine/sceneDocSchema";
import { DEVICE_CATALOG, isDeviceId } from "../../toolkit/device/catalog";
import type { DevicePlacement } from "../../toolkit/device/Device";
import type { V3 } from "../../toolkit/types";
import {
  replaceDeviceLayoutPreset,
  resetAllDeviceLayoutDeltas,
  resetDeviceLayoutDelta,
} from "./deviceEditorModel";
import { DrillBack, DrillGroup, InspectorSliderRow } from "./rows";

export interface ArrangeDevicesDrillProps {
  doc: SceneDoc;
  sceneIdentity: string;
  selectedDeviceId: string | null;
  backLabel: string;
  onBack: () => void;
  onSelectDevice: (deviceId: string) => void;
  onOpenDevice: (deviceId: string) => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
}

interface ArrangeDragBaseline {
  sceneIdentity: string;
  doc: SceneDoc;
  patch: (next: SceneDoc) => void;
  commit: ArrangeDevicesDrillProps["commitFromBaseline"];
}

export function baselineForArrangeScene<T extends { sceneIdentity: string }>(
  baseline: T | null,
  sceneIdentity: string,
): T | null {
  return baseline?.sceneIdentity === sceneIdentity ? baseline : null;
}

const LAYOUT_LABELS: Record<DeviceLayoutPreset, string> = {
  row: "Row",
  "toe-in": "Toe-in",
  arc: "Arc",
  cascade: "Cascade",
  hero: "Hero",
  "depth-pair": "Depth",
};

function LayoutDiagram({ preset }: { preset: DeviceLayoutPreset }) {
  const glyph = {
    row: (
      <>
        <rect x="3.5" y="3" width="5" height="12" rx="1.5" opacity="0.6" />
        <rect x="11.5" y="3" width="5" height="12" rx="1.5" />
        <rect x="19.5" y="3" width="5" height="12" rx="1.5" opacity="0.6" />
      </>
    ),
    "toe-in": (
      <>
        <rect
          x="3.5"
          y="3"
          width="5"
          height="12"
          rx="1.5"
          transform="rotate(16 6 9)"
          opacity="0.6"
        />
        <rect x="11.5" y="3" width="5" height="12" rx="1.5" />
        <rect
          x="19.5"
          y="3"
          width="5"
          height="12"
          rx="1.5"
          transform="rotate(-16 22 9)"
          opacity="0.6"
        />
      </>
    ),
    arc: (
      <>
        <rect
          x="3.5"
          y="5"
          width="5"
          height="11"
          rx="1.5"
          transform="rotate(-10 6 10)"
          opacity="0.6"
        />
        <rect x="11.5" y="2.5" width="5" height="12" rx="1.5" />
        <rect
          x="19.5"
          y="5"
          width="5"
          height="11"
          rx="1.5"
          transform="rotate(10 22 10)"
          opacity="0.6"
        />
      </>
    ),
    cascade: (
      <>
        <rect x="3" y="6" width="6" height="11" rx="1.5" opacity="0.45" />
        <rect x="9.5" y="4" width="6" height="11" rx="1.5" opacity="0.7" />
        <rect x="16" y="2" width="6" height="11" rx="1.5" />
      </>
    ),
    hero: (
      <>
        <rect x="3.5" y="5.5" width="4.5" height="9" rx="1.4" opacity="0.5" />
        <rect x="20" y="5.5" width="4.5" height="9" rx="1.4" opacity="0.5" />
        <rect x="10" y="2" width="8" height="14" rx="1.8" />
      </>
    ),
    "depth-pair": (
      <>
        <rect x="2.5" y="2" width="6.5" height="14" rx="1.6" />
        <rect x="11" y="4" width="5.2" height="11" rx="1.4" opacity="0.7" />
        <rect x="18.5" y="5.5" width="4" height="8.5" rx="1.2" opacity="0.45" />
      </>
    ),
  }[preset];
  return (
    <svg
      className="arrange-layout-diagram"
      width="28"
      height="18"
      viewBox="0 0 28 18"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

function DeviceThumbnail({ model }: { model: string }) {
  const form = isDeviceId(model) ? DEVICE_CATALOG[model].form : "phone";
  return (
    <svg
      className={`arrange-device-thumbnail arrange-device-thumbnail-${form}`}
      width="34"
      height="34"
      viewBox="0 0 36 36"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      {form === "laptop" ? (
        <>
          <rect x="6" y="7" width="24" height="17" rx="2" />
          <path d="M3.5 27h29l-2.5 2H6z" />
        </>
      ) : form === "tablet" ? (
        <rect x="8" y="3" width="20" height="30" rx="3" />
      ) : (
        <>
          <rect x="11" y="2" width="14" height="32" rx="3" />
          <path d="M16 5h4" />
        </>
      )}
    </svg>
  );
}

function ControlIcon({ type }: { type: "gap" | "x" | "y" | "z" | "size" }) {
  const glyph = {
    gap: (
      <path d="M3.2 3.2v9.6M12.8 3.2v9.6M6 8h4M6 8l1.5-1.5M6 8l1.5 1.5M10 8 8.5 6.5M10 8l-1.5 1.5" />
    ),
    x: <path d="M2.6 8h10.8M4.8 5.8 2.6 8l2.2 2.2M11.2 5.8 13.4 8l-2.2 2.2" />,
    y: <path d="M8 2.6v10.8M5.8 4.8 8 2.6l2.2 2.2M5.8 11.2 8 13.4l2.2-2.2" />,
    z: (
      <>
        <rect x="8.2" y="2.4" width="5.4" height="5.4" rx="1" />
        <rect x="2.4" y="8.2" width="5.4" height="5.4" rx="1" />
        <path d="M8.2 7.8 7.8 8.2" />
      </>
    ),
    size: <path d="M3 9.6V13h3.4M13 6.4V3H9.6M3.2 12.8 7.4 8.6M12.8 3.2 8.6 7.4" />,
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

function mutatePlacement(
  next: SceneDoc,
  deviceId: string,
  mutate: (placement: DevicePlacement) => void,
) {
  const device = next.devices?.find((candidate) => candidate.id === deviceId);
  if (!device) return;
  const placement = { ...(device.placement ?? {}) };
  mutate(placement);
  device.placement = placement;
}

function mutateDelta(
  next: SceneDoc,
  deviceId: string,
  mutate: (delta: SceneDocDeviceLayoutDelta) => void,
) {
  if (!next.deviceLayout) return;
  const devices = { ...(next.deviceLayout.devices ?? {}) };
  const delta = { ...(devices[deviceId] ?? {}) };
  mutate(delta);
  devices[deviceId] = delta;
  next.deviceLayout = { ...next.deviceLayout, devices };
}

function setNudgeAxis(next: SceneDoc, deviceId: string, axis: 0 | 1 | 2, value: number) {
  if (next.deviceLayout) {
    mutateDelta(next, deviceId, (delta) => {
      const offset: V3 = [...(delta.offset ?? [0, 0, 0])];
      offset[axis] = value;
      delta.offset = offset;
    });
  } else {
    mutatePlacement(next, deviceId, (placement) => {
      const position: V3 = [...(placement.position ?? [0, 0, 0])];
      position[axis] = value;
      placement.position = position;
    });
  }
  if (axis === 1) {
    mutatePlacement(next, deviceId, (placement) => {
      delete placement.ground;
    });
  }
}

function setNudgeScale(next: SceneDoc, deviceId: string, value: number) {
  if (next.deviceLayout) {
    mutateDelta(next, deviceId, (delta) => {
      delta.scale = value;
    });
    return;
  }
  mutatePlacement(next, deviceId, (placement) => {
    placement.scale = value;
  });
}

export function ArrangeDevicesDrill({
  doc,
  sceneIdentity,
  selectedDeviceId,
  backLabel,
  onBack,
  onSelectDevice,
  onOpenDevice,
  patchDoc,
  commitFromBaseline,
}: ArrangeDevicesDrillProps) {
  const dragBaseline = useRef<ArrangeDragBaseline | null>(null);
  useEffect(() => {
    return () => {
      const baseline = baselineForArrangeScene(dragBaseline.current, sceneIdentity);
      if (!baseline) return;
      dragBaseline.current = null;
      void baseline.commit(baseline.doc, baseline.patch);
    };
  }, [sceneIdentity]);
  const devices = doc.devices ?? [];
  const selectedIndex = Math.max(
    0,
    devices.findIndex((device) => device.id === selectedDeviceId),
  );
  const selected = devices[selectedIndex];
  const layout = doc.deviceLayout;

  const live = (mutate: (next: SceneDoc) => void) => {
    const baseline = baselineForArrangeScene(dragBaseline.current, sceneIdentity);
    if (baseline) baseline.patch = mutate;
    else {
      dragBaseline.current = {
        sceneIdentity,
        doc: structuredClone(doc),
        patch: mutate,
        commit: commitFromBaseline,
      };
    }
    void patchDoc(mutate, { history: false });
  };
  const commit = (mutate: (next: SceneDoc) => void, history: string) => {
    const taggedBaseline = dragBaseline.current;
    const baseline = baselineForArrangeScene(taggedBaseline, sceneIdentity);
    dragBaseline.current = null;
    if (taggedBaseline && !baseline) return;
    if (baseline) void commitFromBaseline(baseline.doc, mutate);
    else void patchDoc(mutate, { history });
  };

  const selectedDelta = selected ? layout?.devices?.[selected.id] : undefined;
  const position = layout
    ? (selectedDelta?.offset ?? [0, 0, 0])
    : (selected?.placement?.position ?? [0, 0, 0]);
  const scale = layout ? (selectedDelta?.scale ?? 1) : (selected?.placement?.scale ?? 1);
  const selectedModelName = selected
    ? isDeviceId(selected.model)
      ? DEVICE_CATALOG[selected.model].name
      : selected.model
    : "";

  const resetDevice = () => {
    if (!selected) return;
    void patchDoc(
      (next) => {
        if (next.deviceLayout) {
          next.deviceLayout = resetDeviceLayoutDelta(next.deviceLayout, selected.id);
        } else {
          mutatePlacement(next, selected.id, (placement) => {
            placement.position = [0, 0, 0];
            placement.scale = 1;
          });
        }
      },
      { history: "reset device position" },
    );
  };

  const resetAll = () => {
    void patchDoc(
      (next) => {
        if (next.deviceLayout) {
          next.deviceLayout = resetAllDeviceLayoutDeltas(next.deviceLayout);
          return;
        }
        for (const device of next.devices ?? []) {
          const placement = { ...(device.placement ?? {}) };
          placement.position = [0, 0, 0];
          placement.scale = 1;
          device.placement = placement;
        }
      },
      { history: "reset all device positions" },
    );
  };

  return (
    <div className="inspector-drill arrange-devices-drill">
      <DrillBack label={backLabel} title="Arrange devices" onClick={onBack} />
      <div className="inspector-scene-head arrange-devices-summary">
        <div className="inspector-scene-id">
          <div className="inspector-scene-title">Arrange devices</div>
          <div className="inspector-scene-sub">
            {devices.length} {devices.length === 1 ? "device" : "devices"} in this scene
          </div>
        </div>
      </div>
      <div className="inspector-drill-body inspector-section-body arrange-devices-body">
        {devices.length > 1 && (
          <DrillGroup label="Layout">
            <fieldset
              className="bg-type-grid arrange-layout-grid"
              aria-label="Layout"
              style={{ minWidth: 0, margin: 0, padding: 0, border: 0 }}
            >
              {DEVICE_LAYOUT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`bg-type-tile arrange-layout-choice${layout?.preset === preset ? " selected" : ""}`}
                  aria-pressed={layout?.preset === preset}
                  onClick={() =>
                    void patchDoc(
                      (next) => {
                        next.deviceLayout = replaceDeviceLayoutPreset(next.deviceLayout, preset);
                      },
                      { history: "arrange devices" },
                    )
                  }
                >
                  <LayoutDiagram preset={preset} />
                  <span>{LAYOUT_LABELS[preset]}</span>
                </button>
              ))}
            </fieldset>
            <InspectorSliderRow
              key={`layout-gap:${sceneIdentity}`}
              icon={<ControlIcon type="gap" />}
              label="Gap"
              value={layout?.gap ?? 0.35}
              min={-0.5}
              max={2}
              step={0.01}
              onInput={(value) =>
                live((next) => {
                  const nextLayout = replaceDeviceLayoutPreset(
                    next.deviceLayout,
                    next.deviceLayout?.preset ?? "row",
                  );
                  nextLayout.gap = value;
                  next.deviceLayout = nextLayout;
                })
              }
              onCommit={(value) =>
                commit((next) => {
                  const nextLayout = replaceDeviceLayoutPreset(
                    next.deviceLayout,
                    next.deviceLayout?.preset ?? "row",
                  );
                  nextLayout.gap = value;
                  next.deviceLayout = nextLayout;
                }, "device layout gap")
              }
            />
          </DrillGroup>
        )}

        {selected && (
          <DrillGroup label="Nudge one device">
            <fieldset
              className="bg-type-grid arrange-device-picker"
              aria-label="Nudge device"
              style={{ minWidth: 0, margin: 0, padding: 0, border: 0 }}
            >
              {devices.map((device, index) => {
                const modelName = isDeviceId(device.model)
                  ? DEVICE_CATALOG[device.model].name
                  : device.model;
                return (
                  <button
                    key={device.id}
                    type="button"
                    className={`bg-type-tile arrange-device-choice${device.id === selected.id ? " selected" : ""}`}
                    aria-label={`Device ${index + 1}, ${modelName}`}
                    aria-pressed={device.id === selected.id}
                    onClick={() => onSelectDevice(device.id)}
                  >
                    <DeviceThumbnail model={device.model} />
                    <span>{index + 1}</span>
                  </button>
                );
              })}
            </fieldset>
            <div className="arrange-selected-device-label">
              Device {selectedIndex + 1} · {selectedModelName}
              {layout && <span> · offset from the layout</span>}
            </div>
            <div key={`nudges:${sceneIdentity}:${selected.id}`} className="arrange-device-sliders">
              <InspectorSliderRow
                icon={<ControlIcon type="x" />}
                label="Left-right"
                value={position[0]}
                min={-3}
                max={3}
                step={0.01}
                onInput={(value) => live((next) => setNudgeAxis(next, selected.id, 0, value))}
                onCommit={(value) =>
                  commit((next) => setNudgeAxis(next, selected.id, 0, value), "device position")
                }
              />
              <InspectorSliderRow
                icon={<ControlIcon type="y" />}
                label="Up-down"
                value={position[1]}
                min={-1.5}
                max={1.5}
                step={0.01}
                onInput={(value) => live((next) => setNudgeAxis(next, selected.id, 1, value))}
                onCommit={(value) =>
                  commit((next) => setNudgeAxis(next, selected.id, 1, value), "device position")
                }
              />
              <InspectorSliderRow
                icon={<ControlIcon type="z" />}
                label="Depth"
                value={position[2]}
                min={-2}
                max={2}
                step={0.01}
                onInput={(value) => live((next) => setNudgeAxis(next, selected.id, 2, value))}
                onCommit={(value) =>
                  commit((next) => setNudgeAxis(next, selected.id, 2, value), "device position")
                }
              />
              <InspectorSliderRow
                icon={<ControlIcon type="size" />}
                label="Size"
                value={scale}
                min={0.4}
                max={2}
                step={0.01}
                onInput={(value) => live((next) => setNudgeScale(next, selected.id, value))}
                onCommit={(value) =>
                  commit((next) => setNudgeScale(next, selected.id, value), "device size")
                }
              />
            </div>
            <div className="modal-actions arrange-device-actions">
              <button type="button" className="btn" onClick={() => onOpenDevice(selected.id)}>
                Open device
              </button>
              <button type="button" className="btn" onClick={resetDevice}>
                Reset device
              </button>
            </div>
          </DrillGroup>
        )}

        {devices.length > 0 && (
          <div className="arrange-reset-all">
            <button type="button" className="btn" onClick={resetAll}>
              Reset all positions
            </button>
            <span className="drill-group-hint">
              Layout and Gap are shared by every device. A nudge is stored per device and survives a
              layout change.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
