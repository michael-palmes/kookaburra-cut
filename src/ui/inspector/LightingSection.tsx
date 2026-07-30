import { type ReactNode, useEffect, useRef, useState } from "react";
import { useClockStore } from "../../engine/clock";
import {
  BUNDLED_ENVIRONMENT_IDS,
  NONE_SOURCE,
  resolveSceneEnvironment,
  SOFTBOX_SOURCE,
} from "../../engine/environments";
import { nextKeyId } from "../../engine/keyedTrack";
import { useLightEditStore } from "../../engine/lightEditStore";
import { placementToOrbit, placementToPoint } from "../../engine/orbit";
import { listProjectEnvironmentAssets } from "../../engine/project";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  captureLightingPose,
  chainLightingSegments,
  resolveLighting,
  resolveLightingColour,
  SUN_ANGULAR_REFERENCE,
  sunShadowSoftness,
} from "../../engine/sceneLighting";
import type {
  EnvironmentSpec,
  FixtureSpec,
  LightingSpec,
  LightSpace,
  LightSpec,
  SunSpec,
  Theme,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "../../theme/tokens";
import { LIGHTING_PRESETS } from "../../toolkit/lighting/presets";
import { ColourPicker } from "../colour/ColourPicker";
import { OptionCard } from "../OptionCard";
import { DebouncedRange } from "../TextAnimationPicker";
import { ActionRow, DrillBack, DrillGroup, NumberField, ToggleRow } from "./rows";

/** Baked picker thumbnails (UI-only JPEGs; scripts/hdri-thumb.py). */
const HDRI_THUMBS = import.meta.glob<string>("../../assets/hdri-thumbs/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
});

const thumbFor = (id: string): string | null =>
  HDRI_THUMBS[`../../assets/hdri-thumbs/${id.replace(/^kookaburra:/, "")}.jpg`] ?? null;

/** One-off app-screenshot bakes (scripts/lighting-thumb-bake.sh): the lighting presets plus the procedural softbox. Missing files degrade to the text swatch. */
const LIGHTING_THUMBS = import.meta.glob<string>("../../assets/lighting-thumbs/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
});

const lightingThumbFor = (id: string): string | null =>
  LIGHTING_THUMBS[`../../assets/lighting-thumbs/${id}.jpg`] ?? null;

const environmentLabel = (source: string): string => {
  if (source === NONE_SOURCE) return "None";
  if (source === SOFTBOX_SOURCE) return "Softbox";
  const stem = source.replace(/^kookaburra:/, "").replace(/^assets\//, "");
  return stem.replace(/\.(hdr|exr)$/i, "").replace(/[-_]/g, " ");
};

/** The Lighting drill-in (v9): edits the resolved theme -> project -> scene layers. Inherited values render from the resolve, never written on open (writing on open would diff every scene the user merely looked at); each edit writes its WHOLE field into the sidecar (the mergeLighting whole-field contract). Environment is a read-only summary until PR 3. */

/** Seed rig for "Light this scene" on an unlit theme: the soft-studio starting point. */
const DEFAULT_SUN: SunSpec = { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8 };
const DEFAULT_AMBIENT = 0.4;
const DEFAULT_SHADOW: ThemeShadowSpec = {
  technique: "map",
  softness: 0.5,
  opacity: 0.3,
  mapSize: 2048,
  bias: -0.0005,
};
const MAP_SIZES = [1024, 2048, 4096];

const TYPE_LABEL: Record<LightSpec["type"], string> = {
  directional: "Directional",
  point: "Point",
  spot: "Spot",
  area: "Area",
};

/** Per-type intensity slider ceilings (three's units differ wildly between types). */
const INTENSITY_MAX: Record<LightSpec["type"], number> = {
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
const LIGHT_DEFAULTS: Record<LightSpec["type"], (id: string) => LightSpec> = {
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

function nextLightId(lights: readonly LightSpec[]): string {
  let n = 1;
  while (lights.some((l) => l.id === `light-${n}`)) n += 1;
  return `light-${n}`;
}

const FORM_LABEL: Record<FixtureSpec["form"], string> = {
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
function LightTypeIcon({ type, size = 13 }: { type: LightSpec["type"]; size?: number }) {
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
function FixtureFormIcon({ form, size = 13 }: { form: FixtureSpec["form"]; size?: number }) {
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
function NoReflectionsIcon() {
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
const FIXTURE_DEFAULTS: Record<FixtureSpec["form"], (id: string) => FixtureSpec> = {
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

function nextFixtureId(fixtures: readonly FixtureSpec[]): string {
  let n = 1;
  while (fixtures.some((f) => f.id === `fixture-${n}`)) n += 1;
  return `fixture-${n}`;
}

/** Which layer a field currently comes from, for the group hints ("From theme" placeholders). */
function fieldSource(
  field: keyof LightingSpec,
  doc: LightingSpec | undefined,
  project: LightingSpec | undefined,
): string | undefined {
  if (doc?.[field] !== undefined) return undefined;
  if (project?.[field] !== undefined) return "From project";
  return "From theme";
}

export function LightingSectionBody({
  doc,
  theme,
  projectId,
  projectLighting,
  slot,
  onBack,
  patchDoc,
  commitFromBaseline,
}: {
  doc: SceneDoc;
  theme: Theme;
  projectId: string;
  projectLighting: LightingSpec | undefined;
  /** The scene's timeline placement, for "Add key at playhead". */
  slot: { startMs: number; durationMs: number };
  onBack: () => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
}) {
  const resolved = resolveLighting(theme.lighting, projectLighting, doc.lighting);
  const dragBaseline = useRef<SceneDoc | null>(null);
  const [lightId, setLightId] = useState<string | null>(null);
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  // The project's own .hdr/.exr files, listed once per open (extra tiles below the bundled set).
  const [projectMaps, setProjectMaps] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listProjectEnvironmentAssets(projectId).then((rels) => {
      if (!cancelled) setProjectMaps(rels);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Live slider ticks write history-less; the release records one entry from the drag-start snapshot (the video-window pattern).
  const live = (mutate: (next: SceneDoc) => void) => {
    if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
    void patchDoc(mutate, { history: false });
  };
  const commit = (mutate: (next: SceneDoc) => void) => {
    const baseline = dragBaseline.current;
    dragBaseline.current = null;
    if (baseline) void commitFromBaseline(baseline, mutate);
    else void patchDoc(mutate);
  };

  // Each writer patches the WHOLE field from the resolved base (whole-field replacement), so a first edit on an inherited value captures the base rather than a partial fragment.
  const writeSun =
    (mutate: (s: SunSpec) => void) =>
    (next: SceneDoc): void => {
      const sun = structuredClone(resolved?.sun ?? DEFAULT_SUN);
      mutate(sun);
      next.lighting = { ...(next.lighting ?? {}), sun };
    };
  const writeAmbient =
    (value: number) =>
    (next: SceneDoc): void => {
      next.lighting = { ...(next.lighting ?? {}), ambient: value };
    };
  const writeFills =
    (mutate: (fills: ThemeLightSpec[]) => void) =>
    (next: SceneDoc): void => {
      const fills = structuredClone(resolved?.fills ?? []);
      mutate(fills);
      next.lighting = { ...(next.lighting ?? {}), fills };
    };
  const writeShadow =
    (mutate: (s: ThemeShadowSpec) => void) =>
    (next: SceneDoc): void => {
      const shadow = structuredClone(resolved?.shadow ?? DEFAULT_SHADOW);
      mutate(shadow);
      next.lighting = { ...(next.lighting ?? {}), shadow };
    };
  const writeLights =
    (mutate: (lights: LightSpec[]) => void) =>
    (next: SceneDoc): void => {
      const lights = structuredClone(resolved?.lights ?? []);
      mutate(lights);
      next.lighting = { ...(next.lighting ?? {}), lights };
    };
  const writeEnvironment =
    (mutate: (e: EnvironmentSpec) => void) =>
    (next: SceneDoc): void => {
      const environment = structuredClone(
        resolveSceneEnvironment(theme, projectLighting, doc) ?? {
          source: NONE_SOURCE,
          intensity: 1,
          rotationDeg: 0,
        },
      );
      mutate(environment);
      next.lighting = { ...(next.lighting ?? {}), environment };
    };
  const writeLight = (id: string, mutate: (l: LightSpec) => void) =>
    writeLights((lights) => {
      const light = lights.find((l) => l.id === id);
      if (light) mutate(light);
    });

  const addLight = (type: LightSpec["type"]) => {
    const id = nextLightId(resolved?.lights ?? []);
    commit(writeLights((lights) => lights.push(LIGHT_DEFAULTS[type](id))));
    setLightId(id);
  };

  const writeFixtures =
    (mutate: (fixtures: FixtureSpec[]) => void) =>
    (next: SceneDoc): void => {
      const fixtures = structuredClone(resolved?.fixtures ?? []);
      mutate(fixtures);
      next.lighting = { ...(next.lighting ?? {}), fixtures };
    };
  const writeFixture = (id: string, mutate: (f: FixtureSpec) => void) =>
    writeFixtures((fixtures) => {
      const fixture = fixtures.find((f) => f.id === id);
      if (fixture) mutate(fixture);
    });
  const addFixture = (form: FixtureSpec["form"]) => {
    const id = nextFixtureId(resolved?.fixtures ?? []);
    commit(writeFixtures((fixtures) => fixtures.push(FIXTURE_DEFAULTS[form](id))));
    setFixtureId(id);
  };

  const sun = resolved?.sun;
  const shadow = resolved?.shadow;
  const sunSwatch = sun ? resolveLightingColour(sun, theme.colors) : "#ffffff";
  const angularDisplay = sun?.angularDeg ?? sunShadowSoftness(sun, shadow) * SUN_ANGULAR_REFERENCE;
  const environment = resolveSceneEnvironment(theme, projectLighting, doc);

  const selectedFixture = fixtureId
    ? (resolved?.fixtures ?? []).find((f) => f.id === fixtureId)
    : undefined;
  if (selectedFixture) {
    return (
      <FixtureEditor
        fixture={selectedFixture}
        colors={theme.colors}
        onBack={() => {
          useLightEditStore.getState().select(null);
          setFixtureId(null);
        }}
        onLive={(mutate) => live(writeFixture(selectedFixture.id, mutate))}
        onCommit={(mutate) => commit(writeFixture(selectedFixture.id, mutate))}
        onDuplicate={() => {
          const id = nextFixtureId(resolved?.fixtures ?? []);
          commit(
            writeFixtures((fixtures) => {
              const source = fixtures.find((f) => f.id === selectedFixture.id);
              if (source) {
                const copy = structuredClone(source);
                copy.id = id;
                copy.name = undefined;
                fixtures.push(copy);
              }
            }),
          );
          setFixtureId(id);
        }}
        onDelete={() => {
          commit(
            writeFixtures((fixtures) => {
              const at = fixtures.findIndex((f) => f.id === selectedFixture.id);
              if (at >= 0) fixtures.splice(at, 1);
            }),
          );
          setFixtureId(null);
        }}
      />
    );
  }

  const selectedLight = lightId
    ? (resolved?.lights ?? []).find((l) => l.id === lightId)
    : undefined;
  if (selectedLight) {
    return (
      <LightEditor
        light={selectedLight}
        colors={theme.colors}
        onBack={() => {
          useLightEditStore.getState().select(null);
          setLightId(null);
        }}
        onLive={(mutate) => live(writeLight(selectedLight.id, mutate))}
        onCommit={(mutate) => commit(writeLight(selectedLight.id, mutate))}
        onDuplicate={() => {
          const id = nextLightId(resolved?.lights ?? []);
          commit(
            writeLights((lights) => {
              const source = lights.find((l) => l.id === selectedLight.id);
              if (source) lights.push({ ...structuredClone(source), id, name: undefined });
            }),
          );
          setLightId(id);
        }}
        onDelete={() => {
          commit(
            writeLights((lights) => {
              const at = lights.findIndex((l) => l.id === selectedLight.id);
              if (at >= 0) lights.splice(at, 1);
            }),
          );
          setLightId(null);
        }}
      />
    );
  }

  return (
    <div className="inspector-drill">
      <DrillBack label="Scene" onClick={onBack} />
      <div className="inspector-drill-title">Lighting</div>
      <div className="inspector-drill-body inspector-section-body">
        {!resolved ? (
          <>
            <p className="modal-hint">
              This scene isn't lit: its theme has no lighting and nothing overrides it. Lighting the
              scene stands the primitives' bundled rigs down and lights them from here.
            </p>
            <ActionRow
              label="Light this scene"
              chevron={false}
              onClick={() =>
                commit((next) => {
                  next.lighting = {
                    ...(next.lighting ?? {}),
                    sun: structuredClone(DEFAULT_SUN),
                    ambient: DEFAULT_AMBIENT,
                  };
                })
              }
            />
          </>
        ) : (
          <>
            <DrillGroup
              label="Presets"
              hint="One click writes a complete look into this scene; every value stays tweakable after."
            >
              <div className="option-grid">
                {LIGHTING_PRESETS.map((preset) => (
                  <OptionCard
                    key={preset.id}
                    label={preset.label}
                    title={preset.description}
                    image={lightingThumbFor(preset.id)}
                    selected={doc.lighting?.preset === preset.id}
                    onSelect={() =>
                      commit((next) => {
                        // By-value application (the shader-preset model): keys survive only if their referenced ids still exist after the swap.
                        next.lighting = structuredClone({ ...preset.spec, preset: preset.id });
                      })
                    }
                  />
                ))}
              </div>
            </DrillGroup>

            <DrillGroup
              label="Environment"
              hint={fieldSource("environment", doc.lighting, projectLighting)}
            >
              {/* Lighting-only IBL: reflections and specular, never a visible background. */}
              <div className="option-grid">
                <OptionCard
                  label="None"
                  title="Explicitly no reflections"
                  image={null}
                  icon={<NoReflectionsIcon />}
                  selected={environment?.source === NONE_SOURCE}
                  onSelect={() =>
                    commit(writeEnvironment((e) => Object.assign(e, { source: NONE_SOURCE })))
                  }
                />
                <OptionCard
                  label="Softbox"
                  title="The procedural three-panel studio rig"
                  image={lightingThumbFor("softbox")}
                  selected={environment?.source === SOFTBOX_SOURCE}
                  onSelect={() =>
                    commit(writeEnvironment((e) => Object.assign(e, { source: SOFTBOX_SOURCE })))
                  }
                />
                {BUNDLED_ENVIRONMENT_IDS.map((id) => (
                  <OptionCard
                    key={id}
                    label={environmentLabel(id)}
                    image={thumbFor(id)}
                    selected={environment?.source === id}
                    onSelect={() =>
                      commit(writeEnvironment((e) => Object.assign(e, { source: id })))
                    }
                  />
                ))}
                {projectMaps.map((rel) => (
                  <OptionCard
                    key={rel}
                    label={environmentLabel(rel)}
                    title={rel}
                    image={null}
                    selected={environment?.source === rel}
                    onSelect={() =>
                      commit(writeEnvironment((e) => Object.assign(e, { source: rel })))
                    }
                  />
                ))}
              </div>
              {environment && environment.source !== NONE_SOURCE && (
                <>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Intensity</span>
                    <DebouncedRange
                      label="Intensity"
                      value={environment.intensity}
                      min={0}
                      max={3}
                      step={0.05}
                      onInput={(n) => live(writeEnvironment((e) => (e.intensity = n)))}
                      onCommit={(n) => commit(writeEnvironment((e) => (e.intensity = n)))}
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Rotation</span>
                    <DebouncedRange
                      label="Rotation °"
                      value={environment.rotationDeg}
                      min={0}
                      max={360}
                      step={1}
                      onInput={(n) => live(writeEnvironment((e) => (e.rotationDeg = n)))}
                      onCommit={(n) => commit(writeEnvironment((e) => (e.rotationDeg = n)))}
                    />
                  </div>
                </>
              )}
              {doc.lighting?.environment && (
                <ActionRow
                  label="Use the theme's reflections"
                  chevron={false}
                  onClick={() =>
                    commit((next) => {
                      if (next.lighting) delete next.lighting.environment;
                    })
                  }
                />
              )}
            </DrillGroup>

            <DrillGroup label="Sun" hint={fieldSource("sun", doc.lighting, projectLighting)}>
              {sun ? (
                <>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Azimuth</span>
                    <DebouncedRange
                      label="Azimuth"
                      value={sun.azimuthDeg}
                      min={-180}
                      max={180}
                      step={1}
                      onInput={(n) => live(writeSun((s) => (s.azimuthDeg = n)))}
                      onCommit={(n) => commit(writeSun((s) => (s.azimuthDeg = n)))}
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Elevation</span>
                    <DebouncedRange
                      label="Elevation"
                      value={sun.elevationDeg}
                      min={-90}
                      max={90}
                      step={1}
                      onInput={(n) => live(writeSun((s) => (s.elevationDeg = n)))}
                      onCommit={(n) => commit(writeSun((s) => (s.elevationDeg = n)))}
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Intensity</span>
                    <DebouncedRange
                      label="Intensity"
                      value={sun.intensity}
                      min={0}
                      max={6}
                      step={0.05}
                      onInput={(n) => live(writeSun((s) => (s.intensity = n)))}
                      onCommit={(n) => commit(writeSun((s) => (s.intensity = n)))}
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Angular size</span>
                    <DebouncedRange
                      label="Angular size °"
                      value={angularDisplay}
                      min={0}
                      max={16}
                      step={0.1}
                      onInput={(n) => live(writeSun((s) => (s.angularDeg = n)))}
                      onCommit={(n) => commit(writeSun((s) => (s.angularDeg = n)))}
                    />
                  </div>
                  <div className="lighting-kelvin-row">
                    <span className="popover-inline slider-row-label">Temperature</span>
                    <span
                      className="lighting-kelvin-swatch"
                      style={{ background: sunSwatch }}
                      title={sun.kelvin !== undefined ? `${sun.kelvin} K` : "Theme colour"}
                    />
                    <DebouncedRange
                      label="Temperature K"
                      value={sun.kelvin ?? 6500}
                      min={1000}
                      max={20000}
                      step={100}
                      onInput={(n) => live(writeSun((s) => (s.kelvin = n)))}
                      onCommit={(n) => commit(writeSun((s) => (s.kelvin = n)))}
                    />
                  </div>
                  {sun.kelvin !== undefined ? (
                    <ActionRow
                      label="Use a custom colour instead"
                      chevron={false}
                      onClick={() =>
                        commit(
                          writeSun((s) => {
                            delete s.kelvin;
                          }),
                        )
                      }
                    />
                  ) : (
                    <div className="camera-loop-modes">
                      <span className="drill-group-hint">Custom colour</span>
                      <ColourPicker
                        value={sun.color ?? "#ffffff"}
                        label="Sun colour"
                        onCommit={(hex) =>
                          commit(
                            writeSun((s) => {
                              s.color = hex;
                              delete s.kelvin;
                            }),
                          )
                        }
                      />
                    </div>
                  )}
                  <ToggleRow
                    label="Sun enabled"
                    description="Off keeps the sun's settings without lighting anything."
                    checked={sun.enabled !== false}
                    onChange={(on) => commit(writeSun((s) => (s.enabled = on ? undefined : false)))}
                  />
                  <ToggleRow
                    label="Cast shadows"
                    description="Real shadow maps need a floor or backdrop staged."
                    checked={sun.castShadow !== false}
                    onChange={(on) =>
                      commit(writeSun((s) => (s.castShadow = on ? undefined : false)))
                    }
                  />
                </>
              ) : (
                <ActionRow
                  label="Add a sun"
                  chevron={false}
                  onClick={() => commit(writeSun(() => {}))}
                />
              )}
            </DrillGroup>

            <DrillGroup
              label="Ambient"
              hint={fieldSource("ambient", doc.lighting, projectLighting)}
            >
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Intensity</span>
                <DebouncedRange
                  label="Intensity"
                  value={resolved.ambient ?? 0}
                  min={0}
                  max={2}
                  step={0.01}
                  onInput={(n) => live(writeAmbient(n))}
                  onCommit={(n) => commit(writeAmbient(n))}
                />
              </div>
            </DrillGroup>

            {(resolved.fills?.length ?? 0) > 0 && (
              <DrillGroup label="Fills" hint={fieldSource("fills", doc.lighting, projectLighting)}>
                {(resolved.fills ?? []).map((fill, i) => (
                  // Fills are a static ordered list; index identity is stable.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static ordered list
                  <div className="popover-row" key={i}>
                    <span className="popover-inline slider-row-label">{`Fill ${i + 1}`}</span>
                    <DebouncedRange
                      label={`Fill ${i + 1}`}
                      value={fill.intensity}
                      min={0}
                      max={4}
                      step={0.05}
                      onInput={(n) => live(writeFills((fills) => (fills[i].intensity = n)))}
                      onCommit={(n) => commit(writeFills((fills) => (fills[i].intensity = n)))}
                    />
                  </div>
                ))}
              </DrillGroup>
            )}

            <DrillGroup label="Lights" hint={fieldSource("lights", doc.lighting, projectLighting)}>
              {(resolved.lights ?? []).map((light) => (
                <ActionRow
                  key={light.id}
                  icon={<LightTypeIcon type={light.type} size={17} />}
                  label={light.name ?? TYPE_LABEL[light.type]}
                  value={`${TYPE_LABEL[light.type]} · ${light.intensity}`}
                  onClick={() => {
                    useLightEditStore.getState().select("light", light.id);
                    setLightId(light.id);
                  }}
                />
              ))}
              <div className="camera-loop-modes">
                <span className="drill-group-hint">Add</span>
                {(Object.keys(TYPE_LABEL) as LightSpec["type"][]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className="chip"
                    title={`Add a ${TYPE_LABEL[type].toLowerCase()} light`}
                    onClick={() => addLight(type)}
                  >
                    <LightTypeIcon type={type} />
                    {TYPE_LABEL[type]}
                  </button>
                ))}
              </div>
            </DrillGroup>

            <DrillGroup
              label="Fixtures"
              hint={
                fieldSource("fixtures", doc.lighting, projectLighting) ??
                "Fixtures glow when the scene has bloom."
              }
            >
              {(resolved.fixtures ?? []).map((fixture) => (
                <ActionRow
                  key={fixture.id}
                  icon={<FixtureFormIcon form={fixture.form} size={17} />}
                  label={fixture.name ?? FORM_LABEL[fixture.form]}
                  value={`${FORM_LABEL[fixture.form]}${fixture.repeat && fixture.repeat.count > 1 ? ` ×${fixture.repeat.count}${fixture.repeat.mirrorAxis ? "×2" : ""}` : ""}`}
                  onClick={() => {
                    useLightEditStore.getState().select("fixture", fixture.id);
                    setFixtureId(fixture.id);
                  }}
                />
              ))}
              <div className="camera-loop-modes">
                <span className="drill-group-hint">Add</span>
                {(Object.keys(FORM_LABEL) as FixtureSpec["form"][]).map((form) => (
                  <button
                    key={form}
                    type="button"
                    className="chip"
                    title={`Add a ${FORM_LABEL[form].toLowerCase()} fixture`}
                    onClick={() => addFixture(form)}
                  >
                    <FixtureFormIcon form={form} />
                    {FORM_LABEL[form]}
                  </button>
                ))}
              </div>
            </DrillGroup>

            <DrillGroup label="Shadow" hint={fieldSource("shadow", doc.lighting, projectLighting)}>
              <ToggleRow
                label="Real shadow maps"
                description="Renders only when the scene stages a floor or backdrop."
                checked={(shadow?.technique ?? DEFAULT_SHADOW.technique) === "map"}
                onChange={(on) => commit(writeShadow((s) => (s.technique = on ? "map" : "none")))}
              />
              {(shadow?.technique ?? "map") === "map" && (
                <>
                  <div className="popover-row">
                    <span className="popover-inline slider-row-label">Opacity</span>
                    <DebouncedRange
                      label="Opacity"
                      value={shadow?.opacity ?? DEFAULT_SHADOW.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      onInput={(n) => live(writeShadow((s) => (s.opacity = n)))}
                      onCommit={(n) => commit(writeShadow((s) => (s.opacity = n)))}
                    />
                  </div>
                  <div className="camera-loop-modes">
                    {MAP_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`chip${(shadow?.mapSize ?? DEFAULT_SHADOW.mapSize) === size ? " selected" : ""}`}
                        title={`${size} px shadow map`}
                        onClick={() => commit(writeShadow((s) => (s.mapSize = size)))}
                      >
                        {size}
                      </button>
                    ))}
                    <NumberField
                      label="bias"
                      value={shadow?.bias ?? DEFAULT_SHADOW.bias}
                      decimals={4}
                      dragScale={0.0001}
                      onCommit={(n) => commit(writeShadow((s) => (s.bias = n)))}
                    />
                    <ColourPicker
                      value={shadow?.color ?? "#000000"}
                      label="Shadow tint"
                      defaultValue="#000000"
                      onCommit={(hex) => commit(writeShadow((s) => (s.color = hex)))}
                    />
                  </div>
                </>
              )}
            </DrillGroup>

            <DrillGroup
              label="Animation"
              hint="One sparse track over the whole rig: each key captures this scene's current overrides; consecutive keys chain with an ease."
            >
              {[...(doc.lighting?.keys ?? [])]
                .sort((a, b) => a.tMs - b.tMs)
                .map((key) => (
                  <ActionRow
                    key={key.id}
                    label={`${(key.tMs / 1000).toFixed(2)}s`}
                    value={Object.keys(key.pose).join(", ") || "empty"}
                    chevron={false}
                    onClick={() =>
                      commit((next) => {
                        if (!next.lighting?.keys) return;
                        next.lighting.keys = next.lighting.keys.filter((k) => k.id !== key.id);
                        next.lighting.segments = chainLightingSegments(
                          next.lighting.keys,
                          next.lighting.segments,
                        );
                        if (next.lighting.keys.length === 0) {
                          delete next.lighting.keys;
                          delete next.lighting.segments;
                        }
                      })
                    }
                  />
                ))}
              <ActionRow
                label="Add key at playhead"
                chevron={false}
                onClick={() => {
                  const localMs = Math.round(
                    Math.min(
                      slot.durationMs,
                      Math.max(0, useClockStore.getState().currentMs - slot.startMs),
                    ),
                  );
                  const pose = captureLightingPose(theme, projectLighting, doc.lighting);
                  commit((next) => {
                    const lighting = next.lighting ?? {};
                    const keys = [...(lighting.keys ?? [])];
                    keys.push({ id: nextKeyId({ keys, segments: [] }), tMs: localMs, pose });
                    lighting.keys = keys;
                    lighting.segments = chainLightingSegments(keys, lighting.segments);
                    next.lighting = lighting;
                  });
                }}
              />
              {(doc.lighting?.keys?.length ?? 0) > 0 && (
                <p className="modal-hint">
                  Tap a key to remove it. A keyed shadow-casting light re-renders its shadow map
                  every frame, which is correct and costly.
                </p>
              )}
            </DrillGroup>

            {doc.lighting && (
              <>
                <div className="inspector-section-divider" />
                <ActionRow
                  label="Reset to theme"
                  chevron={false}
                  onClick={() =>
                    commit((next) => {
                      delete next.lighting;
                    })
                  }
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One free light's editor: type-specific fields, the World/Camera/Subject space row, the lossless Orbit/Position placement pair, the colour union (kelvin first, token swatches, custom hex) and the per-type shadow policy. */
function LightEditor({
  light,
  colors,
  onBack,
  onLive,
  onCommit,
  onDuplicate,
  onDelete,
}: {
  light: LightSpec;
  colors: Theme["colors"];
  onBack: () => void;
  onLive: (mutate: (l: LightSpec) => void) => void;
  onCommit: (mutate: (l: LightSpec) => void) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const aim = light.target ?? ([0, 0, 0] as [number, number, number]);
  const space = light.space ?? "world";
  const swatch = resolveLightingColour(light, colors);
  const canShadow = light.type === "directional" || light.type === "spot";
  const aimed = light.type !== "point";
  const placement = light.placement;
  const spaceHint = SPACE_HINT[space];

  return (
    <div className="inspector-drill">
      <DrillBack label="Lighting" onClick={onBack} />
      <div className="inspector-drill-title">{light.name ?? TYPE_LABEL[light.type]}</div>
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
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Azimuth</span>
                <DebouncedRange
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
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Elevation</span>
                <DebouncedRange
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
              </div>
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
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Intensity</span>
            <DebouncedRange
              label="Intensity"
              value={light.intensity}
              min={0}
              max={INTENSITY_MAX[light.type]}
              step={0.05}
              onInput={(n) => onLive((l) => (l.intensity = n))}
              onCommit={(n) => onCommit((l) => (l.intensity = n))}
            />
          </div>
          {light.type === "spot" && (
            <>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Cone</span>
                <DebouncedRange
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
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Penumbra</span>
                <DebouncedRange
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
              </div>
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
          <div className="lighting-kelvin-row">
            <span className="popover-inline slider-row-label">Temperature</span>
            <span
              className="lighting-kelvin-swatch"
              style={{ background: swatch }}
              title={light.kelvin !== undefined ? `${light.kelvin} K` : "Colour"}
            />
            <DebouncedRange
              label="Temperature K"
              value={light.kelvin ?? 6500}
              min={1000}
              max={20000}
              step={100}
              onInput={(n) => onLive((l) => (l.kelvin = n))}
              onCommit={(n) => onCommit((l) => (l.kelvin = n))}
            />
          </div>
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
        <ActionRow label="Duplicate light" chevron={false} onClick={onDuplicate} />
        <ActionRow label="Delete light" chevron={false} danger onClick={onDelete} />
      </div>
    </div>
  );
}

/** One fixture's editor: form, per-form sized geometry, the colour union, emissive + paired light intensity, placement + rotation, the World/Camera/Subject space row, the repeat block and the env-mirror toggle. */
function FixtureEditor({
  fixture,
  colors,
  onBack,
  onLive,
  onCommit,
  onDuplicate,
  onDelete,
}: {
  fixture: FixtureSpec;
  colors: Theme["colors"];
  onBack: () => void;
  onLive: (mutate: (f: FixtureSpec) => void) => void;
  onCommit: (mutate: (f: FixtureSpec) => void) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const space = fixture.space ?? "world";
  const swatch = resolveLightingColour(fixture, colors);
  const [sizeA, sizeB] = SIZE_LABELS[fixture.form];
  const position =
    fixture.placement.mode === "point" ? fixture.placement.position : ([0, 0, 0] as const);
  const rotation = fixture.rotationDeg ?? ([0, 0, 0] as const);
  const repeat = fixture.repeat;

  return (
    <div className="inspector-drill">
      <DrillBack label="Lighting" onClick={onBack} />
      <div className="inspector-drill-title">{fixture.name ?? FORM_LABEL[fixture.form]}</div>
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
          <div className="lighting-kelvin-row">
            <span className="popover-inline slider-row-label">Temperature</span>
            <span
              className="lighting-kelvin-swatch"
              style={{ background: swatch }}
              title={fixture.kelvin !== undefined ? `${fixture.kelvin} K` : "Colour"}
            />
            <DebouncedRange
              label="Temperature K"
              value={fixture.kelvin ?? 4200}
              min={1000}
              max={20000}
              step={100}
              onInput={(n) => onLive((f) => (f.kelvin = n))}
              onCommit={(n) => onCommit((f) => (f.kelvin = n))}
            />
          </div>
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Emissive</span>
            <DebouncedRange
              label="Emissive"
              value={fixture.emissive}
              min={0}
              max={8}
              step={0.1}
              onInput={(n) => onLive((f) => (f.emissive = n))}
              onCommit={(n) => onCommit((f) => (f.emissive = n))}
            />
          </div>
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Light intensity</span>
            <DebouncedRange
              label="Light intensity"
              value={fixture.lightIntensity}
              min={0}
              max={40}
              step={0.5}
              onInput={(n) => onLive((f) => (f.lightIntensity = n))}
              onCommit={(n) => onCommit((f) => (f.lightIntensity = n))}
            />
          </div>
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
        <ActionRow label="Duplicate fixture" chevron={false} onClick={onDuplicate} />
        <ActionRow label="Delete fixture" chevron={false} danger onClick={onDelete} />
      </div>
    </div>
  );
}
