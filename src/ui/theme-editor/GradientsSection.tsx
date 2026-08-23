import { gradientCss } from "../../theme/gradientPresets";
import type { GradientSpec, Theme } from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import {
  Field,
  IconButton,
  IconOptions,
  IconToggle,
  NumberField,
  Section,
  TextField,
} from "./fields";
import { ThemeEditorIcon } from "./icons";
import {
  defaultGradientStops,
  type GradientEntry,
  readGradients,
  type ThemeDoc,
  uniqueGradientName,
  writeGradients,
} from "./themeDraft";

type Stop = [string, number];

const replaceStop = (stops: readonly Stop[], at: number, next: Stop): Stop[] =>
  stops.map((stop, index) => (index === at ? next : stop));

/** Gradients: the theme's named gradient library, the names a backdrop or background block references. The bundled GradientPicker is a scene-background modal (it writes inline specs into a sidecar), so this is its own compact stop editor over the same `GradientSpec` shape and the same `gradientCss` preview. */
export function GradientsSection({
  doc,
  onPatch,
  theme,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
  theme: Theme;
}) {
  const entries = readGradients(doc);
  const commit = (next: readonly GradientEntry[]) => onPatch(writeGradients(doc, next));
  const patchAt = (index: number, patch: Partial<GradientEntry>) =>
    commit(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  return (
    <Section
      title="Gradients"
      hint="Named gradients any backdrop or background block can reference by name."
    >
      {entries.length === 0 && (
        <p className="theme-editor-empty">
          No gradients yet. Add one to reference it from a backdrop or background.
        </p>
      )}

      {entries.map((entry, index) => {
        const spec: GradientSpec = {
          type: entry.type,
          angleDeg: entry.angleDeg,
          stops: entry.stops,
          ...(entry.space ? { space: entry.space } : {}),
        };
        return (
          <article key={entry.name} className="theme-editor-gradient">
            <div
              className="theme-editor-gradient-preview"
              style={{ background: gradientCss(spec) }}
              aria-hidden="true"
            />
            <div className="theme-editor-gradient-body">
              <Field label="Name" icon="label">
                <span className="theme-editor-inline">
                  <TextField
                    label={`Gradient ${index + 1} name`}
                    value={entry.name}
                    onCommit={(name) =>
                      patchAt(index, { name: uniqueGradientName(entries, name, index) })
                    }
                  />
                  <IconButton
                    icon="remove"
                    label="Delete"
                    danger
                    onClick={() => commit(entries.filter((_, i) => i !== index))}
                  />
                </span>
              </Field>

              <Field label="Type" icon="linear">
                <span className="theme-editor-inline">
                  <IconOptions
                    label={`Gradient ${index + 1} type`}
                    value={entry.type}
                    onChange={(type) => patchAt(index, { type })}
                    options={[
                      { id: "linear", label: "Linear", icon: "linear" },
                      { id: "radial", label: "Radial", icon: "radial" },
                    ]}
                  />
                  <IconToggle
                    icon="colours"
                    label="OKLCH"
                    checked={entry.space === "oklch"}
                    onChange={(on) => patchAt(index, { space: on ? "oklch" : undefined })}
                  />
                </span>
              </Field>

              {entry.type === "linear" && (
                <Field label="Angle" icon="angle">
                  <NumberField
                    label={`Gradient ${index + 1} angle`}
                    value={entry.angleDeg}
                    min={0}
                    max={360}
                    step={5}
                    suffix="deg"
                    onCommit={(angleDeg) => patchAt(index, { angleDeg: angleDeg ?? 0 })}
                  />
                </Field>
              )}

              <Field label="Stops" icon="gradients">
                <div className="theme-editor-swatch-list">
                  {entry.stops.map(([colour, position], stopIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: position IS the identity here
                    <div key={stopIndex} className="theme-editor-swatch-row">
                      <ColourPicker
                        theme={theme}
                        label={`Stop ${stopIndex + 1} colour`}
                        value={colour}
                        onCommit={(hex) =>
                          patchAt(index, {
                            stops: replaceStop(entry.stops, stopIndex, [hex, position]),
                          })
                        }
                      />
                      <NumberField
                        label={`Stop ${stopIndex + 1} position`}
                        value={position}
                        min={0}
                        max={1}
                        step={0.05}
                        onCommit={(next) =>
                          patchAt(index, {
                            stops: replaceStop(entry.stops, stopIndex, [colour, next ?? 0]),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="theme-editor-icon-button danger"
                        aria-label={`Remove stop ${stopIndex + 1}`}
                        disabled={entry.stops.length <= 2}
                        onClick={() =>
                          patchAt(index, {
                            stops: entry.stops.filter((_, i) => i !== stopIndex),
                          })
                        }
                      >
                        <ThemeEditorIcon name="remove" size={14} />
                      </button>
                    </div>
                  ))}
                  <IconButton
                    icon="add"
                    label="Add stop"
                    onClick={() => {
                      const last: Stop = [entry.stops.at(-1)?.[0] ?? "#ffffff", 1];
                      patchAt(index, { stops: [...entry.stops, last] });
                    }}
                  />
                </div>
              </Field>
            </div>
          </article>
        );
      })}

      <IconButton
        icon="add"
        label="Add gradient"
        onClick={() =>
          commit([
            ...entries,
            {
              name: uniqueGradientName(entries, "gradient"),
              type: "linear",
              angleDeg: 135,
              stops: defaultGradientStops(),
            },
          ])
        }
      />
    </Section>
  );
}
