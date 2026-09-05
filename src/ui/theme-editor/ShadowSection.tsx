import type { Theme, ThemeShadowSpec } from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import { applyLightingShadowStyle, lightingShadowStyle } from "../inspector/lightingEditorModel";
import { Field, IconButton, IconOptions, IconToggle, NumberField } from "./fields";
import { getIn, isRecord, setIn, type ThemeDoc, writeThemeShadow } from "./themeDraft";

export function ShadowSection({
  doc,
  theme,
  onPatch,
}: {
  doc: ThemeDoc;
  theme: Theme;
  onPatch: (next: ThemeDoc) => void;
}) {
  const saved = getIn(doc, ["lighting", "shadow"]);
  const shadow = theme.lighting?.shadow ?? applyLightingShadowStyle(undefined, "soft-contact");
  const active = isRecord(saved);
  const patch = (values: Partial<ThemeShadowSpec>) =>
    onPatch(writeThemeShadow(doc, { ...shadow, ...values }));
  return (
    <>
      <Field
        label="Shadows"
        icon="shadow"
        hint="Theme defaults for stage catchers and real cast shadows."
      >
        <IconToggle
          icon="shadow"
          offIcon="hidden"
          label={active && shadow.enabled !== false ? "On" : "Off"}
          checked={active && shadow.enabled !== false}
          onChange={(enabled) => patch({ enabled })}
        />
        {active && (
          <IconButton
            icon="revert"
            label="Clear shadow settings"
            onClick={() => onPatch(setIn(doc, ["lighting", "shadow"], undefined))}
          />
        )}
      </Field>
      {active && shadow.enabled !== false && (
        <>
          <Field label="Shadow style" icon="shadow">
            <IconOptions
              label="Shadow style"
              value={lightingShadowStyle(shadow)}
              options={[
                { id: "none", label: "None", icon: "hidden" },
                { id: "soft-contact", label: "Soft contact", icon: "shadow" },
                { id: "cast", label: "Cast", icon: "sun" },
              ]}
              onChange={(style) => patch(applyLightingShadowStyle(shadow, style))}
            />
          </Field>
          <Field label="Strength" icon="shadow">
            <NumberField
              label="Shadow strength"
              value={shadow.opacity}
              min={0}
              max={1}
              step={0.01}
              onCommit={(opacity) => patch({ opacity: opacity ?? 0 })}
            />
          </Field>
          <Field label="Softness" icon="shadow">
            <NumberField
              label="Shadow softness"
              value={shadow.softness}
              min={0}
              max={1}
              step={0.01}
              onCommit={(softness) => patch({ softness: softness ?? 0 })}
            />
          </Field>
          <Field label="Shadow colour" icon="colours">
            <ColourPicker
              theme={theme}
              label="Shadow colour"
              value={shadow.color ?? "#000000"}
              onCommit={(color) => patch({ color })}
            />
          </Field>
          <Field label="Catch on background" icon="background">
            <IconToggle
              icon="background"
              offIcon="hidden"
              label={shadow.catchBackdrop !== false ? "On" : "Off"}
              checked={shadow.catchBackdrop !== false}
              onChange={(catchBackdrop) => patch({ catchBackdrop })}
            />
          </Field>
          <Field label="Shadow map size" icon="scale">
            <IconOptions
              label="Shadow map size"
              value={String(shadow.mapSize)}
              options={[1024, 2048, 4096].map((size) => ({
                id: String(size),
                label: String(size),
                icon: "shadow" as const,
              }))}
              onChange={(size) => patch({ mapSize: Number(size) })}
            />
          </Field>
          <Field label="Shadow bias" icon="position">
            <NumberField
              label="Shadow bias"
              value={shadow.bias}
              step={0.0001}
              onCommit={(bias) => patch({ bias: bias ?? 0 })}
            />
          </Field>
        </>
      )}
    </>
  );
}
