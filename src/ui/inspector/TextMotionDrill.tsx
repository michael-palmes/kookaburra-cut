import { useRef, useState } from "react";
import { EASE_NAMES } from "../../engine/ease";
import type { SceneDoc, SceneManagedTextItemType } from "../../engine/sceneDocSchema";
import type { TextAnimationSpec } from "../../theme/tokens";
import {
  DEFAULT_START_SCALE,
  STATIC_TEXT_PRESET,
  type TextDirection,
  type TextPresetName,
  TWIST_START_SCALE,
} from "../../toolkit/text/presets";
import {
  DELIVERY_DEFAULT_MS,
  type DeliveryChoice,
  formatDelaySeconds,
  TEXT_PRESET_CATALOG,
} from "../textAnimationOptions";
import type { ManagedTextWrite } from "./ManagedTextDrill";
import { TextScopeIcon } from "./ManagedTextDrill";
import {
  rebaseTextMotionSpec,
  setTextMotionSpec,
  type TextMotionScope,
  textMotionSpec,
} from "./managedTextEditorModel";
import {
  DrillBack,
  DrillGroup,
  InspectorSliderRow,
  type SegmentedOption,
  SegmentedRow,
  ToggleRow,
} from "./rows";

export type TextMotionScopeChoice = "all" | "item";

export interface TextMotionDrillProps {
  doc: SceneDoc;
  itemKey: string;
  itemType: SceneManagedTextItemType;
  itemLabel?: string;
  /** Mounted code-owned item motion shown before an explicit sidecar exception exists. */
  resolvedItemMotion?: TextAnimationSpec;
  initialScope?: TextMotionScopeChoice;
  codedMotionNames?: readonly string[];
  backLabel?: string;
  onBack: () => void;
  writeDoc: ManagedTextWrite;
  onLeaveCodedMotion?: () => void;
  onOverrideCodedMotion?: (override: boolean) => void;
  disabled?: boolean;
}

const SCOPE_OPTIONS: SegmentedOption<TextMotionScopeChoice>[] = [
  { value: "all", label: "All lines", icon: <TextScopeIcon scope="all" /> },
  { value: "item", label: "This line", icon: <TextScopeIcon scope="item" /> },
];

const DIRECTION_OPTIONS: SegmentedOption<TextDirection>[] = [
  { value: "from-left", label: "Left" },
  { value: "from-right", label: "Right" },
];

const TEXT_DELIVERY_OPTIONS: readonly { id: DeliveryChoice; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "all-at-once", label: "All at once" },
  { id: "word", label: "By word" },
  { id: "char", label: "By letter" },
  { id: "by-paragraph", label: "By line" },
];

function MotionControlIcon({
  type,
}: {
  type: "stagger" | "duration" | "distance" | "scale" | "delay";
}) {
  const glyph =
    type === "stagger" ? (
      <path d="M3 4h3v3H3zM7 6.5h3v3H7zM11 9h3v3h-3z" />
    ) : type === "duration" ? (
      <>
        <circle cx="8" cy="8.5" r="5" />
        <path d="M8 5.5v3l2 1.5M6 2h4" />
      </>
    ) : type === "delay" ? (
      <>
        <path d="M2.5 3.5v9" />
        <path d="M5.5 8H13M10.5 5.5 13 8l-2.5 2.5" />
      </>
    ) : type === "distance" ? (
      <>
        <path d="M2.5 8h11" />
        <path d="m5 5.5-2.5 2.5L5 10.5M11 5.5 13.5 8 11 10.5" />
      </>
    ) : (
      <>
        <rect x="4" y="4" width="8" height="8" rx="1" />
        <path d="M2.5 5.5v-3h3M13.5 10.5v3h-3M5.5 2.5l-3 3M10.5 13.5l3-3" />
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

function motionSeed(current: TextAnimationSpec | undefined): TextAnimationSpec {
  return current ? structuredClone(current) : { in: "fade", out: "none", staggerMs: 0 };
}

export function motionSpecForPreset(
  current: TextAnimationSpec | undefined,
  preset: TextPresetName,
): TextAnimationSpec {
  const seed = motionSeed(current);
  if (preset === STATIC_TEXT_PRESET) {
    const next = { ...seed, in: STATIC_TEXT_PRESET, out: STATIC_TEXT_PRESET, staggerMs: 0 };
    delete next.stagger;
    delete next.delivery;
    return next;
  }
  const next = {
    ...seed,
    in: preset,
    out: seed.out === STATIC_TEXT_PRESET ? "none" : seed.out,
  };
  if (preset === "scatter-scale") {
    next.stagger = "char";
    next.staggerMs = seed.staggerMs > 0 ? seed.staggerMs : DELIVERY_DEFAULT_MS.char;
    delete next.delivery;
  }
  return next;
}

export function selectedDelivery(spec: TextAnimationSpec | undefined): DeliveryChoice {
  if (!spec) return "default";
  if (spec.stagger) return spec.stagger;
  return spec.delivery ?? "default";
}

export function motionDeliveryChoices(
  itemType: SceneManagedTextItemType,
  preset: string | undefined,
): readonly { id: DeliveryChoice; label: string }[] {
  if (itemType === "icon") {
    return TEXT_DELIVERY_OPTIONS.filter(
      (choice) => choice.id === "default" || choice.id === "all-at-once",
    );
  }
  if (preset === "scatter-scale") {
    return TEXT_DELIVERY_OPTIONS.filter(
      (choice) => choice.id === "default" || choice.id === "char",
    );
  }
  return TEXT_DELIVERY_OPTIONS;
}

export function motionSpecForDelivery(
  current: TextAnimationSpec,
  delivery: DeliveryChoice,
): TextAnimationSpec {
  const next = structuredClone(current);
  delete next.stagger;
  delete next.delivery;
  if (delivery === "default") {
    next.staggerMs = 0;
  } else if (delivery === "all-at-once") {
    next.delivery = "all-at-once";
    next.staggerMs = 0;
  } else if (delivery === "word" || delivery === "char") {
    next.stagger = delivery;
    next.staggerMs = current.staggerMs > 0 ? current.staggerMs : DELIVERY_DEFAULT_MS[delivery];
  } else {
    next.delivery = delivery;
    next.staggerMs = current.staggerMs > 0 ? current.staggerMs : DELIVERY_DEFAULT_MS[delivery];
  }
  return next;
}

function namedMotionCopy(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "This line";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function TextMotionDrill({
  doc,
  itemKey,
  itemType,
  itemLabel = "Selected line",
  resolvedItemMotion,
  initialScope = "all",
  codedMotionNames = [],
  backLabel = "Text",
  onBack,
  writeDoc,
  onLeaveCodedMotion,
  onOverrideCodedMotion,
  disabled = false,
}: TextMotionDrillProps) {
  const [scopeChoice, setScopeChoice] = useState<TextMotionScopeChoice>(initialScope);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const baselines = useRef(new Map<string, SceneDoc>());
  const scope: TextMotionScope =
    scopeChoice === "all" ? { kind: "all" } : { kind: "item", itemKey };
  const resolvedSpec = (source: SceneDoc) =>
    textMotionSpec(source, scope) ??
    (scope.kind === "item" && !source.textAnimationForce ? resolvedItemMotion : undefined);
  const current = resolvedSpec(doc);
  const delivery = selectedDelivery(current);
  const meta = TEXT_PRESET_CATALOG.find((entry) => entry.preset === current?.in);
  const twistScale = current?.in === "twist-scale";
  const deliveryChoices = motionDeliveryChoices(itemType, current?.in);
  const showCodedWarning =
    codedMotionNames.length > 0 && !doc.textAnimationForce && !warningDismissed;

  const writeSpec = (
    spec: TextAnimationSpec | undefined,
    history: string,
    baseline = doc,
    live = false,
    historyFromBaseline = false,
  ) => {
    if (disabled) return;
    const next = setTextMotionSpec(baseline, scope, spec);
    const baselineSpec = resolvedSpec(baseline);
    void writeDoc({
      preview: next,
      history: live ? false : history,
      baseline,
      historyFromBaseline,
      applyToCurrent: (current) =>
        setTextMotionSpec(
          current,
          scope,
          rebaseTextMotionSpec(resolvedSpec(current), baselineSpec, spec),
        ),
    });
  };

  const slider = (
    key: string,
    value: number,
    update: (spec: TextAnimationSpec, value: number) => TextAnimationSpec,
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

  const choosePreset = (preset: TextPresetName | "theme") => {
    if (preset === "theme") writeSpec(undefined, "follow theme text motion");
    else writeSpec(motionSpecForPreset(current, preset), "change text motion preset");
  };

  return (
    <div className="inspector-drill text-motion-drill">
      <DrillBack label={backLabel} title="Text motion" onClick={onBack} />
      <div className="inspector-drill-scroll text-motion-scroll">
        <DrillGroup label="Apply to">
          <SegmentedRow
            className="text-motion-scope-segments"
            ariaLabel="Text motion scope"
            options={SCOPE_OPTIONS}
            value={scopeChoice}
            onChange={setScopeChoice}
          />
          <p className="text-motion-scope-hint">
            {scopeChoice === "all"
              ? "Sets the base motion while keeping line exceptions."
              : `${itemLabel} can differ from All lines.`}
          </p>
        </DrillGroup>

        {showCodedWarning && (
          <section className="text-motion-coded-warning" aria-label="Coded text motion warning">
            <p>
              {namedMotionCopy(codedMotionNames)} {codedMotionNames.length === 1 ? "sets" : "set"}
              {" their own coded motion. Leave it in place or let this inspector override it."}
            </p>
            <div className="text-motion-coded-actions">
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setWarningDismissed(true);
                  onLeaveCodedMotion?.();
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
                  next.textAnimationForce = true;
                  void writeDoc({
                    preview: next,
                    history: "override coded text motion",
                    baseline: doc,
                    applyToCurrent: (current) => ({ ...current, textAnimationForce: true }),
                  });
                  onOverrideCodedMotion?.(true);
                }}
              >
                Override
              </button>
            </div>
          </section>
        )}

        {doc.textAnimationForce && !showCodedWarning && (
          <section className="text-motion-coded-warning active" aria-label="Coded motion override">
            <p>The inspector is overriding this scene’s coded text motion.</p>
            <button
              type="button"
              className="btn small"
              disabled={disabled}
              onClick={() => {
                const next = structuredClone(doc);
                delete next.textAnimationForce;
                void writeDoc({
                  preview: next,
                  history: "use coded text motion",
                  baseline: doc,
                  applyToCurrent: (current) => {
                    const applied = structuredClone(current);
                    delete applied.textAnimationForce;
                    return applied;
                  },
                });
                onOverrideCodedMotion?.(false);
              }}
            >
              Use coded motion
            </button>
          </section>
        )}

        <DrillGroup label="Preset">
          <section
            className="text-motion-preset-grid"
            aria-label={`${scopeChoice === "all" ? "All lines" : itemLabel} motion preset`}
          >
            <button
              type="button"
              aria-pressed={current === undefined}
              className={`text-motion-preset-card${current === undefined ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => choosePreset("theme")}
            >
              <span>
                {scopeChoice === "item" ? "Match the other lines" : "Reset to theme motion"}
              </span>
              <small>
                {scopeChoice === "item" ? "Follow All lines" : "Remove the scene override"}
              </small>
            </button>
            <button
              type="button"
              aria-pressed={current?.in === STATIC_TEXT_PRESET}
              className={`text-motion-preset-card${
                current?.in === STATIC_TEXT_PRESET ? " selected" : ""
              }`}
              disabled={disabled}
              onClick={() => choosePreset(STATIC_TEXT_PRESET)}
            >
              <span>None</span>
              <small>Static text</small>
            </button>
            {TEXT_PRESET_CATALOG.filter((entry) => entry.preset !== "none").map((entry) => (
              <button
                key={entry.preset}
                type="button"
                aria-pressed={current?.in === entry.preset}
                className={`text-motion-preset-card${
                  current?.in === entry.preset ? " selected" : ""
                }`}
                disabled={disabled}
                title={entry.hint}
                onClick={() => choosePreset(entry.preset)}
              >
                <span>{entry.label}</span>
                <small>{entry.hint}</small>
              </button>
            ))}
          </section>
        </DrillGroup>

        {current &&
          current.in !== STATIC_TEXT_PRESET &&
          (meta?.hasScaleParams || meta?.hasDirection || twistScale) && (
            <DrillGroup label="Preset controls">
              {(meta?.hasScaleParams || twistScale) && (
                <InspectorSliderRow
                  icon={<MotionControlIcon type="scale" />}
                  label="Start size"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  {...slider(
                    "start-scale",
                    current.startScale ?? (twistScale ? TWIST_START_SCALE : DEFAULT_START_SCALE),
                    (spec, startScale) => ({ ...spec, startScale }),
                    "text motion start scale",
                  )}
                />
              )}
              {twistScale && (
                <InspectorSliderRow
                  icon={<MotionControlIcon type="duration" />}
                  label="Duration"
                  min={100}
                  max={4_000}
                  step={50}
                  {...slider(
                    "twist-duration",
                    current.durationMs ?? 600,
                    (spec, durationMs) => ({ ...spec, durationMs }),
                    "text motion duration",
                  )}
                />
              )}
              {meta?.hasDirection && (
                <SegmentedRow
                  className="text-motion-direction-segments"
                  ariaLabel="Text motion direction"
                  options={DIRECTION_OPTIONS}
                  value={current.direction ?? "from-left"}
                  onChange={(direction) =>
                    writeSpec({ ...current, direction }, "change text motion direction")
                  }
                />
              )}
              {(meta?.hasScaleParams || twistScale) && (
                <ToggleRow
                  label="Shine"
                  description="Sweep a soft highlight across the text as it lands."
                  checked={current.shine ?? false}
                  disabled={disabled}
                  onChange={(shine) => writeSpec({ ...current, shine }, "change text motion shine")}
                />
              )}
            </DrillGroup>
          )}
      </div>

      {current && current.in !== STATIC_TEXT_PRESET && (
        <div className="text-motion-footer">
          <DrillGroup label="Delivery">
            <section className="text-motion-delivery-grid" aria-label="Delivery">
              {deliveryChoices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={`chip${delivery === choice.id ? " selected" : ""}`}
                  aria-pressed={delivery === choice.id}
                  disabled={disabled}
                  onClick={() =>
                    writeSpec(
                      motionSpecForDelivery(current, choice.id),
                      "change text motion delivery",
                    )
                  }
                >
                  {choice.label}
                </button>
              ))}
            </section>
            {delivery !== "default" && delivery !== "all-at-once" && (
              <InspectorSliderRow
                icon={<MotionControlIcon type="stagger" />}
                label="Stagger"
                min={0}
                max={2_000}
                step={5}
                {...slider(
                  "stagger",
                  current.staggerMs,
                  (spec, staggerMs) => ({ ...spec, staggerMs }),
                  "text motion stagger",
                )}
              />
            )}
          </DrillGroup>

          <DrillGroup label="Timing and travel">
            {!twistScale && (
              <InspectorSliderRow
                icon={<MotionControlIcon type="duration" />}
                label="Duration"
                min={100}
                max={4_000}
                step={50}
                {...slider(
                  "duration",
                  current.durationMs ?? 600,
                  (spec, durationMs) => ({ ...spec, durationMs }),
                  "text motion duration",
                )}
              />
            )}
            <InspectorSliderRow
              icon={<MotionControlIcon type="distance" />}
              label="Distance"
              min={0}
              max={4}
              step={0.05}
              {...slider(
                "distance",
                current.distance ?? 1,
                (spec, distance) => ({ ...spec, distance }),
                "text motion distance",
              )}
            />
            <InspectorSliderRow
              icon={<MotionControlIcon type="delay" />}
              label="Delay start"
              min={0}
              max={3}
              step={0.05}
              overflowMax
              formatValue={(seconds) => formatDelaySeconds(seconds * 1000)}
              {...slider(
                "delay",
                (current.delayMs ?? 0) / 1000,
                (spec, seconds) => ({ ...spec, delayMs: Math.round(seconds * 1000) }),
                "text motion delay",
              )}
            />
            <label className="popover-row text-motion-easing-row">
              <span className="popover-inline">Easing</span>
              <select
                className="modal-input"
                aria-label="Text motion easing"
                value={current.ease ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const next = structuredClone(current);
                  if (event.target.value) next.ease = event.target.value;
                  else delete next.ease;
                  writeSpec(next, "change text motion easing");
                }}
              >
                <option value="">Theme</option>
                {EASE_NAMES.map((ease) => (
                  <option key={ease} value={ease}>
                    {ease}
                  </option>
                ))}
              </select>
            </label>
          </DrillGroup>
        </div>
      )}
    </div>
  );
}
