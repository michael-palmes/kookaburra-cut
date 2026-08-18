import type { ReactNode } from "react";
import { placementToOrbit, placementToPoint } from "../../engine/orbit";
import { resolveLightingColour } from "../../engine/sceneLighting";
import type { FixtureSpec, LightSpace, LightSpec, Theme } from "../../theme/tokens";
import { ColourPicker } from "../colour/ColourPicker";
import { namedInspectorTitle } from "../inspectorTitles";
import { LightingIcon } from "./LightingIcon";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  InspectorSliderRow,
  NumberField,
  ToggleRow,
} from "./rows";

/** Baked picker thumbnails (UI-only JPEGs; scripts/hdri-thumb.py). */
const HDRI_THUMBS = import.meta.glob<string>("../../assets/hdri-thumbs/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
});

export const thumbFor = (id: string): string | null =>
  HDRI_THUMBS[`../../assets/hdri-thumbs/${id.replace(/^kookaburra:/, "")}.jpg`] ?? null;

/** One-off app-screenshot bakes (scripts/lighting-thumb-bake.sh): the lighting presets plus the procedural softbox. Missing files degrade to the text swatch. */
const LIGHTING_THUMBS = import.meta.glob<string>("../../assets/lighting-thumbs/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
});

export const lightingThumbFor = (id: string): string | null =>
  LIGHTING_THUMBS[`../../assets/lighting-thumbs/${id}.jpg`] ?? null;

export const TYPE_LABEL: Record<LightSpec["type"], string> = {
  directional: "Directional",
  point: "Point",
  spot: "Spot",
  area: "Area",
};

/** Per-type intensity slider ceilings (three's units differ wildly between types). */
export const INTENSITY_MAX: Record<LightSpec["type"], number> = {
  directional: 6,
  point: 40,
  spot: 200,
  area: 30,
};

const SPACES: { id: LightSpace; label: string }[] = [
  { id: "world", label: "World" },
  { id: "camera", label: "Camera" },
  { id: "subject", label: "Subject" },
];

const SPACE_HINT: Record<LightSpace, string | undefined> = {
  world: undefined,
  camera: "Rides the camera: stays in the same part of frame through any move.",
  subject: "Orbits the camera's target: holds its angle off the subject as the camera flies.",
};

/** Defaults on add, tuned so a new light is immediately visible (never origin at intensity 0). */
export const LIGHT_DEFAULTS: Record<LightSpec["type"], (id: string) => LightSpec> = {
  directional: (id) => ({
    id,
    type: "directional",
    intensity: 1.5,
    kelvin: 5500,
    placement: { mode: "orbit", azimuthDeg: 45, elevationDeg: 30, distance: 8 },
  }),
  point: (id) => ({
    id,
    type: "point",
    intensity: 8,
    kelvin: 3200,
    distance: 10,
    decay: 2,
    placement: { mode: "point", position: [2, 2, 2] },
  }),
  spot: (id) => ({
    id,
    type: "spot",
    intensity: 40,
    kelvin: 5000,
    angleDeg: 30,
    penumbra: 0.4,
    placement: { mode: "orbit", azimuthDeg: -40, elevationDeg: 45, distance: 6 },
  }),
  area: (id) => ({
    id,
    type: "area",
    intensity: 6,
    kelvin: 6000,
    width: 2,
    height: 2,
    placement: { mode: "point", position: [0, 2, 3] },
  }),
};

export function nextLightId(lights: readonly LightSpec[]): string {
  let n = 1;
  while (lights.some((l) => l.id === `light-${n}`)) n += 1;
  return `light-${n}`;
}

export const FORM_LABEL: Record<FixtureSpec["form"], string> = {
  tube: "Tube",
  panel: "Panel",
  ring: "Ring",
  strip: "Strip",
  bulb: "Bulb",
  "neon-sign": "Neon sign",
  "tube-stand": "Tube stand",
  "ring-light": "Ring light",
  "led-strip": "LED strip",
};

/** Per-form size field labels ([a, b] of `size`). */
const SIZE_LABELS: Record<FixtureSpec["form"], [string, string]> = {
  tube: ["length", "diameter"],
  panel: ["width", "height"],
  ring: ["outer", "thickness"],
  strip: ["length", "width"],
  bulb: ["diameter", "-"],
  "neon-sign": ["length", "diameter"],
  "tube-stand": ["length", "diameter"],
  "ring-light": ["outer", "thickness"],
  "led-strip": ["length", "width"],
};

/** Per-type glyphs for the light chips and rows (the RowIcon convention: 20-viewBox stroke SVGs). */
export function LightTypeIcon({ type, size = 13 }: { type: LightSpec["type"]; size?: number }) {
  const paths: Record<LightSpec["type"], ReactNode> = {
    directional: (
      <>
        <circle cx="7" cy="7" r="2.6" />
        <path d="M11.5 11.5L16 16M16 16v-3.2M16 16h-3.2" />
      </>
    ),
    point: (
      <>
        <circle cx="10" cy="10" r="1.7" />
        <path d="M10 4v2.4M10 13.6V16M4 10h2.4M13.6 10H16M5.8 5.8l1.7 1.7M12.5 12.5l1.7 1.7M14.2 5.8l-1.7 1.7M7.5 12.5l-1.7 1.7" />
      </>
    ),
    spot: (
      <>
        <path d="M10 3.5L5.5 14M10 3.5L14.5 14" />
        <ellipse cx="10" cy="14.5" rx="4.5" ry="2" />
      </>
    ),
    area: (
      <>
        <rect x="3.5" y="4.5" width="6.5" height="11" rx="1" />
        <path d="M13 7h3.5M13 10h3.5M13 13h3.5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {paths[type]}
    </svg>
  );
}

/** Per-form glyphs for the fixture chips and rows. */
export function FixtureFormIcon({ form, size = 13 }: { form: FixtureSpec["form"]; size?: number }) {
  const paths: Record<FixtureSpec["form"], ReactNode> = {
    tube: <rect x="3" y="8.2" width="14" height="3.6" rx="1.8" />,
    panel: <rect x="4" y="5" width="12" height="10" rx="1.2" />,
    ring: <circle cx="10" cy="10" r="5.5" />,
    strip: <rect x="3" y="9" width="14" height="2" rx="1" />,
    bulb: (
      <>
        <circle cx="10" cy="8.5" r="4" />
        <path d="M8.6 12.4h2.8M9 14.6h2" />
      </>
    ),
    "neon-sign": <path d="M4 12c2-5 4-5 6 0s4 5 6 0" />,
    "tube-stand": (
      <>
        <rect x="8.4" y="3" width="3.2" height="9.5" rx="1.6" />
        <path d="M10 12.5v2.7M10 15.2l-2.8 2.3M10 15.2l2.8 2.3" />
      </>
    ),
    "ring-light": (
      <>
        <circle cx="10" cy="7.5" r="4.5" />
        <path d="M10 12v3M10 15l-2.5 2.5M10 15l2.5 2.5" />
      </>
    ),
    "led-strip": (
      <>
        <rect x="3" y="8.8" width="14" height="2.4" rx="1.2" />
        <path d="M5.5 14.2h.01M10 14.2h.01M14.5 14.2h.01" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {paths[form]}
    </svg>
  );
}

/** The None environment card's glyph: a highlight-free ball, struck through. */
export function NoReflectionsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M6.3 17.7L17.7 6.3" />
    </svg>
  );
}

/** Defaults on add, tuned so a new fixture looks right immediately. */
export const FIXTURE_DEFAULTS: Record<FixtureSpec["form"], (id: string) => FixtureSpec> = {
  tube: (id) => ({
    id,
    form: "tube",
    size: [3.2, 0.06],
    kelvin: 4200,
    emissive: 3.5,
    lightIntensity: 14,
    placement: { mode: "point", position: [0, 2.4, 0] },
  }),
  panel: (id) => ({
    id,
    form: "panel",
    size: [2, 1],
    kelvin: 5600,
    emissive: 2.5,
    lightIntensity: 10,
    placement: { mode: "point", position: [0, 2, 2] },
  }),
  ring: (id) => ({
    id,
    form: "ring",
    size: [1.2, 0.05],
    kelvin: 3000,
    emissive: 4,
    lightIntensity: 6,
    placement: { mode: "point", position: [0, 1.2, 2] },
  }),
  strip: (id) => ({
    id,
    form: "strip",
    size: [4, 0.04],
    kelvin: 6500,
    emissive: 4,
    lightIntensity: 8,
    placement: { mode: "point", position: [0, 2.2, 0] },
  }),
  bulb: (id) => ({
    id,
    form: "bulb",
    size: [0.12, 0.12],
    kelvin: 2700,
    emissive: 6,
    lightIntensity: 5,
    placement: { mode: "point", position: [0, 1.6, 1] },
  }),
  "neon-sign": (id) => ({
    id,
    form: "neon-sign",
    size: [2.4, 0.05],
    kelvin: 3000,
    emissive: 4.5,
    lightIntensity: 6,
    shape: "rect",
    placement: { mode: "point", position: [0, 1.4, -1.5] },
  }),
  "tube-stand": (id) => ({
    id,
    form: "tube-stand",
    size: [2.6, 0.06],
    kelvin: 4200,
    emissive: 3.5,
    lightIntensity: 12,
    placement: { mode: "point", position: [1.8, 0.6, 1] },
    rotationDeg: [-70, 0, 0],
  }),
  "ring-light": (id) => ({
    id,
    form: "ring-light",
    size: [1.3, 0.05],
    kelvin: 5600,
    emissive: 3,
    lightIntensity: 8,
    placement: { mode: "point", position: [-1.6, 0.4, 2] },
  }),
  "led-strip": (id) => ({
    id,
    form: "led-strip",
    size: [3.6, 0.04],
    kelvin: 6500,
    emissive: 4,
    lightIntensity: 8,
    placement: { mode: "point", position: [0, -1.2, -1] },
  }),
};

export function nextFixtureId(fixtures: readonly FixtureSpec[]): string {
  let n = 1;
  while (fixtures.some((f) => f.id === `fixture-${n}`)) n += 1;
  return `fixture-${n}`;
}

/** One free light's editor: type-specific fields, the World/Camera/Subject space row, the lossless Orbit/Position placement pair, the colour union (kelvin first, token swatches, custom hex) and the per-type shadow policy. */
export function LightEditor({
  light,
  colors,
  onBack,
  onLive,
  onCommit,
  onDuplicate,
  onDelete,
  onAnimate,
  embedded = false,
}: {
  light: LightSpec;
  colors: Theme["colors"];
  onBack: () => void;
  onLive: (mutate: (l: LightSpec) => void) => void;
  onCommit: (mutate: (l: LightSpec) => void) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAnimate?: () => void;
  embedded?: boolean;
}) {
  const aim = light.target ?? ([0, 0, 0] as [number, number, number]);
  const space = light.space ?? "world";
  const swatch = resolveLightingColour(light, colors);
  const canShadow = light.type === "directional" || light.type === "spot";
  const aimed = light.type !== "point";
  const placement = light.placement;
  const spaceHint = SPACE_HINT[space];

  return (
    <div className={embedded ? "lighting-inline-editor" : "inspector-drill"}>
      {!embedded && (
        <DrillBack
          label="Lighting"
          title={namedInspectorTitle(light.name, TYPE_LABEL[light.type])}
          onClick={onBack}
        />
      )}
      <div className="inspector-drill-body inspector-section-body">
        <input
          key={light.id}
          className="modal-input"
          defaultValue={light.name ?? ""}
          placeholder={TYPE_LABEL[light.type]}
          aria-label="Light name"
          onBlur={(e) => {
            const value = e.target.value.trim();
            if ((light.name ?? "") === value) return;
            onCommit((l) => {
              if (value) l.name = value;
              else delete l.name;
            });
          }}
        />

        <DrillGroup label="Space" hint={spaceHint}>
          <div className="camera-loop-modes">
            {SPACES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`chip${space === id ? " selected" : ""}`}
                title={SPACE_HINT[id] ?? "Fixed in the scene."}
                onClick={() =>
                  onCommit((l) => {
                    if (id === "world") delete l.space;
                    else l.space = id;
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </DrillGroup>

        <DrillGroup label="Placement">
          <div className="camera-loop-modes">
            <button
              type="button"
              className={`chip${placement.mode === "orbit" ? " selected" : ""}`}
              title="Azimuth, elevation and distance around the aim point"
              onClick={() => {
                if (placement.mode === "orbit") return;
                onCommit((l) => (l.placement = placementToOrbit(l.placement, aim)));
              }}
            >
              Orbit
            </button>
            <button
              type="button"
              className={`chip${placement.mode === "point" ? " selected" : ""}`}
              title="Numeric XYZ position"
              onClick={() => {
                if (placement.mode === "point") return;
                onCommit((l) => (l.placement = placementToPoint(l.placement, aim)));
              }}
            >
              Position
            </button>
          </div>
          {placement.mode === "orbit" ? (
            <>
              <InspectorSliderRow
                icon={<LightingIcon name="direction" />}
                label="Azimuth"
                value={placement.azimuthDeg}
                min={-180}
                max={180}
                step={1}
                onInput={(n) =>
                  onLive((l) => {
                    if (l.placement.mode === "orbit") l.placement.azimuthDeg = n;
                  })
                }
                onCommit={(n) =>
                  onCommit((l) => {
                    if (l.placement.mode === "orbit") l.placement.azimuthDeg = n;
                  })
                }
              />
              <InspectorSliderRow
                icon={<LightingIcon name="direction" />}
                label="Elevation"
                value={placement.elevationDeg}
                min={-90}
                max={90}
                step={1}
                onInput={(n) =>
                  onLive((l) => {
                    if (l.placement.mode === "orbit") l.placement.elevationDeg = n;
                  })
                }
                onCommit={(n) =>
                  onCommit((l) => {
                    if (l.placement.mode === "orbit") l.placement.elevationDeg = n;
                  })
                }
              />
              <div className="inspector-pose-grid">
                <NumberField
                  label="distance"
                  value={placement.distance}
                  decimals={2}
                  dragScale={0.02}
                  min={0}
                  onCommit={(n) =>
                    onCommit((l) => {
                      if (l.placement.mode === "orbit") l.placement.distance = n;
                    })
                  }
                />
              </div>
            </>
          ) : (
            <div className="inspector-pose-grid">
              {(["x", "y", "z"] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  label={axis}
                  value={placement.position[i]}
                  decimals={2}
                  dragScale={0.02}
                  onCommit={(n) =>
                    onCommit((l) => {
                      if (l.placement.mode === "point") l.placement.position[i] = n;
                    })
                  }
                />
              ))}
            </div>
          )}
          {aimed && (
            <>
              <div className="inspector-pose-grid">
                {(["x", "y", "z"] as const).map((axis, i) => (
                  <NumberField
                    key={axis}
                    label={`aim ${axis}`}
                    value={aim[i]}
                    decimals={2}
                    dragScale={0.02}
                    onCommit={(n) =>
                      onCommit((l) => {
                        const target: [number, number, number] = [...(l.target ?? [0, 0, 0])];
                        target[i] = n;
                        l.target = target;
                      })
                    }
                  />
                ))}
              </div>
              {(aim[0] !== 0 || aim[1] !== 0 || aim[2] !== 0) && (
                <ActionRow
                  label="Aim at the subject"
                  chevron={false}
                  onClick={() =>
                    onCommit((l) => {
                      delete l.target;
                    })
                  }
                />
              )}
            </>
          )}
        </DrillGroup>

        <DrillGroup label="Light">
          <InspectorSliderRow
            icon={<LightingIcon name="brightness" />}
            label="Intensity"
            value={light.intensity}
            min={0}
            max={INTENSITY_MAX[light.type]}
            step={0.05}
            onInput={(n) => onLive((l) => (l.intensity = n))}
            onCommit={(n) => onCommit((l) => (l.intensity = n))}
          />
          {light.type === "spot" && (
            <>
              <InspectorSliderRow
                icon={<LightingIcon name="direction" />}
                label="Cone °"
                value={light.angleDeg}
                min={1}
                max={179}
                step={1}
                onInput={(n) =>
                  onLive((l) => {
                    if (l.type === "spot") l.angleDeg = n;
                  })
                }
                onCommit={(n) =>
                  onCommit((l) => {
                    if (l.type === "spot") l.angleDeg = n;
                  })
                }
              />
              <InspectorSliderRow
                icon={<LightingIcon name="softness" />}
                label="Penumbra"
                value={light.penumbra}
                min={0}
                max={1}
                step={0.01}
                onInput={(n) =>
                  onLive((l) => {
                    if (l.type === "spot") l.penumbra = n;
                  })
                }
                onCommit={(n) =>
                  onCommit((l) => {
                    if (l.type === "spot") l.penumbra = n;
                  })
                }
              />
            </>
          )}
          {(light.type === "point" || light.type === "spot") && (
            <div className="inspector-pose-grid">
              <NumberField
                label="falloff"
                value={light.distance ?? 0}
                decimals={1}
                dragScale={0.1}
                min={0}
                onCommit={(n) =>
                  onCommit((l) => {
                    if (l.type === "point" || l.type === "spot") l.distance = n;
                  })
                }
              />
              <NumberField
                label="decay"
                value={light.decay ?? 2}
                decimals={1}
                dragScale={0.05}
                min={0}
                onCommit={(n) =>
                  onCommit((l) => {
                    if (l.type === "point" || l.type === "spot") l.decay = n;
                  })
                }
              />
            </div>
          )}
          {light.type === "area" && (
            <>
              <div className="inspector-pose-grid">
                <NumberField
                  label="width"
                  value={light.width}
                  decimals={2}
                  dragScale={0.02}
                  min={0.05}
                  onCommit={(n) =>
                    onCommit((l) => {
                      if (l.type === "area") l.width = n;
                    })
                  }
                />
                <NumberField
                  label="height"
                  value={light.height}
                  decimals={2}
                  dragScale={0.02}
                  min={0.05}
                  onCommit={(n) =>
                    onCommit((l) => {
                      if (l.type === "area") l.height = n;
                    })
                  }
                />
              </div>
              <p className="modal-hint">
                Area lights reach devices and other standard materials only: text and animated
                backgrounds ignore them, and they can't cast shadows.
              </p>
            </>
          )}
        </DrillGroup>

        <DrillGroup label="Colour">
          <InspectorSliderRow
            icon={<LightingIcon name="warmth" />}
            label="Temperature K"
            value={light.kelvin ?? 6500}
            min={1000}
            max={20000}
            step={100}
            onInput={(n) => onLive((l) => (l.kelvin = n))}
            onCommit={(n) => onCommit((l) => (l.kelvin = n))}
          />
          <span
            className="lighting-kelvin-swatch"
            style={{ background: swatch }}
            title={light.kelvin !== undefined ? `${light.kelvin} K` : "Colour"}
          />
          {light.kelvin !== undefined ? (
            <ActionRow
              label="Use a theme or custom colour instead"
              chevron={false}
              onClick={() =>
                onCommit((l) => {
                  delete l.kelvin;
                })
              }
            />
          ) : (
            <div className="camera-loop-modes">
              {(["accent", "text", "muted", "background"] as const).map((token) => (
                <button
                  key={token}
                  type="button"
                  className={`chip${light.colorToken === token ? " selected" : ""}`}
                  title={`Theme ${token} colour (a theme swap restyles this light)`}
                  onClick={() =>
                    onCommit((l) => {
                      l.colorToken = token;
                      delete l.kelvin;
                    })
                  }
                >
                  <span className="lighting-kelvin-swatch" style={{ background: colors[token] }} />
                  {token}
                </button>
              ))}
              <ColourPicker
                value={light.color ?? "#ffffff"}
                label="Custom light colour"
                onCommit={(hex) =>
                  onCommit((l) => {
                    l.color = hex;
                    delete l.kelvin;
                    delete l.colorToken;
                  })
                }
              />
            </div>
          )}
        </DrillGroup>

        <ToggleRow
          label="Cast shadows"
          description={
            light.type === "point"
              ? "Point lights can't cast shadows (a cube map costs six renders per light)."
              : light.type === "area"
                ? "Area lights can't cast shadows (a three.js limitation)."
                : "Capped at four casters per scene, sun included; over-cap lights render unshadowed."
          }
          checked={canShadow && light.castShadow === true}
          disabled={!canShadow}
          onChange={(on) =>
            onCommit((l) => {
              if (on) l.castShadow = true;
              else delete l.castShadow;
            })
          }
        />
        <ToggleRow
          label="Enabled"
          description="Off keeps the light's settings without lighting anything."
          checked={light.enabled !== false}
          onChange={(on) =>
            onCommit((l) => {
              if (on) delete l.enabled;
              else l.enabled = false;
            })
          }
        />

        <div className="inspector-section-divider" />
        {onAnimate && (
          <ActionRow
            icon={<LightingIcon name="animation" />}
            label="Animate this light"
            onClick={onAnimate}
          />
        )}
        <ActionRow label="Duplicate light" chevron={false} onClick={onDuplicate} />
        <ActionRow label="Delete light" chevron={false} danger onClick={onDelete} />
      </div>
    </div>
  );
}

/** One fixture's editor: form, per-form sized geometry, the colour union, emissive + paired light intensity, placement + rotation, the World/Camera/Subject space row, the repeat block and the env-mirror toggle. */
export function FixtureEditor({
  fixture,
  colors,
  onBack,
  onLive,
  onCommit,
  onDuplicate,
  onDelete,
  onAnimate,
  embedded = false,
}: {
  fixture: FixtureSpec;
  colors: Theme["colors"];
  onBack: () => void;
  onLive: (mutate: (f: FixtureSpec) => void) => void;
  onCommit: (mutate: (f: FixtureSpec) => void) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAnimate?: () => void;
  embedded?: boolean;
}) {
  const space = fixture.space ?? "world";
  const swatch = resolveLightingColour(fixture, colors);
  const [sizeA, sizeB] = SIZE_LABELS[fixture.form];
  const position =
    fixture.placement.mode === "point" ? fixture.placement.position : ([0, 0, 0] as const);
  const rotation = fixture.rotationDeg ?? ([0, 0, 0] as const);
  const repeat = fixture.repeat;

  return (
    <div className={embedded ? "lighting-inline-editor" : "inspector-drill"}>
      {!embedded && (
        <DrillBack
          label="Lighting"
          title={namedInspectorTitle(fixture.name, FORM_LABEL[fixture.form])}
          onClick={onBack}
        />
      )}
      <div className="inspector-drill-body inspector-section-body">
        <div className="camera-loop-modes">
          {(Object.keys(FORM_LABEL) as FixtureSpec["form"][]).map((form) => (
            <button
              key={form}
              type="button"
              className={`chip${fixture.form === form ? " selected" : ""}`}
              title={`${FORM_LABEL[form]} geometry`}
              onClick={() => onCommit((f) => (f.form = form))}
            >
              <FixtureFormIcon form={form} />
              {FORM_LABEL[form]}
            </button>
          ))}
        </div>

        {fixture.form === "neon-sign" && (
          <div className="camera-loop-modes">
            <span className="drill-group-hint">Shape</span>
            {(["line", "circle", "rect"] as const).map((shape) => (
              <button
                key={shape}
                type="button"
                className={`chip${(fixture.shape ?? "line") === shape ? " selected" : ""}`}
                onClick={() =>
                  onCommit((f) => {
                    if (shape === "line") delete f.shape;
                    else f.shape = shape;
                  })
                }
              >
                {shape}
              </button>
            ))}
          </div>
        )}

        <DrillGroup label="Geometry">
          <div className="inspector-pose-grid">
            <NumberField
              label={sizeA}
              value={fixture.size[0]}
              decimals={2}
              dragScale={0.02}
              min={0.02}
              onCommit={(n) => onCommit((f) => (f.size = [n, f.size[1]]))}
            />
            {sizeB !== "-" && (
              <NumberField
                label={sizeB}
                value={fixture.size[1]}
                decimals={3}
                dragScale={0.005}
                min={0}
                onCommit={(n) => onCommit((f) => (f.size = [f.size[0], n]))}
              />
            )}
          </div>
          <div className="inspector-pose-grid">
            {(["x", "y", "z"] as const).map((axis, i) => (
              <NumberField
                key={axis}
                label={`rot ${axis} °`}
                value={rotation[i]}
                decimals={1}
                dragScale={0.5}
                onCommit={(n) =>
                  onCommit((f) => {
                    const next: [number, number, number] = [...(f.rotationDeg ?? [0, 0, 0])];
                    next[i] = n;
                    f.rotationDeg = next;
                  })
                }
              />
            ))}
          </div>
        </DrillGroup>

        <DrillGroup label="Glow">
          <InspectorSliderRow
            icon={<LightingIcon name="warmth" />}
            label="Temperature K"
            value={fixture.kelvin ?? 4200}
            min={1000}
            max={20000}
            step={100}
            onInput={(n) => onLive((f) => (f.kelvin = n))}
            onCommit={(n) => onCommit((f) => (f.kelvin = n))}
          />
          <span
            className="lighting-kelvin-swatch"
            style={{ background: swatch }}
            title={fixture.kelvin !== undefined ? `${fixture.kelvin} K` : "Colour"}
          />
          <InspectorSliderRow
            icon={<LightingIcon name="brightness" />}
            label="Emissive"
            value={fixture.emissive}
            min={0}
            max={8}
            step={0.1}
            onInput={(n) => onLive((f) => (f.emissive = n))}
            onCommit={(n) => onCommit((f) => (f.emissive = n))}
          />
          <InspectorSliderRow
            icon={<LightingIcon name="lights" />}
            label="Light intensity"
            value={fixture.lightIntensity}
            min={0}
            max={40}
            step={0.5}
            onInput={(n) => onLive((f) => (f.lightIntensity = n))}
            onCommit={(n) => onCommit((f) => (f.lightIntensity = n))}
          />
          <p className="modal-hint">
            Emissive is the visible glow (above 1 it blooms); light intensity is the paired real
            light. Zero light intensity keeps a purely decorative fixture. Paired lights reach
            devices and other standard materials only.
          </p>
        </DrillGroup>

        <DrillGroup label="Placement" hint={SPACE_HINT[space]}>
          <div className="camera-loop-modes">
            {SPACES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`chip${space === id ? " selected" : ""}`}
                title={SPACE_HINT[id] ?? "Fixed in the scene."}
                onClick={() =>
                  onCommit((f) => {
                    if (id === "world") delete f.space;
                    else f.space = id;
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="inspector-pose-grid">
            {(["x", "y", "z"] as const).map((axis, i) => (
              <NumberField
                key={axis}
                label={axis}
                value={position[i]}
                decimals={2}
                dragScale={0.02}
                onCommit={(n) =>
                  onCommit((f) => {
                    const base =
                      f.placement.mode === "point"
                        ? ([...f.placement.position] as [number, number, number])
                        : ([0, 0, 0] as [number, number, number]);
                    base[i] = n;
                    f.placement = { mode: "point", position: base };
                  })
                }
              />
            ))}
          </div>
        </DrillGroup>

        <DrillGroup label="Repeat">
          <div className="inspector-pose-grid">
            <NumberField
              label="count"
              value={repeat?.count ?? 1}
              decimals={0}
              dragScale={0.05}
              min={1}
              max={64}
              onCommit={(n) =>
                onCommit((f) => {
                  if (n <= 1 && !f.repeat?.mirrorAxis) delete f.repeat;
                  else
                    f.repeat = {
                      count: Math.round(n),
                      spacing: f.repeat?.spacing ?? 2.4,
                      axis: f.repeat?.axis ?? "z",
                      ...(f.repeat?.mirrorAxis ? { mirrorAxis: f.repeat.mirrorAxis } : {}),
                      ...(f.repeat?.jitter ? { jitter: f.repeat.jitter } : {}),
                    };
                })
              }
            />
            <NumberField
              label="spacing"
              value={repeat?.spacing ?? 2.4}
              decimals={2}
              dragScale={0.02}
              onCommit={(n) =>
                onCommit((f) => {
                  if (f.repeat) f.repeat.spacing = n;
                })
              }
            />
            <NumberField
              label="jitter"
              value={repeat?.jitter ?? 0}
              decimals={2}
              dragScale={0.01}
              min={0}
              max={1}
              onCommit={(n) =>
                onCommit((f) => {
                  if (!f.repeat) return;
                  if (n <= 0) delete f.repeat.jitter;
                  else f.repeat.jitter = n;
                })
              }
            />
          </div>
          {repeat && (
            <div className="camera-loop-modes">
              <span className="drill-group-hint">Axis</span>
              {(["x", "y", "z"] as const).map((axis) => (
                <button
                  key={axis}
                  type="button"
                  className={`chip${repeat.axis === axis ? " selected" : ""}`}
                  onClick={() =>
                    onCommit((f) => {
                      if (f.repeat) f.repeat.axis = axis;
                    })
                  }
                >
                  {axis}
                </button>
              ))}
              <span className="drill-group-hint">Mirror</span>
              {(["x", "y", "z"] as const).map((axis) => (
                <button
                  key={`m${axis}`}
                  type="button"
                  className={`chip${repeat.mirrorAxis === axis ? " selected" : ""}`}
                  title={`Duplicate the run mirrored across ${axis}`}
                  onClick={() =>
                    onCommit((f) => {
                      if (!f.repeat) return;
                      if (f.repeat.mirrorAxis === axis) delete f.repeat.mirrorAxis;
                      else f.repeat.mirrorAxis = axis;
                    })
                  }
                >
                  {axis}
                </button>
              ))}
            </div>
          )}
        </DrillGroup>

        <ToggleRow
          label="Mirror into reflections"
          description="Bakes this fixture into the scene environment for crisp reflections on glass. The reflection is static: keyframed fixtures bake at their base pose, and world space only."
          checked={fixture.envMirror === true}
          onChange={(on) =>
            onCommit((f) => {
              if (on) f.envMirror = true;
              else delete f.envMirror;
            })
          }
        />
        <ToggleRow
          label="Enabled"
          description="Off keeps the fixture's settings without rendering anything."
          checked={fixture.enabled !== false}
          onChange={(on) =>
            onCommit((f) => {
              if (on) delete f.enabled;
              else f.enabled = false;
            })
          }
        />

        <div className="inspector-section-divider" />
        {onAnimate && (
          <ActionRow
            icon={<LightingIcon name="animation" />}
            label="Animate this fixture"
            onClick={onAnimate}
          />
        )}
        <ActionRow label="Duplicate fixture" chevron={false} onClick={onDuplicate} />
        <ActionRow label="Delete fixture" chevron={false} danger onClick={onDelete} />
      </div>
    </div>
  );
}
