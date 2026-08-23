import { BUNDLED_ENVIRONMENT_IDS, NONE_SOURCE, SOFTBOX_SOURCE } from "../../engine/environments";
import type { Theme } from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import {
  Field,
  IconButton,
  IconOptions,
  IconSelect,
  IconToggle,
  NumberField,
  Section,
} from "./fields";
import { ThemeEditorIcon, type ThemeEditorIconName } from "./icons";
import {
  DEFAULT_FILL,
  DEFAULT_SUN,
  defaultLight,
  type FillDraft,
  LIGHT_SPACES,
  LIGHT_TYPES,
  type LightDraft,
  type LightType,
  nextLightId,
  readAmbient,
  readAmbientColor,
  readEnvironment,
  readFills,
  readFixtureSummaries,
  readLights,
  readSun,
  setIn,
  type ThemeDoc,
  writeEnvironment,
  writeFills,
  writeLights,
  writeSun,
} from "./themeDraft";

/** Lighting: the THEME layer of the three-layer rig (theme -> project -> scene). The key light, the ambient wash, the v8 fill list the bundled themes still author, the v9 free lights, and the HDRI environment. Keyframes are scene-level and stay out of this window; fixtures list read-only until a theme needs one. */

const ENVIRONMENT_OPTIONS = [
  { id: "", label: "Inherit (no block)" },
  { id: NONE_SOURCE, label: "None (no reflections)" },
  { id: SOFTBOX_SOURCE, label: "Softbox (procedural)" },
  ...BUNDLED_ENVIRONMENT_IDS.map((id) => ({
    id,
    label: id.slice("kookaburra:".length).replace(/-/g, " "),
  })),
];

const TYPE_ICONS: Record<LightType, ThemeEditorIconName> = {
  directional: "sun",
  point: "light",
  spot: "spot",
  area: "panel",
};

export function LightingSection({
  doc,
  onPatch,
  theme,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
  theme: Theme;
}) {
  const sun = readSun(doc);
  const ambient = readAmbient(doc);
  const ambientColor = readAmbientColor(doc);
  const fills = readFills(doc);
  const lights = readLights(doc);
  const fixtures = readFixtureSummaries(doc);
  const environment = readEnvironment(doc);

  const patchSun = (patch: Partial<NonNullable<typeof sun>>) =>
    onPatch(writeSun(doc, { ...(sun ?? DEFAULT_SUN), ...patch }));
  const patchFill = (index: number, patch: Partial<FillDraft>) =>
    onPatch(
      writeFills(
        doc,
        fills.map((fill, i) => (i === index ? { ...fill, ...patch } : fill)),
      ),
    );
  const patchLight = (index: number, patch: Partial<LightDraft>) =>
    onPatch(
      writeLights(
        doc,
        lights.map((light, i) => (i === index ? { ...light, ...patch } : light)),
      ),
    );

  return (
    <Section
      title="Lighting"
      hint="The theme layer of the lighting stack. A project or a scene can replace any field of it; keyframes live on the scene."
    >
      <Field
        label="Key light"
        icon="sun"
        hint="The sun: one directional light aimed at the origin from an orbit direction."
      >
        <IconToggle
          icon="sun"
          offIcon="hidden"
          label={sun ? "On" : "Off"}
          checked={sun !== null}
          onChange={(on) => onPatch(writeSun(doc, on ? DEFAULT_SUN : null))}
        />
      </Field>

      {sun && (
        <>
          <Field
            label="Key direction"
            icon="angle"
            hint="Azimuth turns it around, elevation lifts it."
          >
            <span className="theme-editor-inline">
              <NumberField
                label="Key azimuth"
                value={sun.azimuthDeg}
                min={-180}
                max={180}
                step={5}
                suffix="az"
                onCommit={(next) => patchSun({ azimuthDeg: next ?? 0 })}
              />
              <NumberField
                label="Key elevation"
                value={sun.elevationDeg}
                min={-90}
                max={90}
                step={5}
                suffix="el"
                onCommit={(next) => patchSun({ elevationDeg: next ?? 0 })}
              />
            </span>
          </Field>

          <Field label="Key intensity" icon="light">
            <span className="theme-editor-inline">
              <NumberField
                label="Key intensity"
                value={sun.intensity}
                min={0}
                max={20}
                step={0.1}
                onCommit={(next) => patchSun({ intensity: next ?? 0 })}
              />
              <ColourPicker
                theme={theme}
                label="Key colour"
                value={sun.color}
                onCommit={(hex) => patchSun({ color: hex })}
              />
              <code>{sun.color}</code>
            </span>
          </Field>

          <Field
            label="Key softness"
            icon="shadow"
            hint="Apparent angular diameter in degrees (the real sun is 0.53); empty keeps the engine default."
          >
            <span className="theme-editor-inline">
              <NumberField
                label="Key angular diameter"
                value={sun.angularDeg}
                min={0}
                max={60}
                step={0.5}
                allowEmpty
                suffix="deg"
                onCommit={(next) => patchSun({ angularDeg: next })}
              />
              <IconToggle
                icon="shadow"
                offIcon="hidden"
                label={sun.castShadow ? "Casts shadow" : "No shadow"}
                checked={sun.castShadow}
                onChange={(castShadow) => patchSun({ castShadow })}
              />
              <IconToggle
                icon="visible"
                offIcon="hidden"
                label={sun.enabled ? "Enabled" : "Muted"}
                checked={sun.enabled}
                onChange={(enabled) => patchSun({ enabled })}
              />
            </span>
          </Field>
        </>
      )}

      <Field
        label="Ambient"
        icon="ambient"
        hint="Flat wash over everything. Empty drops it, which the v8 rig reads as no theme lighting at all."
      >
        <span className="theme-editor-inline">
          <NumberField
            label="Ambient intensity"
            value={ambient}
            min={0}
            max={5}
            step={0.05}
            allowEmpty
            onCommit={(next) => onPatch(setIn(doc, ["lighting", "ambient"], next ?? undefined))}
          />
          <ColourPicker
            theme={theme}
            label="Ambient colour"
            value={ambientColor ?? "#ffffff"}
            onCommit={(hex) => onPatch(setIn(doc, ["lighting", "ambientColor"], hex))}
          />
          {ambientColor && (
            <IconButton
              icon="remove"
              label="Clear tint"
              onClick={() => onPatch(setIn(doc, ["lighting", "ambientColor"], undefined))}
            />
          )}
        </span>
      </Field>

      <Field
        label="Environment"
        icon="environment"
        hint="Image-based reflections. Bundled HDRIs only: a theme cannot reference a project file."
      >
        <IconSelect
          icon="environment"
          label="Environment source"
          value={environment.source}
          onChange={(source) => onPatch(writeEnvironment(doc, { source }))}
          options={ENVIRONMENT_OPTIONS}
        />
      </Field>

      {environment.source !== "" && (
        <Field label="Environment mix" icon="light">
          <span className="theme-editor-inline">
            <NumberField
              label="Environment intensity"
              value={environment.intensity}
              min={0}
              max={5}
              step={0.05}
              onCommit={(next) => onPatch(writeEnvironment(doc, { intensity: next ?? 1 }))}
            />
            <NumberField
              label="Environment rotation"
              value={environment.rotationDeg}
              min={-180}
              max={360}
              step={5}
              suffix="deg"
              onCommit={(next) => onPatch(writeEnvironment(doc, { rotationDeg: next ?? 0 }))}
            />
          </span>
        </Field>
      )}

      <Field
        label="Fills"
        icon="light"
        hint="The v8 fill lights most bundled themes still author: direction, intensity and colour."
      >
        <div className="theme-editor-swatch-list">
          {fills.map((fill, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fills have no id, position IS the identity
            <div key={index} className="theme-editor-swatch-row">
              <NumberField
                label={`Fill ${index + 1} azimuth`}
                value={fill.azimuthDeg}
                min={-180}
                max={180}
                step={5}
                suffix="az"
                onCommit={(next) => patchFill(index, { azimuthDeg: next ?? 0 })}
              />
              <NumberField
                label={`Fill ${index + 1} elevation`}
                value={fill.elevationDeg}
                min={-90}
                max={90}
                step={5}
                suffix="el"
                onCommit={(next) => patchFill(index, { elevationDeg: next ?? 0 })}
              />
              <NumberField
                label={`Fill ${index + 1} intensity`}
                value={fill.intensity}
                min={0}
                max={20}
                step={0.1}
                onCommit={(next) => patchFill(index, { intensity: next ?? 0 })}
              />
              <ColourPicker
                theme={theme}
                label={`Fill ${index + 1} colour`}
                value={fill.color}
                onCommit={(hex) => patchFill(index, { color: hex })}
              />
              <button
                type="button"
                className="theme-editor-icon-button danger"
                aria-label={`Remove fill ${index + 1}`}
                onClick={() =>
                  onPatch(
                    writeFills(
                      doc,
                      fills.filter((_, i) => i !== index),
                    ),
                  )
                }
              >
                <ThemeEditorIcon name="remove" size={14} />
              </button>
            </div>
          ))}
          <IconButton
            icon="add"
            label="Add fill"
            onClick={() => onPatch(writeFills(doc, [...fills, { ...DEFAULT_FILL }]))}
          />
        </div>
      </Field>

      <Field
        label="Free lights"
        icon="light"
        hint="The v9 list: each light picks its own type and the space its placement resolves in."
      >
        <div className="theme-editor-light-list">
          {lights.map((light, index) => (
            <article key={light.id} className="theme-editor-light">
              <header className="theme-editor-light-head">
                <span>{light.id}</span>
                <IconButton
                  icon="remove"
                  label="Delete"
                  danger
                  onClick={() =>
                    onPatch(
                      writeLights(
                        doc,
                        lights.filter((_, i) => i !== index),
                      ),
                    )
                  }
                />
              </header>

              <IconOptions
                label={`${light.id} type`}
                value={light.type}
                onChange={(type) => patchLight(index, { type })}
                options={LIGHT_TYPES.map((type) => ({
                  id: type,
                  label: type,
                  icon: TYPE_ICONS[type],
                }))}
              />

              <IconOptions
                label={`${light.id} space`}
                value={light.space}
                onChange={(space) => patchLight(index, { space })}
                options={LIGHT_SPACES.map((space) => ({
                  id: space,
                  label: space,
                  icon: space === "world" ? "cube" : space === "camera" ? "specimen" : "identity",
                }))}
              />

              <IconOptions
                label={`${light.id} placement`}
                value={light.placementMode}
                onChange={(placementMode) => patchLight(index, { placementMode })}
                options={[
                  { id: "orbit", label: "Orbit", icon: "angle" },
                  { id: "point", label: "Point", icon: "position" },
                ]}
              />

              {light.placementMode === "orbit" ? (
                <span className="theme-editor-inline">
                  <NumberField
                    label={`${light.id} azimuth`}
                    value={light.azimuthDeg}
                    min={-180}
                    max={180}
                    step={5}
                    suffix="az"
                    onCommit={(next) => patchLight(index, { azimuthDeg: next ?? 0 })}
                  />
                  <NumberField
                    label={`${light.id} elevation`}
                    value={light.elevationDeg}
                    min={-90}
                    max={90}
                    step={5}
                    suffix="el"
                    onCommit={(next) => patchLight(index, { elevationDeg: next ?? 0 })}
                  />
                  <NumberField
                    label={`${light.id} distance`}
                    value={light.distance}
                    min={0.1}
                    max={60}
                    step={0.5}
                    suffix="d"
                    onCommit={(next) => patchLight(index, { distance: next ?? 1 })}
                  />
                </span>
              ) : (
                <span className="theme-editor-inline">
                  {(["x", "y", "z"] as const).map((axis, axisIndex) => (
                    <NumberField
                      key={axis}
                      label={`${light.id} ${axis}`}
                      value={light.position[axisIndex]}
                      min={-60}
                      max={60}
                      step={0.1}
                      suffix={axis}
                      onCommit={(next) => {
                        const position: [number, number, number] = [...light.position];
                        position[axisIndex] = next ?? 0;
                        patchLight(index, { position });
                      }}
                    />
                  ))}
                </span>
              )}

              <span className="theme-editor-inline">
                <NumberField
                  label={`${light.id} intensity`}
                  value={light.intensity}
                  min={0}
                  max={100}
                  step={0.1}
                  onCommit={(next) => patchLight(index, { intensity: next ?? 0 })}
                />
                <ColourPicker
                  theme={theme}
                  label={`${light.id} colour`}
                  value={light.color}
                  onCommit={(hex) => patchLight(index, { color: hex })}
                />
                <IconToggle
                  icon="visible"
                  offIcon="hidden"
                  label={light.enabled ? "Enabled" : "Muted"}
                  checked={light.enabled}
                  onChange={(enabled) => patchLight(index, { enabled })}
                />
                {(light.type === "directional" || light.type === "spot") && (
                  <IconToggle
                    icon="shadow"
                    offIcon="hidden"
                    label={light.castShadow ? "Casts shadow" : "No shadow"}
                    checked={light.castShadow}
                    onChange={(castShadow) => patchLight(index, { castShadow })}
                  />
                )}
              </span>

              {light.type === "spot" && (
                <span className="theme-editor-inline">
                  <NumberField
                    label={`${light.id} cone`}
                    value={light.angleDeg}
                    min={1}
                    max={170}
                    step={1}
                    suffix="deg"
                    onCommit={(next) => patchLight(index, { angleDeg: next ?? 45 })}
                  />
                  <NumberField
                    label={`${light.id} penumbra`}
                    value={light.penumbra}
                    min={0}
                    max={1}
                    step={0.05}
                    onCommit={(next) => patchLight(index, { penumbra: next ?? 0 })}
                  />
                </span>
              )}

              {light.type === "area" && (
                <span className="theme-editor-inline">
                  <NumberField
                    label={`${light.id} width`}
                    value={light.width}
                    min={0.1}
                    max={40}
                    step={0.1}
                    suffix="w"
                    onCommit={(next) => patchLight(index, { width: next ?? 1 })}
                  />
                  <NumberField
                    label={`${light.id} height`}
                    value={light.height}
                    min={0.1}
                    max={40}
                    step={0.1}
                    suffix="h"
                    onCommit={(next) => patchLight(index, { height: next ?? 1 })}
                  />
                </span>
              )}
            </article>
          ))}
          <IconButton
            icon="add"
            label="Add light"
            onClick={() =>
              onPatch(writeLights(doc, [...lights, defaultLight(nextLightId(lights))]))
            }
          />
        </div>
      </Field>

      {fixtures.length > 0 && (
        <Field
          label="Fixtures"
          icon="panel"
          hint="Emissive fixtures have no form here yet; they save through untouched."
        >
          <ul className="theme-editor-block-list">
            {fixtures.map((fixture) => (
              <li key={fixture.id}>
                <ThemeEditorIcon name="panel" size={14} />
                <span>{fixture.id}</span>
                <code>{fixture.form}</code>
              </li>
            ))}
          </ul>
        </Field>
      )}

      <p className="theme-editor-empty">
        Tone mapping and exposure are not theme fields: the display transform lives on each project
        (project.json's <code>render</code> block), so it stays with the project rather than the
        look.
      </p>
    </Section>
  );
}
