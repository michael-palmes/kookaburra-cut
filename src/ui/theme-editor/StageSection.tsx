import { optionPreviewStill } from "../../engine/optionPreviews";
import type { Theme } from "../../theme/tokens";
import { BUNDLED_BACKDROP_NAMES } from "../../toolkit/stage/backdrops";
import {
  SCENE3D_BACKGROUND_IDS,
  SCENE3D_BACKGROUND_PRESETS,
  SCENE3D_BACKGROUNDS,
  type Scene3dBackgroundPreset,
  scene3dThemeAnchor,
} from "../../toolkit/stage/scene3d";
import {
  SHADER_BACKGROUND_IDS,
  SHADER_BACKGROUND_PRESETS,
  SHADER_BACKGROUNDS,
  type ShaderBackgroundPreset,
  themePresetAnchor,
} from "../../toolkit/stage/shaders";
import { ColourPicker } from "../colour/ColourPicker";
import { OptionCard } from "../OptionCard";
import { Field, IconOptions, IconSelect, NumberField, Section } from "./fields";
import {
  type BackdropKind,
  type BackgroundKind,
  firstGradientName,
  readBackdropKind,
  readBackgroundKind,
  readBlock,
  setIn,
  type ThemeDoc,
} from "./themeDraft";

/** Stage: the theme's default world-space staging (`backdrop`) and its camera-locked fill (`background`). Compact forms over the same document blocks the scene inspector writes per scene, reusing the shipped preset catalogues and option-preview stills; the inspector's own editors stay where they are (they write sidecars through an undo stack this window has no part in). */

const BACKDROP_OPTIONS = [
  { id: "off", label: "Off", icon: "hidden" },
  { id: "floor", label: "Floor", icon: "stage" },
  { id: "gradient", label: "Gradient", icon: "gradients" },
  { id: "image", label: "Image", icon: "image" },
] as const;

const BACKGROUND_OPTIONS = [
  { id: "off", label: "Off", icon: "hidden" },
  { id: "color", label: "Colour", icon: "colours" },
  { id: "gradient", label: "Gradient", icon: "gradients" },
  { id: "shader", label: "Shader", icon: "shader" },
  { id: "scene3d", label: "3D", icon: "cube" },
] as const;

const PARALLAX_RANGE = { min: 0, max: 0.5 } as const;

/** Flat stripes standing in for a preset's colour set: the Theme tile has no committed still (its colours resolve from the draft). */
function stripeSwatch(stripes: readonly string[]): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">${stripes
      .map(
        (colour, index) =>
          `<rect x="${((320 / stripes.length) * index).toFixed(2)}" y="0" width="${(
            320 / stripes.length + 1
          ).toFixed(2)}" height="180" fill="${colour}"/>`,
      )
      .join("")}</svg>`,
  )}`;
}

export function StageSection({
  doc,
  onPatch,
  theme,
}: {
  doc: ThemeDoc;
  onPatch: (next: ThemeDoc) => void;
  theme: Theme;
}) {
  const backdropKind = readBackdropKind(doc);
  const backgroundKind = readBackgroundKind(doc);
  const backdrop = readBlock(doc, "backdrop");
  const background = readBlock(doc, "background");
  const gradientNames = Object.keys(readBlock(doc, "gradients"));
  const gradientOptions = gradientNames.map((name) => ({ id: name, label: name }));

  const patchBackdrop = (field: string, value: unknown) =>
    onPatch(setIn(doc, ["backdrop", field], value));
  const patchBackground = (field: string, value: unknown) =>
    onPatch(setIn(doc, ["background", field], value));

  const setBackdropKind = (kind: BackdropKind) => {
    if (kind === backdropKind) return;
    if (kind === "off") return onPatch(setIn(doc, ["backdrop"], undefined));
    if (kind === "floor") {
      return onPatch(
        setIn(doc, ["backdrop"], {
          type: "floor",
          color: theme.colors.background,
          filletRadius: 2.5,
        }),
      );
    }
    if (kind === "gradient") {
      const name = firstGradientName(doc);
      return onPatch(
        setIn(
          doc,
          ["backdrop"],
          name
            ? { type: "gradient", gradient: name }
            : {
                type: "gradient",
                spec: {
                  type: "linear",
                  angleDeg: 180,
                  stops: [
                    [theme.colors.background, 0],
                    [theme.colors.muted, 1],
                  ],
                },
              },
        ),
      );
    }
    onPatch(
      setIn(doc, ["backdrop"], {
        type: "image",
        src: `kookaburra:${BUNDLED_BACKDROP_NAMES[0] ?? "loft-studio"}`,
        fit: "cover",
      }),
    );
  };

  const setBackgroundKind = (kind: BackgroundKind) => {
    if (kind === backgroundKind) return;
    if (kind === "off") return onPatch(setIn(doc, ["background"], undefined));
    if (kind === "color") {
      return onPatch(setIn(doc, ["background"], { type: "color", color: theme.colors.background }));
    }
    if (kind === "gradient") {
      const name = firstGradientName(doc);
      return onPatch(
        setIn(
          doc,
          ["background"],
          name
            ? { type: "gradient", gradient: name }
            : {
                type: "gradient",
                spec: {
                  type: "linear",
                  angleDeg: 135,
                  stops: [
                    [theme.colors.background, 0],
                    [theme.colors.accent, 1],
                  ],
                },
              },
        ),
      );
    }
    if (kind === "shader") return applyShader(SHADER_BACKGROUND_IDS[0]);
    applyScene3d(SCENE3D_BACKGROUND_IDS[0]);
  };

  // Picking a shader (or a look) stamps its Theme preset: the colours then follow the draft's tokens, which is what a THEME wants by default.
  function applyShader(shader: string) {
    const anchor = themePresetAnchor(shader, theme);
    onPatch(
      setIn(doc, ["background"], {
        type: "shader",
        shader,
        themeColors: true,
        speed: anchor?.speed ?? 1,
        ...(anchor?.scale === undefined ? {} : { scale: anchor.scale }),
        ...(anchor?.params ? { params: { ...anchor.params } } : {}),
      }),
    );
  }

  function applyScene3d(look: string) {
    const anchor = scene3dThemeAnchor(look, theme);
    onPatch(
      setIn(doc, ["background"], {
        type: "scene3d",
        look,
        themeColors: true,
        speed: anchor?.speed ?? 1,
        ...(anchor?.params ? { params: { ...anchor.params } } : {}),
      }),
    );
  }

  const shaderId = typeof background.shader === "string" ? background.shader : null;
  const lookId = typeof background.look === "string" ? background.look : null;
  const presetId = typeof background.preset === "string" ? background.preset : null;
  const themeColors = background.themeColors === true;
  const colours = Array.isArray(background.colors)
    ? background.colors.filter((c): c is string => typeof c === "string")
    : [];

  const applyShaderPreset = (shader: string, preset: ShaderBackgroundPreset) =>
    onPatch(
      setIn(doc, ["background"], {
        type: "shader",
        shader,
        colors: [...preset.colors],
        speed: preset.speed ?? 1,
        ...(preset.scale === undefined ? {} : { scale: preset.scale }),
        ...(preset.params ? { params: { ...preset.params } } : {}),
        preset: preset.id,
      }),
    );

  const applyScene3dPreset = (look: string, preset: Scene3dBackgroundPreset) =>
    onPatch(
      setIn(doc, ["background"], {
        type: "scene3d",
        look,
        colors: [...preset.colors],
        speed: preset.speed ?? 1,
        ...(preset.params ? { params: { ...preset.params } } : {}),
        backing: { type: "color", color: preset.backing },
        preset: preset.id,
      }),
    );

  const slots =
    shaderId && SHADER_BACKGROUNDS[shaderId]
      ? SHADER_BACKGROUNDS[shaderId].colorSlots
      : lookId && SCENE3D_BACKGROUNDS[lookId]
        ? SCENE3D_BACKGROUNDS[lookId].colorSlots
        : [];

  return (
    <Section
      title="Stage"
      hint="The theme's default staging: a world-space backdrop scenes cast onto, and a camera-locked fill behind everything."
    >
      <Field
        label="Backdrop"
        icon="stage"
        hint="World-space staging. Off leaves scenes on the flat background colour."
      >
        <IconOptions
          label="Backdrop type"
          value={backdropKind}
          onChange={setBackdropKind}
          options={BACKDROP_OPTIONS}
        />
      </Field>

      {backdropKind === "floor" && (
        <>
          <Field label="Floor colour" icon="colours">
            <span className="theme-editor-colour">
              <ColourPicker
                size="md"
                theme={theme}
                label="Floor colour"
                value={
                  typeof backdrop.color === "string" ? backdrop.color : theme.colors.background
                }
                onCommit={(hex) => patchBackdrop("color", hex)}
              />
              <code>{typeof backdrop.color === "string" ? backdrop.color : "—"}</code>
            </span>
          </Field>
          <Field
            label="Fillet"
            icon="radius"
            hint="Radius of the curve where the floor sweeps up into the wall, in world units."
          >
            <NumberField
              label="Fillet radius"
              value={typeof backdrop.filletRadius === "number" ? backdrop.filletRadius : null}
              min={0}
              max={12}
              step={0.5}
              allowEmpty
              onCommit={(next) => patchBackdrop("filletRadius", next ?? undefined)}
            />
          </Field>
        </>
      )}

      {backdropKind === "gradient" && (
        <Field
          label="Gradient"
          icon="gradients"
          hint="Names one of the theme's own gradients; add them in the Gradients section."
        >
          {gradientOptions.length > 0 ? (
            <IconSelect
              icon="gradients"
              label="Backdrop gradient"
              value={typeof backdrop.gradient === "string" ? backdrop.gradient : ""}
              onChange={(name) => patchBackdrop("gradient", name)}
              options={gradientOptions}
            />
          ) : (
            <p className="theme-editor-empty">
              This theme has no gradients yet, so the backdrop carries an inline one.
            </p>
          )}
        </Field>
      )}

      {backdropKind === "image" && (
        <>
          <Field
            label="Image"
            icon="image"
            hint="Bundled backdrops only: a theme is shared across projects, so it can never reference a project asset."
          >
            <IconSelect
              icon="image"
              label="Backdrop image"
              value={typeof backdrop.src === "string" ? backdrop.src : ""}
              onChange={(src) => patchBackdrop("src", src)}
              options={BUNDLED_BACKDROP_NAMES.map((name) => ({
                id: `kookaburra:${name}`,
                label: name,
              }))}
            />
          </Field>
          <Field label="Fit" icon="stage">
            <IconOptions
              label="Backdrop fit"
              value={backdrop.fit === "contain" ? "contain" : "cover"}
              onChange={(fit) => patchBackdrop("fit", fit)}
              options={[
                { id: "cover", label: "Cover", icon: "stage" },
                { id: "contain", label: "Contain", icon: "image" },
              ]}
            />
          </Field>
        </>
      )}

      <Field
        label="Background"
        icon="background"
        hint="Camera-locked fill drawn behind all world content."
      >
        <IconOptions
          label="Background type"
          value={backgroundKind}
          onChange={setBackgroundKind}
          options={BACKGROUND_OPTIONS}
        />
      </Field>

      {backgroundKind === "color" && (
        <Field label="Fill colour" icon="colours">
          <span className="theme-editor-colour">
            <ColourPicker
              size="md"
              theme={theme}
              label="Background colour"
              value={
                typeof background.color === "string" ? background.color : theme.colors.background
              }
              onCommit={(hex) => patchBackground("color", hex)}
            />
            <code>{typeof background.color === "string" ? background.color : "—"}</code>
          </span>
        </Field>
      )}

      {backgroundKind === "gradient" && (
        <Field
          label="Gradient"
          icon="gradients"
          hint="Names one of the theme's own gradients; add them in the Gradients section."
        >
          {gradientOptions.length > 0 ? (
            <IconSelect
              icon="gradients"
              label="Background gradient"
              value={typeof background.gradient === "string" ? background.gradient : ""}
              onChange={(name) => patchBackground("gradient", name)}
              options={gradientOptions}
            />
          ) : (
            <p className="theme-editor-empty">
              This theme has no gradients yet, so the background carries an inline one.
            </p>
          )}
        </Field>
      )}

      {backgroundKind === "shader" && (
        <>
          <Field label="Shader" icon="shader">
            <IconSelect
              icon="shader"
              label="Shader background"
              value={shaderId ?? ""}
              onChange={applyShader}
              options={SHADER_BACKGROUND_IDS.map((id) => ({
                id,
                label: SHADER_BACKGROUNDS[id].name,
              }))}
            />
          </Field>
          {shaderId && (
            <Field
              label="Preset"
              icon="colours"
              hint="Theme follows the draft's own tokens; the others stamp their colours in."
            >
              <div className="option-grid three-up">
                <OptionCard
                  label="Theme"
                  image={stripeSwatch([
                    theme.colors.background,
                    theme.colors.accent,
                    theme.colors.text,
                  ])}
                  selected={themeColors}
                  onSelect={() => applyShader(shaderId)}
                />
                {(SHADER_BACKGROUND_PRESETS[shaderId] ?? []).map((preset) => (
                  <OptionCard
                    key={preset.id}
                    label={preset.name}
                    image={optionPreviewStill(`bgp-${shaderId}-${preset.id}`)}
                    selected={!themeColors && presetId === preset.id}
                    onSelect={() => applyShaderPreset(shaderId, preset)}
                  />
                ))}
              </div>
            </Field>
          )}
        </>
      )}

      {backgroundKind === "scene3d" && (
        <>
          <Field label="Look" icon="cube">
            <IconSelect
              icon="cube"
              label="3D background look"
              value={lookId ?? ""}
              onChange={applyScene3d}
              options={SCENE3D_BACKGROUND_IDS.map((id) => ({
                id,
                label: SCENE3D_BACKGROUNDS[id].name,
              }))}
            />
          </Field>
          {lookId && (
            <Field
              label="Preset"
              icon="colours"
              hint="Theme follows the draft's own tokens; the others stamp their colours and backing in."
            >
              <div className="option-grid three-up">
                <OptionCard
                  label="Theme"
                  image={stripeSwatch([
                    theme.colors.background,
                    theme.colors.accent,
                    theme.colors.text,
                  ])}
                  selected={themeColors}
                  onSelect={() => applyScene3d(lookId)}
                />
                {(SCENE3D_BACKGROUND_PRESETS[lookId] ?? []).map((preset) => (
                  <OptionCard
                    key={preset.id}
                    label={preset.name}
                    image={optionPreviewStill(`bgp-${lookId}-${preset.id}`)}
                    selected={!themeColors && presetId === preset.id}
                    onSelect={() => applyScene3dPreset(lookId, preset)}
                  />
                ))}
              </div>
            </Field>
          )}
        </>
      )}

      {(backgroundKind === "shader" || backgroundKind === "scene3d") && (
        <>
          {!themeColors && slots.length > 0 && (
            <Field label="Colours" icon="colours">
              <div className="theme-editor-swatch-list">
                {slots.map((slot, index) => (
                  <div key={slot.label} className="theme-editor-swatch-row">
                    <ColourPicker
                      theme={theme}
                      label={slot.label}
                      value={colours[index] ?? slot.fallback}
                      onCommit={(hex) => {
                        const next = slots.map((s, i) => colours[i] ?? s.fallback);
                        next[index] = hex;
                        onPatch(
                          setIn(
                            setIn(doc, ["background", "colors"], next),
                            ["background", "preset"],
                            undefined,
                          ),
                        );
                      }}
                    />
                    <span className="theme-editor-swatch-label">{slot.label}</span>
                  </div>
                ))}
              </div>
            </Field>
          )}
          <Field
            label="Speed"
            icon="duration"
            hint="Multiplies the absolute project clock, so motion stays continuous across scene cuts."
          >
            <NumberField
              label="Background speed"
              value={typeof background.speed === "number" ? background.speed : 1}
              min={0}
              max={4}
              step={0.05}
              onCommit={(next) => patchBackground("speed", next ?? 1)}
            />
          </Field>
        </>
      )}

      {(backgroundKind === "color" ||
        backgroundKind === "gradient" ||
        backgroundKind === "shader") && (
        <Field
          label="Parallax"
          icon="motion"
          hint="Fraction of the content's screen motion the fill drifts by; 0 is hard-locked."
        >
          <NumberField
            label="Background parallax"
            value={typeof background.parallax === "number" ? background.parallax : null}
            min={PARALLAX_RANGE.min}
            max={PARALLAX_RANGE.max}
            step={0.05}
            allowEmpty
            onCommit={(next) => patchBackground("parallax", next ?? undefined)}
          />
        </Field>
      )}
    </Section>
  );
}
