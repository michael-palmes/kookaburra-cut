import { moveInList } from "../../engine/catalogueOrder";
import type { Theme } from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import { Field, IconButton, Section } from "./fields";
import { ThemeEditorIcon } from "./icons";
import {
  COLOUR_SLOTS,
  readChartColours,
  readColour,
  setIn,
  type ThemeDoc,
  writeChartColours,
} from "./themeDraft";

const SLOT_LABELS: Record<(typeof COLOUR_SLOTS)[number], string> = {
  background: "Background",
  text: "Text",
  accent: "Accent",
  muted: "Muted",
};

const SLOT_HINTS: Record<(typeof COLOUR_SLOTS)[number], string> = {
  background: "The scene's ground colour, and the fallback when no background block renders.",
  text: "Headlines and body copy.",
  accent: "The one colour that carries emphasis.",
  muted: "Secondary copy, rules and inactive marks.",
};

/** Colours: the four required tokens plus the chart series palette, all through the app's own ColourPicker so spectrum, eyedropper and recents behave exactly as they do in the inspector. */
export function ColoursSection({
  doc,
  onPatch,
  theme,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
  /** The draft's resolved theme, so the picker's theme-token swatches show the colours being edited. */
  theme: Theme;
}) {
  const chartColours = readChartColours(doc);
  const setChartColours = (next: readonly string[]) => onPatch(writeChartColours(doc, next));

  return (
    <Section
      title="Colours"
      hint="Four tokens every scene reads, and the series palette charts wrap over."
    >
      {COLOUR_SLOTS.map((slot) => (
        <Field key={slot} label={SLOT_LABELS[slot]} icon="colours" hint={SLOT_HINTS[slot]}>
          <span className="theme-editor-colour">
            <ColourPicker
              size="md"
              theme={theme}
              label={`${SLOT_LABELS[slot]} colour`}
              value={readColour(doc, slot, theme.colors[slot])}
              onCommit={(hex) => onPatch(setIn(doc, ["colors", slot], hex))}
            />
            <code>{readColour(doc, slot, theme.colors[slot])}</code>
          </span>
        </Field>
      ))}

      <Field
        label="Chart colours"
        icon="chart"
        hint="Series wrap over this list in order. Clear the last one to fall back to the derived accent ramp."
      >
        <div className="theme-editor-swatch-list">
          {chartColours.map((colour, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position IS the identity here, colours repeat
            <div key={index} className="theme-editor-swatch-row">
              <span className="theme-editor-swatch-index">{index + 1}</span>
              <ColourPicker
                theme={theme}
                label={`Chart colour ${index + 1}`}
                value={colour}
                onCommit={(hex) =>
                  setChartColours(chartColours.map((c, i) => (i === index ? hex : c)))
                }
              />
              <code>{colour}</code>
              <button
                type="button"
                className="theme-editor-icon-button"
                aria-label={`Move chart colour ${index + 1} up`}
                disabled={index === 0}
                onClick={() => setChartColours(moveInList(chartColours, index, index - 1))}
              >
                <ThemeEditorIcon name="order" size={14} />
              </button>
              <button
                type="button"
                className="theme-editor-icon-button danger"
                aria-label={`Remove chart colour ${index + 1}`}
                disabled={chartColours.length <= 1}
                onClick={() => setChartColours(chartColours.filter((_, i) => i !== index))}
              >
                <ThemeEditorIcon name="remove" size={14} />
              </button>
            </div>
          ))}
          <IconButton
            icon="add"
            label="Add colour"
            onClick={() =>
              setChartColours([...chartColours, chartColours.at(-1) ?? theme.colors.accent])
            }
          />
        </div>
      </Field>
    </Section>
  );
}
