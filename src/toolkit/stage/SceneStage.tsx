import { type ReactNode, useContext, useEffect, useId, useMemo, useRef } from "react";
import type { DirectionalLight, Light } from "three";
import { resolveFixturePlan } from "../../engine/fixtures";
import { registerLightingAnimatable } from "../../engine/lightingAnimation";
import { sunPosition } from "../../engine/orbit";
import {
  ProjectLightingContext,
  SceneDocContext,
  useSceneContext,
} from "../../engine/sceneContext";
import {
  MAX_SCENE_LIGHTS,
  resolveLightBudget,
  resolveLightingColour,
  sunShadowSoftness,
} from "../../engine/sceneLighting";
import { useStageRegistry } from "../../engine/stageRegistry";
import { useTheme } from "../../theme";
import { mergeLighting } from "../../theme/schema";
import type { ThemeLightSpec } from "../../theme/tokens";
import { StageFixtures } from "../lighting/Fixture";
import { LightHelpers } from "../lighting/LightHelpers";
import { DEFAULT_FLOOR_Y, StageBackdrop } from "./backdrops";
import { SceneStageContext, type SceneStageState } from "./context";
import { StageLights } from "./StageLights";
import {
  SHADOW_BLUR_SAMPLES,
  SHADOW_FAR,
  SHADOW_FRUSTUM_EXTENT,
  SHADOW_NEAR,
  SHADOW_RADIUS_SCALE,
} from "./shadowRig";

/** The theme-driven stage: lights the scene from the resolved lighting layers (theme -> project -> scene, see `mergeLighting`), mounts the resolved backdrop, and tells staged primitives to stand their bundled lit sets down; the camera-locked fixed background and environment reflections do NOT mount here (mounted elsewhere, at the scene host and the compositor seam respectively). Shadows are the HYBRID decision: the sun casts real shadow maps only when a floor/backdrop is staged AND the shadow technique is "map", else the procedural blob shadows remain the default; no lighting at any layer renders no lights and leaves primitives lit (context null) so a scaffolded scene stays visible under a legacy theme. The v8 path (sun + ambient + fills, no v9 fields) must emit an IDENTICAL scene graph: same component order, same props, same values. */

// The v8 sun sphere (LIGHT_RADIUS) lives in engine/orbit.ts, shared with the keyframe apply seam; the shadow rig constants live in shadowRig.ts, shared with shadow-casting free lights.
function lightPosition(spec: ThemeLightSpec): [number, number, number] {
  return sunPosition(spec.azimuthDeg, spec.elevationDeg);
}

export function SceneStage({
  children,
  floorY,
}: {
  children?: ReactNode;
  /** Stage floor height for a floor backdrop (world y; default −1.5). */
  floorY?: number;
}) {
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const projectLighting = useContext(ProjectLightingContext);
  const lighting = useMemo(
    () => mergeLighting(theme.lighting, projectLighting ?? undefined, doc?.lighting),
    [theme, projectLighting, doc],
  );
  const backdrop = doc?.backdrop ?? theme.backdrop;
  const hasBackdrop = backdrop !== undefined && backdrop.type !== "none";
  const shadow = lighting?.shadow;
  const mapShadows = Boolean(hasBackdrop && shadow && shadow.technique === "map");
  const sun = lighting?.sun;

  // Report staging to the registry so the Background editor can warn about occluded fills.
  const sceneIndex = useSceneContext()?.index;
  const backdropType = backdrop?.type ?? "none";
  useEffect(() => {
    if (sceneIndex === undefined) return;
    useStageRegistry.getState().register(sceneIndex, backdropType);
    return () => useStageRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex, backdropType]);

  const stageFloorY = backdrop?.type === "floor" ? (floorY ?? DEFAULT_FLOOR_Y) : null;
  const stageState = useMemo<SceneStageState | null>(
    () => (lighting ? { mapShadows, floorY: stageFloorY } : null),
    [lighting, mapShadows, stageFloorY],
  );

  // Keyframe apply-seam registration: the sun and ambient are animatable per scene (no track mounted means the registry is populated but never read).
  const animKey = useId();
  const sunRef = useRef<DirectionalLight>(null);
  const ambientRef = useRef<Light>(null);
  useEffect(() => {
    if (!lighting || sceneIndex === undefined) return;
    const cleanups: (() => void)[] = [];
    if (sunRef.current && sun) {
      cleanups.push(
        registerLightingAnimatable(`${animKey}:sun`, {
          kind: "sun",
          sceneIndex,
          light: sunRef.current,
          base: sun,
          baseColor: resolveLightingColour(sun, theme.colors),
        }),
      );
    }
    if (ambientRef.current && lighting.ambient !== undefined) {
      cleanups.push(
        registerLightingAnimatable(`${animKey}:ambient`, {
          kind: "ambient",
          sceneIndex,
          light: ambientRef.current,
          base: lighting.ambient,
        }),
      );
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [animKey, lighting, sun, sceneIndex, theme]);

  // Free lights + fixtures (v9): deterministic budgets computed once per resolved spec; over-cap drops warn here, once, never silently.
  const sunCasts = Boolean(sun && sun.enabled !== false && mapShadows && sun.castShadow !== false);
  const budget = useMemo(() => {
    if (!lighting) return null;
    if ((lighting.lights?.length ?? 0) === 0 && (lighting.fixtures?.length ?? 0) === 0) {
      return null;
    }
    const b = resolveLightBudget(lighting, sunCasts);
    const sunSlot = lighting.sun && lighting.sun.enabled !== false ? 1 : 0;
    const fixtures = resolveFixturePlan(
      lighting.fixtures,
      MAX_SCENE_LIGHTS - sunSlot - b.lights.length,
    );
    if (b.droppedLights > 0) {
      console.warn(
        `[lighting] scene ${sceneIndex ?? "?"}: ${b.droppedLights} light(s) over the scene cap — dropped`,
      );
    }
    if (b.droppedCasters > 0) {
      console.warn(
        `[lighting] scene ${sceneIndex ?? "?"}: ${b.droppedCasters} shadow caster(s) over the cap — rendered without shadows`,
      );
    }
    if (fixtures.droppedInstances > 0) {
      console.warn(
        `[lighting] scene ${sceneIndex ?? "?"}: ${fixtures.droppedInstances} fixture instance(s) over the cap — dropped`,
      );
    }
    if (fixtures.thinnedLights > 0) {
      console.warn(
        `[lighting] scene ${sceneIndex ?? "?"}: ${fixtures.thinnedLights} fixture light(s) thinned to fit the scene cap — geometry keeps glowing`,
      );
    }
    return { ...b, fixtures };
  }, [lighting, sunCasts, sceneIndex]);

  return (
    <SceneStageContext.Provider value={stageState}>
      {lighting && (
        <>
          {lighting.ambient !== undefined && (
            <ambientLight ref={ambientRef} intensity={lighting.ambient} />
          )}
          {sun && sun.enabled !== false && (
            <directionalLight
              ref={sunRef}
              position={lightPosition(sun)}
              intensity={sun.intensity}
              color={resolveLightingColour(sun, theme.colors)}
              castShadow={mapShadows && sun.castShadow !== false}
              shadow-mapSize={[shadow?.mapSize ?? 2048, shadow?.mapSize ?? 2048]}
              shadow-radius={sunShadowSoftness(sun, shadow) * SHADOW_RADIUS_SCALE}
              shadow-blurSamples={SHADOW_BLUR_SAMPLES}
              shadow-bias={shadow?.bias ?? -0.0005}
              shadow-camera-left={-SHADOW_FRUSTUM_EXTENT}
              shadow-camera-right={SHADOW_FRUSTUM_EXTENT}
              shadow-camera-top={SHADOW_FRUSTUM_EXTENT}
              shadow-camera-bottom={-SHADOW_FRUSTUM_EXTENT}
              shadow-camera-near={SHADOW_NEAR}
              shadow-camera-far={SHADOW_FAR}
            />
          )}
          {(lighting.fills ?? []).map((fill, i) => (
            <directionalLight
              // Fills are a static ordered list from the theme; index identity is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: static theme-token list
              key={i}
              position={lightPosition(fill)}
              intensity={fill.intensity}
              color={fill.color ?? "#ffffff"}
            />
          ))}
          {budget && (
            <StageLights
              lights={budget.lights}
              shadowCasterIds={budget.shadowCasterIds}
              shadow={shadow}
              colors={theme.colors}
            />
          )}
          {budget && budget.fixtures.entries.length > 0 && (
            <StageFixtures entries={budget.fixtures.entries} colors={theme.colors} />
          )}
          <LightHelpers lighting={lighting} />
        </>
      )}
      {backdrop && (
        <StageBackdrop spec={backdrop} shadow={mapShadows ? shadow : undefined} floorY={floorY} />
      )}
      {children}
    </SceneStageContext.Provider>
  );
}
