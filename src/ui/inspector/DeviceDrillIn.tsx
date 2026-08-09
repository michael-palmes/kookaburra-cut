import { useState } from "react";
import {
  AVAILABLE_DEVICE_IDS,
  CUSTOM_COLOUR_PREFIX,
  customColourHex,
  DEVICE_CATALOG,
  type DeviceId,
  resolveAvailableDeviceId,
} from "../../toolkit/device/catalog";
import type { DeviceMotionPreset } from "../../toolkit/device/Device";
import { ColourPicker } from "../colour/ColourPicker";
import { MOTION_OPTIONS } from "../SceneWizards";
import { useEscapeClose } from "../useEscapeClose";
import { DrillBack } from "./rows";

/** Change-device as an inspector drill-in: the EditBar modal's content (model switcher + catalog card + colour swatches + motion presets, applied on Save) re-laid for the 312px panel. With several devices the save targets all of them by default (the implicit link); switch the pill to change just the selected one, which is how mixed setups happen. */
export function DeviceDrillIn({
  model,
  colour,
  motion,
  deviceCount = 1,
  deviceLabel,
  onBack,
  backLabel = "Scene",
  onSave,
}: {
  model: DeviceId;
  colour: string;
  motion: DeviceMotionPreset;
  /** How many devices the scene has; more than one shows the apply-target pill. */
  deviceCount?: number;
  /** Short name for the selected device, e.g. "Device 2". */
  deviceLabel?: string;
  onBack: () => void;
  backLabel?: string;
  onSave: (
    model: DeviceId,
    colour: string,
    motion: DeviceMotionPreset,
    applyAll: boolean,
    deviceChoiceChanged: boolean,
  ) => void;
}) {
  const initialModel = resolveAvailableDeviceId(model);
  const [m, setM] = useState<DeviceId>(initialModel);
  const [c, setC] = useState(
    initialModel === model ? colour : DEVICE_CATALOG[initialModel].defaultColour,
  );
  const [mo, setMo] = useState<DeviceMotionPreset>(motion);
  const [applyAll, setApplyAll] = useState(true);
  const [deviceChoiceChanged, setDeviceChoiceChanged] = useState(false);
  useEscapeClose(onBack);
  const spec = DEVICE_CATALOG[m];
  return (
    <div className="inspector-drill">
      <DrillBack label={backLabel} onClick={onBack} />
      <div className="inspector-drill-title">Change device</div>
      <div className="inspector-drill-body">
        {deviceCount > 1 && (
          <div className="wizard-presets" role="radiogroup" aria-label="Apply to">
            {[
              { all: true, label: "All devices" },
              { all: false, label: deviceLabel ?? "This device" },
            ].map((o) => (
              <button
                type="button"
                key={o.label}
                aria-pressed={applyAll === o.all}
                className={`chip${applyAll === o.all ? " selected" : ""}`}
                onClick={() => setApplyAll(o.all)}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <div className="inspector-device-switcher" role="radiogroup" aria-label="Device model">
          {AVAILABLE_DEVICE_IDS.map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={m === id}
              title={DEVICE_CATALOG[id].name}
              className={`inspector-device-switch${m === id ? " selected" : ""}`}
              onClick={() => {
                setM(id);
                setC(id === model ? colour : DEVICE_CATALOG[id].defaultColour);
                setDeviceChoiceChanged(true);
              }}
            >
              <img
                src={DEVICE_CATALOG[id].previews[DEVICE_CATALOG[id].defaultColour]}
                alt={DEVICE_CATALOG[id].name}
                draggable={false}
              />
            </button>
          ))}
        </div>
        <div className="device-picker inspector-device-picker">
          <div className="device-card selected">
            <div className="device-card-main">
              <img src={spec.previews[c] ?? spec.previews[spec.defaultColour]} alt="" />
              <span className="device-card-name">{spec.name}</span>
            </div>
            <fieldset className="device-swatches">
              <legend className="visually-hidden">{spec.name} colour</legend>
              {spec.colours.map((col) => (
                <button
                  type="button"
                  key={col.id}
                  aria-pressed={c === col.id}
                  aria-label={col.name}
                  title={col.name}
                  className={`swatch${c === col.id ? " selected" : ""}`}
                  style={{ background: col.swatch }}
                  onClick={() => {
                    setC(col.id);
                    setDeviceChoiceChanged(true);
                  }}
                />
              ))}
              <span className={`swatch-custom${customColourHex(c) ? " selected" : ""}`}>
                <ColourPicker
                  value={customColourHex(c) ?? "#8a93a6"}
                  label="Custom colour"
                  onCommit={(hex) => {
                    setC(CUSTOM_COLOUR_PREFIX + hex.toLowerCase());
                    setDeviceChoiceChanged(true);
                  }}
                />
              </span>
            </fieldset>
          </div>
        </div>
        <div className="wizard-field">
          <span className="wizard-label">Motion</span>
          <div className="wizard-presets">
            {MOTION_OPTIONS.map((o) => (
              <button
                type="button"
                key={o.id}
                className={`chip${mo === o.id ? " selected" : ""}`}
                onClick={() => setMo(o.id as DeviceMotionPreset)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="modal-hint">
            Motion animates the device itself. For cinematic movement, animate the camera instead
            (Camera in the inspector).
          </span>
        </div>
      </div>
      <div className="inspector-drill-actions">
        <button type="button" className="btn" onClick={onBack}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => onSave(m, c, mo, deviceCount > 1 && applyAll, deviceChoiceChanged)}
        >
          Save
        </button>
      </div>
    </div>
  );
}
