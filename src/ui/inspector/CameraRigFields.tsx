import { checkCameraBounds } from "../../engine/cameraBounds";
import type { CameraPose } from "../../engine/cameraTrack";
import { frameContentPose, stagedContentBounds } from "../../engine/rigFraming";
import type { RigDoc } from "../../engine/sceneCameraEdit";
import { setKeyPose } from "../../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocRigAim, SceneDocRigPose } from "../../engine/sceneDocSchema";
import {
  LAYERED_SCREENSHOT_AIM_ID,
  RIG_FOV_MAX,
  RIG_FOV_MIN,
  VIDEO_WINDOW_AIM_ID,
} from "../../engine/sceneRig";
import { bakeRigBinding, brokenRigBindings } from "../../engine/sceneRigConvert";
import { DofFields } from "./DofFields";
import { NumberField, SegmentedRow } from "./rows";

/** The Camera drill-in's FREE-mode body: position, a per-key aim (point, tangent or a bound object), and the shared lens and roll rows. Orbit's six-field grid lives in SceneTab and is untouched; this file exists so the drill-in gains a mode rather than a second personality. */

const AIM_OPTIONS = [
  { value: "point" as const, label: "Point", title: "Aim at a fixed world point" },
  { value: "tangent" as const, label: "Tangent", title: "Aim along the path the camera travels" },
  { value: "object" as const, label: "Object", title: "Aim at something staged in the scene" },
];

/** Everything in the scene a rig key can bind its aim to. */
function bindables(doc: SceneDoc | undefined): { id: string; label: string }[] {
  const options: { id: string; label: string }[] = [];
  for (const device of doc?.devices ?? []) options.push({ id: device.id, label: device.model });
  if (doc?.videoWindow) options.push({ id: VIDEO_WINDOW_AIM_ID, label: "Video window" });
  if (doc?.layeredScreenshot) {
    options.push({ id: LAYERED_SCREENSHOT_AIM_ID, label: "Screenshot stack" });
  }
  return options;
}

export function CameraRigFields({
  doc,
  rig,
  pose,
  targetKeyId,
  appliedView,
  aspect,
  banded,
  frame,
  previewPose,
  commitPose,
  commitRig,
}: {
  doc: SceneDoc | undefined;
  rig: RigDoc;
  pose: SceneDocRigPose;
  /** Null on a trackless scene: edits then seed a lone key at t=0. */
  targetKeyId: string | null;
  appliedView: CameraPose;
  aspect: number;
  /** The scene lays out in depth bands, so it sizes itself and needs no advisory. */
  banded: boolean;
  /** The visible world rect at the content plane; the fallback the frame-content button fits. */
  frame: { width: number; height: number };
  previewPose: (mutate: (p: SceneDocRigPose) => void) => void;
  commitPose: (mutate: (p: SceneDocRigPose) => void) => void;
  commitRig: (rig: RigDoc) => void;
}) {
  const broken = brokenRigBindings(rig, doc);
  const options = bindables(doc);
  const bounds = checkCameraBounds(appliedView, aspect, doc, undefined, banded);

  const setAimMode = (mode: SceneDocRigAim["mode"]) =>
    commitPose((p) => {
      if (p.aim.mode === mode) return;
      const at: [number, number, number] = [...p.aim.at];
      // The baked point carries across every mode, so switching never loses the shot.
      p.aim = mode === "object" ? { mode, id: options[0]?.id ?? "", at } : { mode, at };
    });

  return (
    <>
      <div className="inspector-pose-grid">
        <NumberField
          label="pos x"
          value={pose.position[0]}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.position[0] = n))}
          onCommit={(n) => commitPose((p) => (p.position[0] = n))}
        />
        <NumberField
          label="pos y"
          value={pose.position[1]}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.position[1] = n))}
          onCommit={(n) => commitPose((p) => (p.position[1] = n))}
        />
        <NumberField
          label="pos z"
          value={pose.position[2]}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.position[2] = n))}
          onCommit={(n) => commitPose((p) => (p.position[2] = n))}
        />
      </div>

      <button
        type="button"
        className="inspector-reset-btn"
        title="Move this key back until everything the scene stages fits, keeping the current angle"
        onClick={() =>
          commitPose((p) => {
            const fitted = frameContentPose(
              stagedContentBounds(doc, frame),
              p,
              p.fov ?? appliedView.fov,
              aspect,
            );
            if (!fitted) return;
            p.position = fitted.position;
            p.aim = fitted.aim;
          })
        }
      >
        Frame content
      </button>

      <SegmentedRow
        ariaLabel="Camera aim"
        options={AIM_OPTIONS}
        value={pose.aim.mode}
        onChange={setAimMode}
      />

      {pose.aim.mode === "point" && (
        <div className="inspector-pose-grid">
          <NumberField
            label="aim x"
            value={pose.aim.at[0]}
            decimals={2}
            dragScale={0.02}
            onInput={(n) => previewPose((p) => (p.aim.at[0] = n))}
            onCommit={(n) => commitPose((p) => (p.aim.at[0] = n))}
          />
          <NumberField
            label="aim y"
            value={pose.aim.at[1]}
            decimals={2}
            dragScale={0.02}
            onInput={(n) => previewPose((p) => (p.aim.at[1] = n))}
            onCommit={(n) => commitPose((p) => (p.aim.at[1] = n))}
          />
          <NumberField
            label="aim z"
            value={pose.aim.at[2]}
            decimals={2}
            dragScale={0.02}
            onInput={(n) => previewPose((p) => (p.aim.at[2] = n))}
            onCommit={(n) => commitPose((p) => (p.aim.at[2] = n))}
          />
        </div>
      )}

      {pose.aim.mode === "tangent" && (
        <div className="inspector-note">
          The camera looks along its path. Outside a segment, or where the path stands still, it
          falls back to the point it was last baked at.
        </div>
      )}

      {pose.aim.mode === "object" && (
        <div className="camera-aim-object">
          <select
            value={pose.aim.id}
            onChange={(e) =>
              commitPose((p) => {
                if (p.aim.mode === "object") p.aim.id = e.target.value;
              })
            }
          >
            {options.length === 0 && <option value="">Nothing staged to aim at</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {broken.map((id) => (
        <div key={id} className="inspector-note inspector-note-warn">
          <span>“{id}” is no longer in this scene, so its keys hold their last known aim.</span>
          <button
            type="button"
            className="inspector-reset-btn"
            onClick={() => commitRig(bakeRigBinding(rig, id))}
          >
            Bake to point
          </button>
        </div>
      ))}

      <div className="inspector-pose-grid">
        <NumberField
          label="field of view"
          value={pose.fov ?? appliedView.fov}
          decimals={0}
          dragScale={0.2}
          min={RIG_FOV_MIN}
          max={RIG_FOV_MAX}
          onInput={(n) => previewPose((p) => (p.fov = n))}
          onCommit={(n) => commitPose((p) => (p.fov = n))}
        />
        <NumberField
          label="roll °"
          value={pose.rollDeg ?? 0}
          decimals={1}
          dragScale={0.5}
          onInput={(n) => previewPose((p) => (p.rollDeg = n))}
          onCommit={(n) =>
            commitPose((p) => {
              // Zero roll drops the field, so a pose that isn't banked stays legacy-shaped.
              if (n) p.rollDeg = n;
              else delete p.rollDeg;
            })
          }
        />
      </div>
      {pose.fov === undefined ? (
        <div className="inspector-note">
          Field of view follows the project's camera track ({Math.round(appliedView.fov)}°) until
          this key sets its own.
        </div>
      ) : (
        <button
          type="button"
          className="inspector-reset-btn"
          title="Drop this key's field of view and follow the project's camera track again"
          onClick={() => commitPose((p) => delete p.fov)}
        >
          Inherit field of view
        </button>
      )}

      <DofFields
        keys={rig.keys}
        targetKeyId={targetKeyId}
        authored={pose.dof}
        autoDistance={aimDistanceOf(pose)}
        autoLabel="the aim"
        preview={(next) =>
          previewPose((p) => {
            if (next) p.dof = next;
            else delete p.dof;
          })
        }
        commit={(next) =>
          commitPose((p) => {
            if (next) p.dof = next;
            else delete p.dof;
          })
        }
        commitAll={(map) =>
          commitRig({
            ...rig,
            keys: rig.keys.map((key) => {
              const dof = map(key.pose.dof);
              const nextPose = { ...key.pose };
              if (dof) nextPose.dof = dof;
              else delete nextPose.dof;
              return { ...key, pose: nextPose };
            }),
          })
        }
      />

      {!bounds.ok && (
        <div className="inspector-note inspector-note-warn">
          {bounds.reason} The shot still renders; this is a framing note, not an error.
        </div>
      )}

      {targetKeyId === null && rig.keys.length === 0 && (
        <div className="inspector-note">
          Editing any field here seeds a single key, which reframes the whole scene.
        </div>
      )}
    </>
  );
}

/** A rig track with one key at t=0 holding `pose` (the seed a trackless edit writes). */
export function seedRig(rig: RigDoc, targetKeyId: string | null, pose: SceneDocRigPose): RigDoc {
  if (!targetKeyId) return { ...rig, keys: [{ id: "k1", tMs: 0, pose }], segments: [] };
  return (setKeyPose(rig, targetKeyId, pose) as RigDoc | null) ?? rig;
}

/** The pose's camera-to-aim distance: what autofocus resolves to (the DoF group's Auto hint). */
function aimDistanceOf(pose: SceneDocRigPose): number {
  const dx = pose.aim.at[0] - pose.position[0];
  const dy = pose.aim.at[1] - pose.position[1];
  const dz = pose.aim.at[2] - pose.position[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
