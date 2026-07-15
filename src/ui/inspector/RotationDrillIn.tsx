import type { V3 } from "../../toolkit/types";
import { DrillBack, NumericField } from "./rows";

/** Preset poses: Front on is the glb's authored identity; Editorial is the scaffolder's hero angle. */
const ROTATION_PRESETS: { id: string; label: string; value: V3 }[] = [
  { id: "front", label: "Front on", value: [0, 0, 0] },
  { id: "editorial", label: "Editorial", value: [3, -14, 0] },
  { id: "mirrored", label: "Mirrored", value: [3, 14, 0] },
];

const AXIS_LABELS = ["tilt x °", "turn y °", "roll z °"] as const;

/** The device Rotation drill-in: preset chips plus per-axis degree fields, each committing straight through the sidecar patch funnel (undo per commit, like Camera pose edits). */
export function RotationDrillIn({
  rotationDeg,
  onBack,
  onCommit,
}: {
  rotationDeg: V3;
  onBack: () => void;
  onCommit: (next: V3) => void;
}) {
  const matches = (v: V3) => v.every((n, i) => Math.abs(n - rotationDeg[i]) < 0.05);
  return (
    <>
      <DrillBack label="Scene" onClick={onBack} />
      <div className="inspector-section-body">
        <div className="wizard-presets">
          {ROTATION_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip${matches(p.value) ? " selected" : ""}`}
              onClick={() => onCommit([...p.value])}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="inspector-pose-grid">
          {AXIS_LABELS.map((label, axis) => (
            <NumericField
              key={label}
              label={label}
              value={rotationDeg[axis]}
              decimals={1}
              onCommit={(n) => {
                const next: V3 = [...rotationDeg];
                next[axis] = n;
                onCommit(next);
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
