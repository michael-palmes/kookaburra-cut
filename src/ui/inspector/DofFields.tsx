import {
  carryDof,
  DOF_DEFAULTS,
  DOF_FOCUS_MAX,
  DOF_FOCUS_MIN,
  DOF_RANGE_MAX,
  DOF_SQUEEZE_MAX,
  type DofMode,
  type EffectiveDof,
  type SceneDocDof,
} from "../../engine/dof";
import { DrillGroup, NumberField, SegmentedRow } from "./rows";

/** The Depth-of-field group, shared by the free-mode fields and the orbit grid: an Off/Depth/Tilt-shift family switch, the mode's numeric fields, presets, and the fov-style inherit affordances. Values shown are the key's EFFECTIVE dof (carry-forward along the track, the sampler's rule); edits write the sparse authored block on the current key. */

/** Dof glyphs, the SceneRowIcon treatment (20-viewBox strokes; 17 for subtabs, 13 for chips). */
function DofIcon({ id, size = 17 }: { id: string; size?: number }) {
  const paths = (() => {
    switch (id) {
      case "off":
        return (
          <>
            <circle cx="10" cy="10" r="6.5" />
            <path d="M5.4 14.6L14.6 5.4" />
          </>
        );
      case "depth":
        return (
          <>
            <circle cx="10" cy="10" r="2.2" />
            <circle cx="10" cy="10" r="6.4" strokeDasharray="2 2.4" />
          </>
        );
      case "tilt":
        return (
          <>
            <path d="M3.5 8h13M3.5 12h13" />
            <path d="M4.5 4.5h11M4.5 15.5h11" strokeDasharray="1.6 2" />
          </>
        );
      case "subtle":
        return (
          <>
            <circle cx="10" cy="10" r="6.4" />
            <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
          </>
        );
      case "cinematic":
        return (
          <>
            <path d="M4.2 8.4h11.6V15H4.2z" />
            <path d="M4.2 8.4L5 5.2l11 1.5-.2 1.7" />
            <path d="M8.2 5.6l-.9 2.3M12 6.1l-.9 2.2" />
          </>
        );
      case "macro":
        return (
          <>
            <path d="M10 16.5v-5" />
            <path d="M6.3 4.5c0 3.4 1.6 5.6 3.7 7 2.1-1.4 3.7-3.6 3.7-7-1.5 1.2-2.5 1.2-3.7 0-1.2 1.2-2.2 1.2-3.7 0z" />
          </>
        );
      case "auto":
        return (
          <>
            <path d="M10 3.6l1.6 4.8L16.4 10l-4.8 1.6L10 16.4l-1.6-4.8L3.6 10l4.8-1.6z" />
          </>
        );
      case "manual":
        return (
          <>
            <path d="M3.5 10h13" />
            <circle cx="12" cy="10" r="2.3" />
          </>
        );
      case "dream":
        return <path d="M10 2.5a5 5 0 0 0 7.5 7.5 7.5 7.5 0 1 1-7.5-7.5z" />;
      case "burst":
        return (
          <>
            <circle cx="10" cy="10" r="1.6" />
            <path d="M13.2 10h3.6M10 13.2v3.6M6.8 10H3.2M10 6.8V3.2" />
            <path d="M12.26 12.26l2.55 2.55M7.74 12.26l-2.55 2.55M12.26 7.74l2.55-2.55M7.74 7.74L5.19 5.19" />
          </>
        );
      case "swipe":
        return <path d="M4 6.5h9M4 10h12M4 13.5h7" />;
      case "split":
        return (
          <>
            <path d="M10 3.5v13" />
            <circle cx="6.2" cy="8" r="2" />
            <circle cx="13.8" cy="12" r="2" />
          </>
        );
      default:
        return null;
    }
  })();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

/** The blur-family picker: seven options, so a wrapping chip row rather than a segmented pill. */
const MODE_OPTIONS: { value: "off" | DofMode; label: string; icon: string; title: string }[] = [
  { value: "off", label: "Off", icon: "off", title: "No depth of field in this scene" },
  { value: "depth", label: "Depth", icon: "depth", title: "Blur by distance from a focus plane" },
  { value: "tilt", label: "Tilt-shift", icon: "tilt", title: "Blur outside a screen-space band" },
  { value: "soft", label: "Dream", icon: "dream", title: "Soft diffusion with a highlight glow" },
  { value: "radial", label: "Burst", icon: "burst", title: "Zoom streaks from a centre point" },
  { value: "directional", label: "Swipe", icon: "swipe", title: "A smear along one angle" },
  { value: "split", label: "Split", icon: "split", title: "Two focus distances across a divider" },
];

/** Preset looks (decision 13); depth mode only, values are pose fields, nothing of their own. */
const DEPTH_PRESETS: { icon: string; label: string; title: string; blur: number; range: number }[] =
  [
    { icon: "subtle", label: "Subtle", title: "A hint of depth separation", blur: 0.25, range: 2 },
    {
      icon: "cinematic",
      label: "Cinematic",
      title: "The standard shallow look",
      blur: 0.6,
      range: 1.2,
    },
    { icon: "macro", label: "Macro", title: "Razor-thin focus", blur: 0.9, range: 0.5 },
  ];

/** A key as the dof carry walk sees it. */
export interface DofKeyView {
  id: string;
  tMs: number;
  dof?: SceneDocDof;
}

/** An effective dof rewritten as a full authored block (the "Set on this key" write). */
function effectiveToDoc(e: EffectiveDof, mode: DofMode): SceneDocDof {
  const out: SceneDocDof = { mode, blur: e.blur, range: e.range };
  if (e.focus !== null) out.focus = e.focus;
  out.band = e.band;
  out.offset = e.offset;
  out.angleDeg = e.angleDeg;
  out.glow = e.glow;
  out.centerX = e.centerX;
  out.centerY = e.centerY;
  out.squeeze = e.squeeze;
  out.focusB = e.focusB;
  return out;
}

export function DofFields({
  keys,
  targetKeyId,
  authored,
  autoDistance,
  autoLabel,
  preview,
  commit,
  commitAll,
}: {
  /** The track's keys in time order (the carry walk's input). */
  keys: DofKeyView[];
  targetKeyId: string | null;
  /** The current pose's authored dof block, if any. */
  authored: SceneDocDof | undefined;
  /** The frame's derived focus distance (rig: aim distance; orbit: distance to target). */
  autoDistance: number;
  /** Names the auto source in the hint ("the aim" / "the target"). */
  autoLabel: string;
  /** Write the current key's dof block (undefined removes it); preview is the live drag tick. */
  preview: (next: SceneDocDof | undefined) => void;
  commit: (next: SceneDocDof | undefined) => void;
  /** Rewrite every key's dof in one commit (scene-wide off, family switches). */
  commitAll: (map: (dof: SceneDocDof | undefined) => SceneDocDof | undefined) => void;
}) {
  const sorted = [...keys].sort((a, b) => a.tMs - b.tMs);
  const targetIndex = targetKeyId ? sorted.findIndex((k) => k.id === targetKeyId) : -1;
  let carriedBefore: EffectiveDof | null = null;
  for (let i = 0; i < (targetIndex < 0 ? sorted.length : targetIndex); i++) {
    carriedBefore = carryDof(carriedBefore, sorted[i].dof);
  }
  const effective = carryDof(carriedBefore, authored);
  const sceneMode =
    sorted.find((k) => k.dof?.mode)?.dof?.mode ?? sorted.find((k) => k.dof)?.dof?.mode;
  const sceneHasDof = !!authored || sorted.some((k) => k.dof);
  const mode = sceneHasDof ? (sceneMode ?? authored?.mode ?? "depth") : "off";
  const shown = effective ?? DOF_DEFAULTS;
  const manual = shown.focus !== null;

  /** Merge one field into the current key's authored block. */
  const patch = (fields: Partial<SceneDocDof>): SceneDocDof => ({ ...authored, ...fields });

  const setMode = (next: "off" | DofMode) => {
    if (next === "off") {
      commitAll(() => undefined);
      return;
    }
    if (!sceneHasDof) {
      // Split starts with a visible second plane: half the frame's auto distance.
      commit(
        next === "split"
          ? { mode: next, blur: 0.5, focusB: Math.round(autoDistance * 50) / 100 }
          : { mode: next, blur: 0.5 },
      );
      return;
    }
    commitAll((dof) => (dof ? { ...dof, mode: next } : dof));
  };

  const depthFamily = mode === "depth" || mode === "split";

  return (
    <DrillGroup label="Depth of field">
      <div className="camera-loop-modes">
        {MODE_OPTIONS.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`chip${mode === m.value ? " selected" : ""}`}
            title={m.title}
            onClick={() => setMode(m.value)}
          >
            <DofIcon id={m.icon} size={13} />
            {m.label}
          </button>
        ))}
      </div>

      {mode === "depth" && (
        <div className="camera-loop-modes">
          {DEPTH_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`chip${shown.blur === p.blur && shown.range === p.range ? " selected" : ""}`}
              title={p.title}
              onClick={() => commit(patch({ blur: p.blur, range: p.range }))}
            >
              <DofIcon id={p.icon} size={13} />
              {p.label}
            </button>
          ))}
        </div>
      )}

      {depthFamily && (
        <>
          <div className="inspector-pose-grid">
            <NumberField
              label="blur %"
              value={shown.blur * 100}
              decimals={0}
              dragScale={0.5}
              min={0}
              max={100}
              onInput={(n) => preview(patch({ blur: n / 100 }))}
              onCommit={(n) => commit(patch({ blur: n / 100 }))}
            />
            <NumberField
              label="range"
              value={shown.range}
              decimals={2}
              dragScale={0.02}
              min={0}
              max={DOF_RANGE_MAX}
              onInput={(n) => preview(patch({ range: n }))}
              onCommit={(n) => commit(patch({ range: n }))}
            />
          </div>
          <div className="inspector-pose-grid">
            <NumberField
              label="squeeze ×"
              value={shown.squeeze}
              decimals={2}
              dragScale={0.01}
              min={1}
              max={DOF_SQUEEZE_MAX}
              onInput={(n) => preview(patch({ squeeze: n }))}
              onCommit={(n) => commit(patch({ squeeze: n }))}
            />
            {mode === "split" && (
              <NumberField
                label="distance B"
                value={shown.focusB}
                decimals={2}
                dragScale={0.02}
                min={DOF_FOCUS_MIN}
                max={DOF_FOCUS_MAX}
                onInput={(n) => preview(patch({ focusB: n }))}
                onCommit={(n) => commit(patch({ focusB: n }))}
              />
            )}
          </div>
          {mode === "split" && (
            <div className="inspector-pose-grid">
              <NumberField
                label="split %"
                value={shown.offset * 100}
                decimals={0}
                dragScale={0.5}
                min={-100}
                max={100}
                onInput={(n) => preview(patch({ offset: n / 100 }))}
                onCommit={(n) => commit(patch({ offset: n / 100 }))}
              />
              <NumberField
                label="angle °"
                value={shown.angleDeg}
                decimals={0}
                dragScale={0.5}
                min={-90}
                max={90}
                onInput={(n) => preview(patch({ angleDeg: n }))}
                onCommit={(n) => commit(patch({ angleDeg: n }))}
              />
            </div>
          )}
          <SegmentedRow
            options={[
              {
                value: "auto" as const,
                label: "Auto",
                icon: <DofIcon id="auto" />,
                title: `Focus follows ${autoLabel}`,
              },
              {
                value: "manual" as const,
                label: "Manual",
                icon: <DofIcon id="manual" />,
                title: "Focus holds a set distance",
              },
            ]}
            value={manual ? "manual" : "auto"}
            onChange={(next) => {
              if (next === "manual") {
                commit(patch({ focus: Math.round(autoDistance * 100) / 100 }));
              } else if (carriedBefore && carriedBefore.focus !== null) {
                // An earlier key holds a manual distance, so this key must SAY auto to release it.
                commit(patch({ focus: "auto" }));
              } else {
                const { focus: _drop, ...rest } = patch({});
                commit(rest);
              }
            }}
          />
          {manual ? (
            <div className="inspector-pose-grid">
              <NumberField
                label="distance"
                value={shown.focus ?? autoDistance}
                decimals={2}
                dragScale={0.02}
                min={DOF_FOCUS_MIN}
                max={DOF_FOCUS_MAX}
                onInput={(n) => preview(patch({ focus: n }))}
                onCommit={(n) => commit(patch({ focus: n }))}
              />
            </div>
          ) : (
            <div className="inspector-note">
              Focus follows {autoLabel} ({autoDistance.toFixed(2)} now), so the aimed subject stays
              sharp through the whole move.
            </div>
          )}
        </>
      )}

      {mode === "tilt" && (
        <>
          <div className="inspector-pose-grid">
            <NumberField
              label="blur %"
              value={shown.blur * 100}
              decimals={0}
              dragScale={0.5}
              min={0}
              max={100}
              onInput={(n) => preview(patch({ blur: n / 100 }))}
              onCommit={(n) => commit(patch({ blur: n / 100 }))}
            />
            <NumberField
              label="band %"
              value={shown.band * 100}
              decimals={0}
              dragScale={0.5}
              min={0}
              max={100}
              onInput={(n) => preview(patch({ band: n / 100 }))}
              onCommit={(n) => commit(patch({ band: n / 100 }))}
            />
          </div>
          <div className="inspector-pose-grid">
            <NumberField
              label="offset %"
              value={shown.offset * 100}
              decimals={0}
              dragScale={0.5}
              min={-100}
              max={100}
              onInput={(n) => preview(patch({ offset: n / 100 }))}
              onCommit={(n) => commit(patch({ offset: n / 100 }))}
            />
            <NumberField
              label="angle °"
              value={shown.angleDeg}
              decimals={0}
              dragScale={0.5}
              min={-90}
              max={90}
              onInput={(n) => preview(patch({ angleDeg: n }))}
              onCommit={(n) => commit(patch({ angleDeg: n }))}
            />
          </div>
        </>
      )}

      {mode === "soft" && (
        <div className="inspector-pose-grid">
          <NumberField
            label="blur %"
            value={shown.blur * 100}
            decimals={0}
            dragScale={0.5}
            min={0}
            max={100}
            onInput={(n) => preview(patch({ blur: n / 100 }))}
            onCommit={(n) => commit(patch({ blur: n / 100 }))}
          />
          <NumberField
            label="glow %"
            value={shown.glow * 100}
            decimals={0}
            dragScale={0.5}
            min={0}
            max={100}
            onInput={(n) => preview(patch({ glow: n / 100 }))}
            onCommit={(n) => commit(patch({ glow: n / 100 }))}
          />
        </div>
      )}

      {mode === "radial" && (
        <>
          <div className="inspector-pose-grid">
            <NumberField
              label="blur %"
              value={shown.blur * 100}
              decimals={0}
              dragScale={0.5}
              min={0}
              max={100}
              onInput={(n) => preview(patch({ blur: n / 100 }))}
              onCommit={(n) => commit(patch({ blur: n / 100 }))}
            />
          </div>
          <div className="inspector-pose-grid">
            <NumberField
              label="centre X %"
              value={shown.centerX * 100}
              decimals={0}
              dragScale={0.5}
              min={-100}
              max={100}
              onInput={(n) => preview(patch({ centerX: n / 100 }))}
              onCommit={(n) => commit(patch({ centerX: n / 100 }))}
            />
            <NumberField
              label="centre Y %"
              value={shown.centerY * 100}
              decimals={0}
              dragScale={0.5}
              min={-100}
              max={100}
              onInput={(n) => preview(patch({ centerY: n / 100 }))}
              onCommit={(n) => commit(patch({ centerY: n / 100 }))}
            />
          </div>
        </>
      )}

      {mode === "directional" && (
        <div className="inspector-pose-grid">
          <NumberField
            label="blur %"
            value={shown.blur * 100}
            decimals={0}
            dragScale={0.5}
            min={0}
            max={100}
            onInput={(n) => preview(patch({ blur: n / 100 }))}
            onCommit={(n) => commit(patch({ blur: n / 100 }))}
          />
          <NumberField
            label="angle °"
            value={shown.angleDeg}
            decimals={0}
            dragScale={0.5}
            min={-90}
            max={90}
            onInput={(n) => preview(patch({ angleDeg: n }))}
            onCommit={(n) => commit(patch({ angleDeg: n }))}
          />
        </div>
      )}

      {mode !== "off" && !authored && carriedBefore && (
        <div className="inspector-note">
          Depth of field follows earlier keys until this key sets its own.
          <button
            type="button"
            className="inspector-reset-btn"
            title="Write the inherited values onto this key so it can change them"
            onClick={() => commit(effectiveToDoc(shown, mode))}
          >
            Set on this key
          </button>
        </div>
      )}
      {mode !== "off" && authored && carriedBefore && (
        <button
          type="button"
          className="inspector-reset-btn"
          title="Drop this key's depth of field and follow earlier keys again"
          onClick={() => commit(undefined)}
        >
          Inherit depth of field
        </button>
      )}
    </DrillGroup>
  );
}
