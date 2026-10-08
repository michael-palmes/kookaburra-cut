import { useMemo, useState } from "react";
import { useClockStore } from "../../engine/clock";
import type { LoadedProject } from "../../engine/project";
import { commitSceneDocPatch, type SceneDocPatch } from "../../engine/sceneDocPatchQueue";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  addStillMark,
  removeStillMark,
  sceneStillsPlan,
  setKeyStill,
  setStillsExcluded,
} from "../../engine/stills";
import { useCameraDoc } from "../cameraDoc";
import { formatSceneLengthMs } from "../durationText";
import { seekSceneLocal } from "../laneSeek";
import { StillsIcon } from "../stillsIcons";
import {
  dormantStillsHint,
  playheadStillMs,
  rawMarksForTimeStill,
  type StillRow,
  stillAtFrame,
  stillRows,
} from "../stillsModel";
import { commitFocusedInspectorEdit } from "../textEditFocus";
import { ActionRow, DrillBack, DrillGroup, ToggleRow } from "./rows";

/** The Scene inspector's Stills screen: the include toggle, this scene's planned stills (the automatic one or its marks) and a playhead mark. Key marks write through `useCameraDoc` so an in-flight camera draft can never drop them; the include flag and time marks go through the shared scene-doc queue, which also gives a doc-less scene its first sidecar. */
export function StillsDrill({
  project,
  sceneIndex,
  onDocChanged,
  onBack,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onBack: () => void;
}) {
  const { doc, slot, camera, rig, commit, commitRig } = useCameraDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const [error, setError] = useState<string | null>(null);
  const slots = project.slots;
  const plan = useMemo(() => sceneStillsPlan(doc, slots, sceneIndex), [doc, slots, sceneIndex]);
  const rows = stillRows(plan, doc);
  const dormant = dormantStillsHint(plan.dormantKeyMarks, doc);
  const playheadMs = useClockStore((s) =>
    Math.min(slot.durationMs, playheadStillMs(s.currentMs, slot.startMs)),
  );
  const taken = stillAtFrame(plan, slots, sceneIndex, playheadMs);

  const nextSlot = slots[sceneIndex + 1];
  const laneWindow = {
    windowStartMs: (slot.transitionIn?.durationMs ?? 0) / 2,
    windowEndMs: slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2,
    lastScene: !nextSlot,
  };

  const write = (label: string, patch: SceneDocPatch) => {
    setError(null);
    void commitSceneDocPatch({ project, sceneIndex, label, onDocChanged }, patch).catch((e) =>
      setError(`Save failed: ${String(e)}`),
    );
  };

  const jump = (tMs: number) => {
    commitFocusedInspectorEdit();
    seekSceneLocal(slot.startMs, tMs, laneWindow);
  };

  const remove = (row: StillRow) => {
    if (row.kind === "key" && row.keyId) {
      if (row.block === "cameraRig") {
        const next = setKeyStill(rig, row.keyId, false);
        if (next) void commitRig(next, "remove still");
      } else {
        const next = setKeyStill(camera, row.keyId, false);
        if (next) void commit(next, "remove still");
      }
      return;
    }
    if (row.kind !== "time" || row.tMs === null) return;
    const raw = rawMarksForTimeStill(doc?.stills?.marksMs ?? [], row.tMs, slots, sceneIndex);
    write("remove still", (next) => {
      let removed = false;
      for (const ms of raw) {
        if (removeStillMark(next, ms) !== false) removed = true;
      }
      return removed ? undefined : false;
    });
  };

  return (
    <div className="inspector-drill">
      <DrillBack label="Scene" title="Stills" onClick={onBack} />
      <div className="inspector-drill-body">
        <ToggleRow
          icon={<StillsIcon id="stills" />}
          label="Include in stills"
          description="Off leaves this scene out of PDF and PNG exports. Marks are kept."
          checked={plan.included}
          onChange={(on) =>
            write(on ? "include in stills" : "leave out of stills", (next) =>
              setStillsExcluded(next, !on),
            )
          }
        />
        {plan.included && (
          <DrillGroup
            label="Stills"
            hint="Marked stills replace the automatic one. Right-click a camera keyframe and choose Use as still."
          >
            {rows.map((row) => (
              <div key={row.id} className="stills-row-wrap">
                <div className="stills-row">
                  <span className="stills-row-icon">
                    <StillsIcon
                      id={
                        row.kind === "auto"
                          ? "still-auto"
                          : row.kind === "key"
                            ? "still-key"
                            : "still-time"
                      }
                    />
                  </span>
                  <span className="stills-row-label">{row.label}</span>
                  <span className="stills-row-value">
                    {row.tMs === null ? "Settled moment" : formatSceneLengthMs(row.tMs)}
                  </span>
                  {row.tMs !== null && (
                    <>
                      <button
                        type="button"
                        className="stills-row-action"
                        title="Move the playhead to this still"
                        aria-label={`Jump to ${row.label}`}
                        onClick={() => jump(row.tMs ?? 0)}
                      >
                        <StillsIcon id="jump" size={15} />
                      </button>
                      <button
                        type="button"
                        className="stills-row-action danger"
                        title="Remove this still"
                        aria-label={`Remove ${row.label} still`}
                        onClick={() => remove(row)}
                      >
                        <StillsIcon id="still-remove" size={15} />
                      </button>
                    </>
                  )}
                </div>
                {row.clamped && (
                  <span className="stills-row-note">
                    In a transition: exports the nearest clean frame.
                  </span>
                )}
              </div>
            ))}
            {dormant && <span className="drill-group-hint">{dormant}</span>}
            <ActionRow
              icon={<StillsIcon id="still-add" />}
              label="Add still at playhead"
              value={taken ? "Already a still here" : formatSceneLengthMs(playheadMs)}
              chevron={false}
              disabled={taken}
              onClick={() => write("add still", (next) => addStillMark(next, playheadMs))}
            />
          </DrillGroup>
        )}
        {error && (
          <p className="inspector-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
