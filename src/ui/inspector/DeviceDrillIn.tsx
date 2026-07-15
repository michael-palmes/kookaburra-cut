import { useState } from "react";
import { DEVICE_CATALOG, DEVICE_IDS, type DeviceId } from "../../toolkit/device/catalog";
import type { DeviceMotionPreset } from "../../toolkit/device/Device";
import { MOTION_OPTIONS } from "../SceneWizards";
import { useEscapeClose } from "../useEscapeClose";
import { DrillBack } from "./rows";

/** Change-device as an inspector drill-in: the EditBar modal's content (model switcher + catalog card + colour swatches + motion presets, applied on Save) re-laid for the 312px panel. */
export function DeviceDrillIn({
  model,
  colour,
  motion,
  onBack,
  onSave,
}: {
  model: DeviceId;
  colour: string;
  motion: DeviceMotionPreset;
  onBack: () => void;
  onSave: (model: DeviceId, colour: string, motion: DeviceMotionPreset) => void;
}) {
  const [m, setM] = useState<DeviceId>(model);
  const [c, setC] = useState(colour);
  const [mo, setMo] = useState<DeviceMotionPreset>(motion);
  useEscapeClose(onBack);
  const spec = DEVICE_CATALOG[m];
  return (
    <div className="inspector-drill">
      <DrillBack label="Scene" onClick={onBack} />
      <div className="inspector-drill-title">Change device</div>
      <div className="inspector-drill-body">
        <div className="inspector-device-switcher" role="radiogroup" aria-label="Device model">
          {DEVICE_IDS.map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={m === id}
              title={DEVICE_CATALOG[id].name}
              className={`inspector-device-switch${m === id ? " selected" : ""}`}
              onClick={() => {
                setM(id);
                setC(id === model ? colour : DEVICE_CATALOG[id].defaultColour);
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
                  onClick={() => setC(col.id)}
                />
              ))}
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
        </div>
      </div>
      <div className="inspector-drill-actions">
        <button type="button" className="btn" onClick={onBack}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => onSave(m, c, mo)}>
          Save
        </button>
      </div>
    </div>
  );
}
