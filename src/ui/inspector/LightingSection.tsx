import { useEffect, useRef, useState } from "react";
import {
  BUNDLED_ENVIRONMENT_IDS,
  NONE_SOURCE,
  resolveSceneEnvironment,
  SOFTBOX_SOURCE,
} from "../../engine/environments";
import { placementToOrbit, placementToPoint } from "../../engine/orbit";
import { listProjectEnvironmentAssets } from "../../engine/project";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  resolveLighting,
  resolveLightingColour,
  SUN_ANGULAR_REFERENCE,
  sunShadowSoftness,
} from "../../engine/sceneLighting";
import type {
  EnvironmentSpec,
  LightingSpec,
  LightSpace,
  LightSpec,
  SunSpec,
  Theme,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "../../theme/tokens";
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
  onBack,
  patchDoc,
  commitFromBaseline,
}: {
  doc: SceneDoc;
  theme: Theme;
  projectId: string;
  projectLighting: LightingSpec | undefined;
  onBack: () => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
}) {
  const resolved = resolveLighting(theme.lighting, projectLighting, doc.lighting);
  const dragBaseline = useRef<SceneDoc | null>(null);
  const [lightId, setLightId] = useState<string | null>(null);
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

  const sun = resolved?.sun;
  const shadow = resolved?.shadow;
  const sunSwatch = sun ? resolveLightingColour(sun, theme.colors) : "#ffffff";
  const angularDisplay = sun?.angularDeg ?? sunShadowSoftness(sun, shadow) * SUN_ANGULAR_REFERENCE;
  const environment = resolveSceneEnvironment(theme, projectLighting, doc);

  const selectedLight = lightId
    ? (resolved?.lights ?? []).find((l) => l.id === lightId)
    : undefined;
  if (selectedLight) {
    return (
      <LightEditor
        light={selectedLight}
        colors={theme.colors}
        onBack={() => setLightId(null)}
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
              label="Environment"
              hint={fieldSource("environment", doc.lighting, projectLighting)}
            >
              {/* Lighting-only IBL: reflections and specular, never a visible background. */}
              <div className="option-grid">
                <OptionCard
                  label="None"
                  title="Explicitly no reflections"
                  image={null}
                  selected={environment?.source === NONE_SOURCE}
                  onSelect={() =>
                    commit(writeEnvironment((e) => Object.assign(e, { source: NONE_SOURCE })))
                  }
                />
                <OptionCard
                  label="Softbox"
                  title="The procedural three-panel studio rig"
                  image={null}
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
                  <DebouncedRange
                    label="Intensity"
                    value={environment.intensity}
                    min={0}
                    max={3}
                    step={0.05}
                    onInput={(n) => live(writeEnvironment((e) => (e.intensity = n)))}
                    onCommit={(n) => commit(writeEnvironment((e) => (e.intensity = n)))}
                  />
                  <DebouncedRange
                    label="Rotation °"
                    value={environment.rotationDeg}
                    min={0}
                    max={360}
                    step={1}
                    onInput={(n) => live(writeEnvironment((e) => (e.rotationDeg = n)))}
                    onCommit={(n) => commit(writeEnvironment((e) => (e.rotationDeg = n)))}
                  />
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
                  <DebouncedRange
                    label="Azimuth"
                    value={sun.azimuthDeg}
                    min={-180}
                    max={180}
                    step={1}
                    onInput={(n) => live(writeSun((s) => (s.azimuthDeg = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.azimuthDeg = n)))}
                  />
                  <DebouncedRange
                    label="Elevation"
                    value={sun.elevationDeg}
                    min={-90}
                    max={90}
                    step={1}
                    onInput={(n) => live(writeSun((s) => (s.elevationDeg = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.elevationDeg = n)))}
                  />
                  <DebouncedRange
                    label="Intensity"
                    value={sun.intensity}
                    min={0}
                    max={6}
                    step={0.05}
                    onInput={(n) => live(writeSun((s) => (s.intensity = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.intensity = n)))}
                  />
                  <DebouncedRange
                    label="Angular size °"
                    value={angularDisplay}
                    min={0}
                    max={16}
                    step={0.1}
                    onInput={(n) => live(writeSun((s) => (s.angularDeg = n)))}
                    onCommit={(n) => commit(writeSun((s) => (s.angularDeg = n)))}
                  />
                  <div className="lighting-kelvin-row">
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
              <DebouncedRange
                label="Intensity"
                value={resolved.ambient ?? 0}
                min={0}
                max={2}
                step={0.01}
                onInput={(n) => live(writeAmbient(n))}
                onCommit={(n) => commit(writeAmbient(n))}
              />
            </DrillGroup>

            {(resolved.fills?.length ?? 0) > 0 && (
              <DrillGroup label="Fills" hint={fieldSource("fills", doc.lighting, projectLighting)}>
                {(resolved.fills ?? []).map((fill, i) => (
                  <DebouncedRange
                    // Fills are a static ordered list; index identity is stable.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static ordered list
                    key={i}
                    label={`Fill ${i + 1}`}
                    value={fill.intensity}
                    min={0}
                    max={4}
                    step={0.05}
                    onInput={(n) => live(writeFills((fills) => (fills[i].intensity = n)))}
                    onCommit={(n) => commit(writeFills((fills) => (fills[i].intensity = n)))}
                  />
                ))}
              </DrillGroup>
            )}

            <DrillGroup label="Lights" hint={fieldSource("lights", doc.lighting, projectLighting)}>
              {(resolved.lights ?? []).map((light) => (
                <ActionRow
                  key={light.id}
                  label={light.name ?? TYPE_LABEL[light.type]}
                  value={`${TYPE_LABEL[light.type]} · ${light.intensity}`}
                  onClick={() => setLightId(light.id)}
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
                    {TYPE_LABEL[type]}
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
                  <DebouncedRange
                    label="Opacity"
                    value={shadow?.opacity ?? DEFAULT_SHADOW.opacity}
                    min={0}
                    max={1}
                    step={0.01}
                    onInput={(n) => live(writeShadow((s) => (s.opacity = n)))}
                    onCommit={(n) => commit(writeShadow((s) => (s.opacity = n)))}
                  />
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
          )}
        </DrillGroup>

        <DrillGroup label="Light">
          <DebouncedRange
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
