import { EASE_NAMES } from "../../engine/ease";
import type { TextAnimationSpec, Theme } from "../../theme/tokens";
import { TextMotionPanel } from "../TextAnimationPicker";
import { Field, IconSelect, NumberField, Section } from "./fields";
import {
  CARD_RADIUS_RANGE,
  DURATION_KEYS,
  DURATION_RANGE,
  type DurationKey,
  EASING_KEYS,
  type EasingKey,
  readCardRadius,
  readDuration,
  readEasing,
  setIn,
  type ThemeDoc,
} from "./themeDraft";

const DURATION_LABELS: Record<DurationKey, string> = {
  fast: "Fast",
  base: "Base",
  slow: "Slow",
};

const DURATION_HINTS: Record<DurationKey, string> = {
  fast: "Small state changes: a chip settling, a value ticking over.",
  base: "The default beat: most entrances and exits.",
  slow: "Deliberate moves: hero reveals, camera-scale gestures.",
};

const EASING_LABELS: Record<EasingKey, string> = {
  standard: "Standard",
  emphasized: "Emphasized",
};

const EASE_OPTIONS = EASE_NAMES.map((name) => ({ id: name, label: name }));

/** Motion: the durations and easings every toolkit primitive reads, the theme-level text-motion default, and the card corner radius. Easing names come from `engine/ease.ts`, whose curves are part of the export contract, so the field is a closed list rather than free text. */
export function MotionSection({
  doc,
  onPatch,
  theme,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
  theme: Theme;
}) {
  const radius = readCardRadius(doc);
  const textAnimation = theme.textAnimation;

  return (
    <Section
      title="Motion"
      hint="One motion vocabulary for the whole theme: how long things take, how they accelerate, and how text arrives."
    >
      {DURATION_KEYS.map((key) => (
        <Field
          key={key}
          label={`${DURATION_LABELS[key]} duration`}
          icon="duration"
          hint={DURATION_HINTS[key]}
        >
          <NumberField
            label={`${DURATION_LABELS[key]} duration`}
            value={readDuration(doc, key, 0)}
            min={DURATION_RANGE.min}
            max={DURATION_RANGE.max}
            step={10}
            suffix="ms"
            onCommit={(next) =>
              onPatch(setIn(doc, ["motion", "durations", key], next ?? DURATION_RANGE.min))
            }
          />
        </Field>
      ))}

      {EASING_KEYS.map((key) => (
        <Field key={key} label={`${EASING_LABELS[key]} easing`} icon="ease">
          <IconSelect
            icon="ease"
            label={`${EASING_LABELS[key]} easing`}
            value={readEasing(doc, key, "outQuad")}
            options={EASE_OPTIONS}
            onChange={(next) => onPatch(setIn(doc, ["motion", "easings", key], next))}
          />
        </Field>
      ))}

      <Field
        label="Card radius"
        icon="radius"
        hint="Corner radius as a fraction of the card's short side. Empty leaves the engine default."
      >
        <NumberField
          label="Card radius"
          value={radius}
          min={CARD_RADIUS_RANGE.min}
          max={CARD_RADIUS_RANGE.max}
          step={0.01}
          allowEmpty
          onCommit={(next) => onPatch(setIn(doc, ["card", "radius"], next ?? undefined))}
        />
      </Field>

      <Field
        label="Text motion"
        icon="motion"
        hint="The theme's default text entrance. The first card clears the block, leaving the engine default."
      >
        <div className="theme-editor-text-motion">
          {/* No reference theme: this IS the theme, so the panel's first card reads as "no block". */}
          <TextMotionPanel
            current={textAnimation}
            theme={undefined}
            codedMotion={false}
            force={false}
            onForce={() => {}}
            onLive={(spec: TextAnimationSpec | undefined) =>
              onPatch(setIn(doc, ["textAnimation"], spec))
            }
          />
        </div>
      </Field>
    </Section>
  );
}
