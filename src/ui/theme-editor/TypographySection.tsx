import { useState } from "react";
import { FontPicker } from "../FontPicker";
import { Field, IconOptions, NumberField, Section } from "./fields";
import { getIn, readFontSlot, SCALE_RANGE, setIn, type ThemeDoc } from "./themeDraft";

/** Typography: the two faces every scene draws with, plus the type scale. The picker is the app's own FontPicker, so bundled OFL faces, installed system faces and recents behave identically to the theme-fonts pane it replaces. */
export function TypographySection({
  doc,
  onPatch,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
}) {
  const [slot, setSlot] = useState<"headline" | "body">("headline");
  const headline = readFontSlot(doc, "headline", 600);
  const body = readFontSlot(doc, "body", 400);
  const current = slot === "headline" ? headline : body;
  const rawScale = getIn(doc, ["typography", "scale"]);
  const scale = typeof rawScale === "number" && Number.isFinite(rawScale) ? rawScale : 1.25;

  return (
    <Section
      title="Typography"
      hint="System faces are pinned into the workspace on first use, so exports never drift with macOS updates."
    >
      <Field label="Face" icon="typography">
        <IconOptions
          label="Font slot"
          value={slot}
          onChange={setSlot}
          options={[
            {
              id: "headline",
              label: `Headline: ${headline.family} ${headline.weight}`,
              icon: "headline",
            },
            { id: "body", label: `Body: ${body.family} ${body.weight}`, icon: "body" },
          ]}
        />
      </Field>

      <div className="theme-editor-font-picker">
        <FontPicker
          value={current}
          onPick={(ref) =>
            onPatch(
              setIn(
                setIn(doc, ["typography", slot, "family"], ref.family),
                ["typography", slot, "weight"],
                ref.weight,
              ),
            )
          }
        />
      </div>

      <Field
        label="Scale"
        icon="scale"
        hint="Ratio between steps of the type ramp; 1.25 is the house default."
      >
        <NumberField
          label="Type scale"
          value={scale}
          min={SCALE_RANGE.min}
          max={SCALE_RANGE.max}
          step={0.05}
          onCommit={(next) => onPatch(setIn(doc, ["typography", "scale"], next ?? SCALE_RANGE.min))}
        />
      </Field>
    </Section>
  );
}
