import {
  DEFAULT_MOTION_BLUR,
  MOTION_BLUR_AMOUNT_MAX,
  type MotionBlurOverride,
  type MotionBlurSettings,
  resolveSceneMotionBlur,
  SAMPLE_PRESETS,
  type SceneDocMotionBlur,
  SHUTTER_PRESETS,
} from "../../engine/motionBlur";
import { SHUTTER_DEG_MAX } from "../../engine/shutter";
import { MotionBlurIcon } from "./MotionBlurIcon";
import { DrillGroup, InspectorSliderRow, NumberField, SegmentedRow, ToggleRow } from "./rows";

/** "Film 180°" for a preset angle, "200°" otherwise. */
export function shutterLabel(deg: number): string {
  const preset = SHUTTER_PRESETS.find((p) => p.deg === deg);
  return preset ? `${preset.label} ${deg}°` : `${Math.round(deg)}°`;
}

/** The Project tab row's value. */
export function motionBlurRowValue(settings: MotionBlurSettings | undefined): string {
  if (!settings?.enabled) return "Off";
  return `${shutterLabel(settings.shutterDeg)}, ${settings.samples} samples`;
}

function ShutterChips({ value, onChange }: { value: number; onChange: (deg: number) => void }) {
  return (
    <div className="camera-loop-modes">
      {SHUTTER_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`chip${value === p.deg ? " selected" : ""}`}
          title={`${p.deg}° shutter`}
          onClick={() => onChange(p.deg)}
        >
          <MotionBlurIcon id={`shutter-${p.deg}`} size={13} />
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** The project's motion blur (manifest `render.motionBlur`): the master switch, shutter, quality, and what blurs. */
export function MotionBlurProjectFields({
  settings,
  onChange,
}: {
  settings: MotionBlurSettings | undefined;
  onChange: (next: MotionBlurSettings) => void;
}) {
  const current = settings ?? DEFAULT_MOTION_BLUR;
  const set = (patch: Partial<MotionBlurSettings>) => onChange({ ...current, ...patch });
  return (
    <>
      <ToggleRow
        icon={<MotionBlurIcon id="streak" />}
        label="Motion blur"
        description="Blurs the camera and anything that moves across each frame's shutter. Exports take longer."
        checked={current.enabled}
        onChange={(enabled) => set({ enabled })}
      />
      {current.enabled && (
        <>
          <ShutterChips value={current.shutterDeg} onChange={(shutterDeg) => set({ shutterDeg })} />
          <div className="inspector-pose-grid">
            <NumberField
              label="shutter °"
              value={current.shutterDeg}
              decimals={0}
              min={0}
              max={SHUTTER_DEG_MAX}
              onCommit={(shutterDeg) => set({ shutterDeg })}
            />
          </div>
          <div className="camera-loop-modes">
            {SAMPLE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip${current.samples === p.samples ? " selected" : ""}`}
                title={`${p.samples} renders per blurred frame`}
                onClick={() => set({ samples: p.samples })}
              >
                <MotionBlurIcon id={`samples-${p.samples}`} size={13} />
                {p.label}
              </button>
            ))}
          </div>
          <ToggleRow
            icon={<MotionBlurIcon id="camera" />}
            label="Camera"
            description="Blur from camera moves."
            checked={current.camera}
            onChange={(camera) => set({ camera })}
          />
          <ToggleRow
            icon={<MotionBlurIcon id="objects" />}
            label="Objects"
            description="Blur from devices, media, text and charts as they move."
            checked={current.objects}
            onChange={(objects) => set({ objects })}
          />
        </>
      )}
    </>
  );
}

type SceneMode = "project" | "off" | "custom";

/** The camera drill's Motion blur group: the scene's layer over the project's, then the current key's shutter (the fov inherit pattern). */
export function MotionBlurCameraFields({
  project,
  scene,
  onSceneChange,
  hasKey,
  keyShutter,
  onKeyPreview,
  onKeyCommit,
}: {
  project: MotionBlurSettings | undefined;
  scene: SceneDocMotionBlur | undefined;
  onSceneChange: (next: SceneDocMotionBlur | undefined) => void;
  /** False on a scene with no camera keys: the per-key shutter needs a key to live on. */
  hasKey: boolean;
  /** The current key's authored shutter; undefined follows the scene. */
  keyShutter: number | undefined;
  /** Writes the key's shutter (undefined drops it); preview is the live drag tick. */
  onKeyPreview: (deg: number | undefined) => void;
  onKeyCommit: (deg: number | undefined) => void;
}) {
  const resolved = resolveSceneMotionBlur(project, scene);
  const mode: SceneMode = !scene ? "project" : scene.enabled === false ? "off" : "custom";
  const inherited = resolveSceneMotionBlur(project, undefined);
  const setMode = (next: SceneMode) => {
    if (next === "project") onSceneChange(undefined);
    else if (next === "off") onSceneChange({ enabled: false });
    else
      onSceneChange({
        enabled: true,
        shutterDeg: inherited?.shutterDeg ?? DEFAULT_MOTION_BLUR.shutterDeg,
        camera: inherited?.camera ?? true,
        objects: inherited?.objects ?? true,
      });
  };
  const patch = (fields: Partial<SceneDocMotionBlur>) =>
    onSceneChange({ ...scene, enabled: true, ...fields });
  const hint =
    mode === "project"
      ? inherited
        ? `Follows the project: ${shutterLabel(inherited.shutterDeg)}.`
        : "Off in the project's Motion blur settings."
      : undefined;
  return (
    <DrillGroup label="Motion blur" hint={hint}>
      <SegmentedRow<SceneMode>
        ariaLabel="Scene motion blur"
        options={[
          { value: "project", label: "Project", icon: <MotionBlurIcon id="inherit" /> },
          { value: "off", label: "Off", icon: <MotionBlurIcon id="off" /> },
          { value: "custom", label: "Custom", icon: <MotionBlurIcon id="streak" /> },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === "custom" && resolved && (
        <>
          <ShutterChips
            value={resolved.shutterDeg}
            onChange={(shutterDeg) => patch({ shutterDeg })}
          />
          <ToggleRow
            icon={<MotionBlurIcon id="camera" />}
            label="Camera"
            checked={resolved.camera}
            onChange={(camera) => patch({ camera })}
          />
          <ToggleRow
            icon={<MotionBlurIcon id="objects" />}
            label="Objects"
            checked={resolved.objects}
            onChange={(objects) => patch({ objects })}
          />
        </>
      )}
      {resolved && hasKey && (
        <>
          <div className="inspector-pose-grid">
            <NumberField
              label="key shutter °"
              value={keyShutter ?? resolved.shutterDeg}
              decimals={0}
              min={0}
              max={SHUTTER_DEG_MAX}
              onInput={(n) => onKeyPreview(n)}
              onCommit={(n) => onKeyCommit(n)}
            />
          </div>
          {keyShutter === undefined ? (
            <div className="inspector-note">
              Shutter follows the scene ({Math.round(resolved.shutterDeg)}°) until this key sets its
              own.
            </div>
          ) : (
            <button
              type="button"
              className="inspector-reset-btn"
              title="Drop this key's shutter and follow the scene again"
              onClick={() => onKeyCommit(undefined)}
            >
              Inherit shutter
            </button>
          )}
        </>
      )}
    </DrillGroup>
  );
}

type OverrideMode = "inherit" | "off" | "on";

/** One item's motion blur override (device, media, text, chart, screenshot stack): Inherit follows the scene's Objects switch. */
export function MotionBlurOverrideRow({
  value,
  onChange,
}: {
  value: MotionBlurOverride | undefined;
  onChange: (next: MotionBlurOverride | undefined) => void;
}) {
  const mode: OverrideMode = !value ? "inherit" : value.enabled ? "on" : "off";
  return (
    <>
      <SegmentedRow<OverrideMode>
        ariaLabel="Motion blur"
        options={[
          {
            value: "inherit",
            label: "Inherit",
            icon: <MotionBlurIcon id="inherit" />,
            title: "Follow the scene's Objects motion blur",
          },
          { value: "off", label: "Off", icon: <MotionBlurIcon id="off" />, title: "Always sharp" },
          { value: "on", label: "On", icon: <MotionBlurIcon id="streak" />, title: "Always blur" },
        ]}
        value={mode}
        onChange={(next) =>
          onChange(
            next === "inherit"
              ? undefined
              : next === "off"
                ? { enabled: false }
                : {
                    enabled: true,
                    ...(value?.amount !== undefined ? { amount: value.amount } : {}),
                  },
          )
        }
      />
      {mode === "on" && (
        <InspectorSliderRow
          icon={<MotionBlurIcon id="streak" size={14} />}
          label="Amount"
          value={Math.round((value?.amount ?? 1) * 100)}
          min={0}
          max={MOTION_BLUR_AMOUNT_MAX * 100}
          step={5}
          formatValue={(v) => `${Math.round(v)}%`}
          onCommit={(pct) => onChange({ enabled: true, amount: pct / 100 })}
        />
      )}
    </>
  );
}
