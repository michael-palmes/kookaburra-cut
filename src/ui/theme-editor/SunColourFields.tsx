import type { Theme } from "../../theme/tokens";
import { Field, IconSelect, NumberField } from "./fields";
import { getIn, setIn, sunPath, type ThemeDoc } from "./themeDraft";

export function SunColourFields({
  doc,
  theme,
  onPatch,
}: {
  doc: ThemeDoc;
  theme: Theme;
  onPatch: (next: ThemeDoc) => void;
}) {
  const path = sunPath(doc);
  const kelvin = getIn(doc, [...path, "kelvin"]);
  const token = getIn(doc, [...path, "colorToken"]);
  return (
    <>
      <Field
        label="Key temperature"
        icon="sun"
        hint="Temperature takes priority over the colour. Clear it to use a theme or custom colour."
      >
        <NumberField
          label="Key temperature"
          value={typeof kelvin === "number" ? kelvin : null}
          min={1000}
          max={20000}
          step={100}
          allowEmpty
          suffix="K"
          onCommit={(value) => onPatch(setIn(doc, [...path, "kelvin"], value ?? undefined))}
        />
      </Field>
      {typeof kelvin !== "number" && (
        <Field label="Key colour source" icon="colours">
          <IconSelect
            icon="colours"
            label="Key colour source"
            value={typeof token === "string" ? token : ""}
            options={[
              { id: "", label: "Custom colour" },
              ...Object.keys(theme.colors).map((id) => ({ id, label: `Theme ${id}` })),
            ]}
            onChange={(value) => onPatch(setIn(doc, [...path, "colorToken"], value || undefined))}
          />
        </Field>
      )}
    </>
  );
}
