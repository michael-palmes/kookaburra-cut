import { Field, IconToggle, NumberField, Section, TextField } from "./fields";
import type { ThemeEditorIconName } from "./icons";
import {
  EFFECT_DEFAULTS,
  EFFECT_KEYS,
  type EffectKey,
  readEffect,
  type ThemeDoc,
  writeEffect,
} from "./themeDraft";

/** Effects: the theme's project-wide postprocessing default. A theme with no `effects` block renders through the composer-free path, so every effect here is off until it is switched on, and switching one off deletes its block rather than zeroing it. */

interface FieldDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

const EFFECTS: Record<
  EffectKey,
  { label: string; icon: ThemeEditorIconName; hint: string; fields: FieldDef[]; url?: boolean }
> = {
  bloom: {
    label: "Bloom",
    icon: "bloom",
    hint: "Glow on anything brighter than the threshold.",
    fields: [
      { key: "intensity", label: "Intensity", min: 0, max: 5, step: 0.05 },
      { key: "luminanceThreshold", label: "Threshold", min: 0, max: 1, step: 0.01 },
      { key: "luminanceSmoothing", label: "Smoothing", min: 0, max: 1, step: 0.01 },
    ],
  },
  vignette: {
    label: "Vignette",
    icon: "vignette",
    hint: "Darkens the frame's corners.",
    fields: [
      { key: "offset", label: "Offset", min: 0, max: 1, step: 0.01 },
      { key: "darkness", label: "Darkness", min: 0, max: 1, step: 0.01 },
    ],
  },
  lut: {
    label: "Colour grade",
    icon: "lut",
    hint: "A .cube 3D LUT, resolved against the project that uses the theme.",
    fields: [{ key: "intensity", label: "Intensity", min: 0, max: 1, step: 0.01 }],
    url: true,
  },
  grain: {
    label: "Grain",
    icon: "grain",
    hint: "Film grain, seeded from the frame index so it stays deterministic.",
    fields: [{ key: "intensity", label: "Intensity", min: 0, max: 1, step: 0.01 }],
  },
};

export function EffectsSection({
  doc,
  onPatch,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
}) {
  return (
    <Section
      title="Effects"
      hint="Postprocessing every project on this theme inherits. All off keeps the composer-free render path."
    >
      {EFFECT_KEYS.map((key) => {
        const spec = EFFECTS[key];
        const values = readEffect(doc, key);
        const patch = (field: string, value: number | string) =>
          onPatch(writeEffect(doc, key, { ...(values ?? EFFECT_DEFAULTS[key]), [field]: value }));
        return (
          <Field key={key} label={spec.label} icon={spec.icon} hint={spec.hint}>
            <div className="theme-editor-inline">
              <IconToggle
                icon={spec.icon}
                offIcon="hidden"
                label={values ? "On" : "Off"}
                checked={values !== null}
                onChange={(on) =>
                  onPatch(writeEffect(doc, key, on ? { ...EFFECT_DEFAULTS[key] } : null))
                }
              />
              {values &&
                spec.fields.map((field) => (
                  <NumberField
                    key={field.key}
                    label={`${spec.label} ${field.label.toLocaleLowerCase("en-AU")}`}
                    value={
                      typeof values[field.key] === "number" ? (values[field.key] as number) : 0
                    }
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    suffix={field.label}
                    onCommit={(next) => patch(field.key, next ?? field.min)}
                  />
                ))}
            </div>
            {values && spec.url && (
              <div className="theme-editor-inline theme-editor-effect-url">
                <TextField
                  label="LUT path"
                  value={typeof values.url === "string" ? values.url : ""}
                  placeholder="assets/grade.cube"
                  onCommit={(next) => patch("url", next)}
                />
              </div>
            )}
          </Field>
        );
      })}
    </Section>
  );
}
