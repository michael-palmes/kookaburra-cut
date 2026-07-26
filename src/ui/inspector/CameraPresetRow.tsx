import { useState } from "react";
import { CAMERA_PRESETS, presetContext } from "../../engine/cameraPresets";
import type { CameraDoc, RigDoc } from "../../engine/sceneCameraEdit";
import type { SceneDocCameraPose } from "../../engine/sceneDocSchema";
import { ActionRow } from "./rows";

/** The camera drill-in's preset list: one row that opens a list of canned moves. Applying one REPLACES the track and sets the mode in a single history entry, confirming only when there are keys to lose. Presets seed from the pose the scene currently shows, so a reframed scene keeps its framing. */
export function CameraPresetRow({
  durationMs,
  orbitPose,
  fov,
  hasKeys,
  icon,
  onApply,
}: {
  durationMs: number;
  orbitPose: SceneDocCameraPose;
  fov: number;
  hasKeys: boolean;
  icon?: React.ReactNode;
  onApply: (result: {
    mode: "orbit" | "rig";
    camera?: CameraDoc;
    rig?: RigDoc;
    label: string;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const apply = (id: string) => {
    const preset = CAMERA_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const built = preset.build(presetContext(durationMs, orbitPose, fov));
    onApply({ ...built, label: preset.label });
    setOpen(false);
    setConfirming(null);
  };

  return (
    <>
      <ActionRow
        icon={icon}
        label="Camera presets"
        value={open ? undefined : `${CAMERA_PRESETS.length} moves`}
        selected={open}
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(null);
        }}
      />
      {open && (
        <div className="camera-preset-list">
          {CAMERA_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={`camera-preset${confirming === preset.id ? " confirming" : ""}`}
              onClick={() => {
                // Only confirm when there is authored work to replace.
                if (hasKeys && confirming !== preset.id) {
                  setConfirming(preset.id);
                  return;
                }
                apply(preset.id);
              }}
            >
              <span className="camera-preset-label">
                {confirming === preset.id ? "Replace the current keys?" : preset.label}
              </span>
              <span className="camera-preset-desc">{preset.description}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
