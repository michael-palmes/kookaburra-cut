import { useRef, useState } from "react";
import type { SceneDoc, SceneManagedTextItemType } from "../../engine/sceneDocSchema";
import { defaultTheme } from "../../theme";
import type { TextLookSpec, Theme } from "../../theme/tokens";
import {
  DEFAULT_LOOK_ANGLE_DEG,
  DEFAULT_LOOK_CURVE_DEG,
  DEFAULT_LOOK_HOLLOW,
  DEFAULT_LOOK_INTENSITY,
  DEFAULT_LOOK_OFFSET_EM,
  DEFAULT_LOOK_STROKE_EM,
  type TextLookName,
} from "../../toolkit/text/looks";
import { ColourPicker } from "../colour/ColourPicker";
import { TextLookIcon } from "../TextLookPicker";
import { darkenedStopB, TEXT_LOOK_CATALOG, textLookMeta } from "../textLookOptions";
import type { ManagedTextWrite } from "./ManagedTextDrill";
import { TextControlIcon, TextScopeIcon } from "./ManagedTextDrill";
import {
  rebaseTextLookSpec,
  setTextLookSpec,
  type TextMotionScope,
  textLookSpec,
} from "./managedTextEditorModel";
import {
  DrillBack,
  DrillGroup,
  InspectorSliderRow,
  type SegmentedOption,
  SegmentedRow,
  ToggleRow,
} from "./rows";

/** The text-style drill (the "text look" catalogue), mirroring TextMotionDrill: an All lines / This line scope, the preset cards, per-look param rows, and the `textLookForce` coded-style override. */

export type TextLookScopeChoice = "all" | "item";

export interface TextLookDrillProps {
  doc: SceneDoc;
  itemKey: string;
  itemType: SceneManagedTextItemType;
  itemLabel?: string;
  /** Mounted code-owned item look shown before an explicit sidecar exception exists. */
  resolvedItemLook?: TextLookSpec;
  initialScope?: TextLookScopeChoice;
  codedLookNames?: readonly string[];
  /** The scene's resolved theme; colours the swatch fallbacks. */
  theme?: Theme;
  backLabel?: string;
  onBack: () => void;
  writeDoc: ManagedTextWrite;
  onLeaveCodedLook?: () => void;
  onOverrideCodedLook?: (override: boolean) => void;
  disabled?: boolean;
}

function LookParamIcon({ type }: { type: "angle" | "stroke" | "intensity" | "offset" | "curve" }) {
  const glyph =
    type === "angle" ? (
      <>
        <path d="M3 13h10M3 13V3" />
        <path d="M3 13 11 5M6.5 13a5 5 0 0 0-1.46-3.54" />
      </>
    ) : type === "stroke" ? (
      <>
        <path d="M3 12.5h10" />
        <path d="M5.5 9.5 8 3.5l2.5 6z" />
      </>
    ) : type === "intensity" ? (
      <>
        <circle cx="8" cy="8" r="2.6" />
        <path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14M3.8 3.8l1.3 1.3M10.9 10.9l1.3 1.3M12.2 3.8l-1.3 1.3M5.1 10.9l-1.3 1.3" />
      </>
    ) : type === "offset" ? (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
        <path d="M13 6.5V12a1 1 0 0 1-1 1H6.5" opacity="0.55" />
      </>
    ) : (
      <>
        <path d="M2.5 11a6.5 6.5 0 0 1 11 0" />
        <path d="M2.5 11v2M13.5 11v2" />
      </>
    );
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

const SCOPE_OPTIONS: SegmentedOption<TextLookScopeChoice>[] = [
  { value: "all", label: "All lines", icon: <TextScopeIcon scope="all" /> },
  { value: "item", label: "This line", icon: <TextScopeIcon scope="item" /> },
];

function lookSeed(current: TextLookSpec | undefined): TextLookSpec {
  return current ? structuredClone(current) : { preset: "none" };
}

/** Switch presets while keeping shared params; "none" writes the bare spec so a cleared look carries no stale fields. */
export function lookSpecForPreset(
  current: TextLookSpec | undefined,
  preset: TextLookName,
): TextLookSpec {
  if (preset === "none") return { preset: "none" };
  return { ...lookSeed(current), preset };
}

function namedLookCopy(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "This line";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function TextLookDrill({
  doc,
  itemKey,
  itemLabel = "Selected line",
  resolvedItemLook,
  initialScope = "all",
  codedLookNames = [],
  theme = defaultTheme,
  backLabel = "Text",
  onBack,
  writeDoc,
  onLeaveCodedLook,
  onOverrideCodedLook,
  disabled = false,
}: TextLookDrillProps) {
  const [scopeChoice, setScopeChoice] = useState<TextLookScopeChoice>(initialScope);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const baselines = useRef(new Map<string, SceneDoc>());
  const scope: TextMotionScope =
    scopeChoice === "all" ? { kind: "all" } : { kind: "item", itemKey };
  const resolvedSpec = (source: SceneDoc) =>
    textLookSpec(source, scope) ??
    (scope.kind === "item" && !source.textLookForce ? resolvedItemLook : undefined);
  const current = resolvedSpec(doc);
  const meta = current ? textLookMeta(current.preset) : undefined;
  const showCodedWarning = codedLookNames.length > 0 && !doc.textLookForce && !warningDismissed;
  const accent = theme.colors.accent;
  const colourADefault = meta?.colorADefault ?? accent;
  const colourALabel = meta?.colorALabel ?? "Colour";
  const colourA = current?.colorA ?? colourADefault;
  const colourB = current?.colorB ?? darkenedStopB(colourA);

  const writeSpec = (
    spec: TextLookSpec | undefined,
    history: string,
    baseline = doc,
    live = false,
    historyFromBaseline = false,
  ) => {
    if (disabled) return;
    const next = setTextLookSpec(baseline, scope, spec);
    const baselineSpec = resolvedSpec(baseline);
    void writeDoc({
      preview: next,
      history: live ? false : history,
      baseline,
      historyFromBaseline,
      applyToCurrent: (current) =>
        setTextLookSpec(
          current,
          scope,
          rebaseTextLookSpec(resolvedSpec(current), baselineSpec, spec),
        ),
    });
  };

  const slider = (
    key: string,
    value: number,
    update: (spec: TextLookSpec, value: number) => TextLookSpec,
    history: string,
  ) => ({
    onInput: (nextValue: number) => {
      if (!current || disabled) return;
      const baselineKey = `${scopeChoice}:${itemKey}:${key}`;
      let baseline = baselines.current.get(baselineKey);
      if (!baseline) {
        baseline = doc;
        baselines.current.set(baselineKey, baseline);
      }
      const baselineSpec = resolvedSpec(baseline);
      if (baselineSpec) writeSpec(update(baselineSpec, nextValue), history, baseline, true);
    },
    onCommit: (nextValue: number) => {
      if (!current || disabled) return;
      const baselineKey = `${scopeChoice}:${itemKey}:${key}`;
      const baseline = baselines.current.get(baselineKey) ?? doc;
      baselines.current.delete(baselineKey);
      const baselineSpec = resolvedSpec(baseline);
      if (baselineSpec) {
        writeSpec(update(baselineSpec, nextValue), history, baseline, false, true);
      }
    },
    value,
  });

  const choosePreset = (preset: TextLookName | "theme") => {
    if (preset === "theme") writeSpec(undefined, "follow theme text style");
    else writeSpec(lookSpecForPreset(current, preset), "change text style preset");
  };

  const commitColour = (field: "colorA" | "colorB", value: string | undefined) => {
    if (!current || disabled) return;
    const next = structuredClone(current);
    if (value === undefined) delete next[field];
    else next[field] = value;
    writeSpec(next, "text style colour");
  };

  return (
    <div className="inspector-drill text-motion-drill text-look-drill">
      <DrillBack label={backLabel} title="Text style" onClick={onBack} />
      <div className="inspector-drill-scroll text-motion-scroll">
        <DrillGroup label="Apply to">
          <SegmentedRow
            className="text-motion-scope-segments"
            ariaLabel="Text style scope"
            options={SCOPE_OPTIONS}
            value={scopeChoice}
            onChange={setScopeChoice}
          />
          <p className="text-motion-scope-hint">
            {scopeChoice === "all"
              ? "Sets the base style while keeping line exceptions."
              : `${itemLabel} can differ from All lines.`}
          </p>
        </DrillGroup>

        {showCodedWarning && (
          <section className="text-motion-coded-warning" aria-label="Coded text style warning">
            <p>
              {namedLookCopy(codedLookNames)} {codedLookNames.length === 1 ? "sets" : "set"}
              {" their own coded style. Leave it in place or let this inspector override it."}
            </p>
            <div className="text-motion-coded-actions">
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setWarningDismissed(true);
                  onLeaveCodedLook?.();
                }}
              >
                Leave it
              </button>
              <button
                type="button"
                className="btn small primary"
                disabled={disabled}
                onClick={() => {
                  const next = structuredClone(doc);
                  next.textLookForce = true;
                  void writeDoc({
                    preview: next,
                    history: "override coded text style",
                    baseline: doc,
                    applyToCurrent: (current) => ({ ...current, textLookForce: true }),
                  });
                  onOverrideCodedLook?.(true);
                }}
              >
                Override
              </button>
            </div>
          </section>
        )}

        {doc.textLookForce && !showCodedWarning && (
          <section className="text-motion-coded-warning active" aria-label="Coded style override">
            <p>The inspector is overriding this scene's coded text style.</p>
            <button
              type="button"
              className="btn small"
              disabled={disabled}
              onClick={() => {
                const next = structuredClone(doc);
                delete next.textLookForce;
                void writeDoc({
                  preview: next,
                  history: "use coded text style",
                  baseline: doc,
                  applyToCurrent: (current) => {
                    const applied = structuredClone(current);
                    delete applied.textLookForce;
                    return applied;
                  },
                });
                onOverrideCodedLook?.(false);
              }}
            >
              Use coded style
            </button>
          </section>
        )}

        <DrillGroup label="Preset">
          <section
            className="text-motion-preset-grid text-look-preset-grid"
            aria-label={`${scopeChoice === "all" ? "All lines" : itemLabel} style preset`}
          >
            <button
              type="button"
              aria-pressed={current === undefined}
              className={`text-motion-preset-card${current === undefined ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => choosePreset("theme")}
            >
              <span>
                <TextLookIcon look="theme" />
                {scopeChoice === "item" ? "Match the other lines" : "Reset to theme style"}
              </span>
              <small>
                {scopeChoice === "item" ? "Follow All lines" : "Remove the scene override"}
              </small>
            </button>
            {TEXT_LOOK_CATALOG.map((entry) => (
              <button
                key={entry.preset}
                type="button"
                aria-pressed={current?.preset === entry.preset}
                className={`text-motion-preset-card${
                  current?.preset === entry.preset ? " selected" : ""
                }`}
                disabled={disabled}
                title={entry.hint}
                onClick={() => choosePreset(entry.preset)}
              >
                <span>
                  <TextLookIcon look={entry.preset} />
                  {entry.label}
                </span>
                <small>{entry.hint}</small>
              </button>
            ))}
          </section>
        </DrillGroup>

        {current && current.preset !== "none" && meta && (
          <>
            {(meta.hasColorA || meta.hasColorB) && (
              <DrillGroup label="Colours">
                {meta.hasColorA && (
                  <div className="popover-row text-inspector-colour-row">
                    <span className="action-row-icon">
                      <TextControlIcon type="colour" />
                    </span>
                    <span className="popover-inline">{colourALabel}</span>
                    <span className="action-row-value">{colourA.toUpperCase()}</span>
                    <ColourPicker
                      value={colourA}
                      defaultValue={colourADefault}
                      label={`Style ${colourALabel.toLowerCase()}`}
                      disabled={disabled}
                      theme={theme}
                      onCommit={(hex) => commitColour("colorA", hex)}
                      onReset={
                        current.colorA !== undefined
                          ? () => commitColour("colorA", undefined)
                          : undefined
                      }
                    />
                  </div>
                )}
                {meta.hasColorB && (
                  <div className="popover-row text-inspector-colour-row">
                    <span className="action-row-icon">
                      <TextControlIcon type="colour" />
                    </span>
                    <span className="popover-inline">Stop B</span>
                    <span className="action-row-value">{colourB.toUpperCase()}</span>
                    <ColourPicker
                      value={colourB}
                      defaultValue={darkenedStopB(colourA)}
                      label="Gradient stop B"
                      disabled={disabled}
                      theme={theme}
                      onCommit={(hex) => commitColour("colorB", hex)}
                      onReset={
                        current.colorB !== undefined
                          ? () => commitColour("colorB", undefined)
                          : undefined
                      }
                    />
                  </div>
                )}
              </DrillGroup>
            )}

            {(meta.hasAngle ||
              meta.hasStroke ||
              meta.hasHollow ||
              meta.hasIntensity ||
              meta.hasOffset ||
              meta.hasCurve) && (
              <DrillGroup label="Preset controls">
                {meta.hasAngle && (
                  <InspectorSliderRow
                    icon={<LookParamIcon type="angle" />}
                    label="Angle"
                    min={0}
                    max={360}
                    step={5}
                    disabled={disabled}
                    {...slider(
                      "angle",
                      current.angleDeg ?? DEFAULT_LOOK_ANGLE_DEG,
                      (spec, angleDeg) => ({ ...spec, angleDeg }),
                      "text style angle",
                    )}
                  />
                )}
                {meta.hasStroke && (
                  <InspectorSliderRow
                    icon={<LookParamIcon type="stroke" />}
                    label="Stroke"
                    min={0.005}
                    max={0.12}
                    step={0.005}
                    disabled={disabled}
                    {...slider(
                      "stroke",
                      current.strokeEm ?? DEFAULT_LOOK_STROKE_EM,
                      (spec, strokeEm) => ({ ...spec, strokeEm }),
                      "text style stroke",
                    )}
                  />
                )}
                {meta.hasIntensity && (
                  <InspectorSliderRow
                    icon={<LookParamIcon type="intensity" />}
                    label="Intensity"
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={disabled}
                    {...slider(
                      "intensity",
                      current.intensity ?? DEFAULT_LOOK_INTENSITY,
                      (spec, intensity) => ({ ...spec, intensity }),
                      "text style intensity",
                    )}
                  />
                )}
                {meta.hasOffset && (
                  <InspectorSliderRow
                    icon={<LookParamIcon type="offset" />}
                    label="Offset"
                    min={0}
                    max={0.2}
                    step={0.005}
                    disabled={disabled}
                    {...slider(
                      "offset",
                      current.offsetEm ?? DEFAULT_LOOK_OFFSET_EM,
                      (spec, offsetEm) => ({ ...spec, offsetEm }),
                      "text style offset",
                    )}
                  />
                )}
                {meta.hasCurve && (
                  <InspectorSliderRow
                    icon={<LookParamIcon type="curve" />}
                    label="Curve"
                    min={-180}
                    max={180}
                    step={5}
                    disabled={disabled}
                    {...slider(
                      "curve",
                      current.curveDeg ?? DEFAULT_LOOK_CURVE_DEG,
                      (spec, curveDeg) => ({ ...spec, curveDeg }),
                      "text style curve",
                    )}
                  />
                )}
                {meta.hasHollow && (
                  <ToggleRow
                    icon={<TextLookIcon look="outline" />}
                    label="Hollow"
                    description="Hide the fill and keep only the stroke."
                    checked={current.hollow ?? DEFAULT_LOOK_HOLLOW}
                    disabled={disabled}
                    onChange={(hollow) => writeSpec({ ...current, hollow }, "text style hollow")}
                  />
                )}
              </DrillGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}
