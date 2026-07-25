import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { type Light, Object3D } from "three";
import { registerLightingAnimatable } from "../../engine/lightingAnimation";
import { registerRelativeLight } from "../../engine/lightingState";
import { placementPosition } from "../../engine/orbit";
import { useSceneContext } from "../../engine/sceneContext";
import { resolveLightingColour, spotHalfAngleRad } from "../../engine/sceneLighting";
import type { LightSpec, Theme, ThemeShadowSpec } from "../../theme/tokens";
import {
  SHADOW_BLUR_SAMPLES,
  SHADOW_FAR,
  SHADOW_FRUSTUM_EXTENT,
  SHADOW_NEAR,
  SHADOW_RADIUS_SCALE,
} from "./shadowRig";

/** The free-light list (v9 · PR 2): renders `lighting.lights` as three intrinsics. The set is keyed by light id and built once from the resolved spec, so slider drags mutate props on stable elements rather than remounting (a light-count change forces a three shader recompile; a value change does not). World lights hold their placement; camera/subject lights register with engine/lightingState.ts and have their transforms recomputed per render target at the compositor seam. */

const ORIGIN: [number, number, number] = [0, 0, 0];

function FreeLight({
  spec,
  shadow,
  allowShadow,
  colors,
}: {
  spec: LightSpec;
  shadow: ThemeShadowSpec | undefined;
  /** Inside the deterministic caster budget (declaration order, MAX_SHADOW_CASTERS). */
  allowShadow: boolean;
  colors: Theme["colors"];
}) {
  const key = useId();
  const aim = spec.target ?? ORIGIN;
  const relative = (spec.space ?? "world") !== "world";
  const position = placementPosition(spec.placement, aim);
  const color = resolveLightingColour(spec, colors);
  const lightRef = useRef<Object3D>(null);
  // Directional and spot lights aim via a target Object3D (three's classic gotcha: without one they point at the origin regardless); area lights aim themselves via lookAt.
  const targetObject = useMemo(() => new Object3D(), []);
  const aimed = spec.type === "directional" || spec.type === "spot";

  // Area lights orient toward their aim point (world lights once per value change; relative lights are re-aimed at the seam anyway).
  useLayoutEffect(() => {
    if (spec.type === "area") lightRef.current?.lookAt(aim[0], aim[1], aim[2]);
  });

  useEffect(() => {
    if (!relative || !lightRef.current) return;
    return registerRelativeLight(key, {
      object: lightRef.current,
      targetObject: aimed ? targetObject : null,
      aimSelf: spec.type === "area",
      spec: {
        space: (spec.space ?? "world") as "camera" | "subject",
        placement: spec.placement,
        target: aim,
      },
    });
  }, [key, relative, aimed, spec, aim, targetObject]);

  // Keyframe apply-seam registration (intensity/kelvin per light id; placement for world lights).
  const sceneIndex = useSceneContext()?.index;
  useEffect(() => {
    const light = lightRef.current as Light | null;
    if (!light || sceneIndex === undefined) return;
    return registerLightingAnimatable(`${key}:anim`, {
      kind: "light",
      sceneIndex,
      id: spec.id,
      light,
      base: spec,
      baseColor: color,
    });
  }, [key, spec, sceneIndex, color]);

  const castShadow = allowShadow && spec.castShadow === true;
  const mapSize = shadow?.mapSize ?? 2048;
  const radius = (shadow?.softness ?? 0.5) * SHADOW_RADIUS_SCALE;
  const bias = shadow?.bias ?? -0.0005;

  switch (spec.type) {
    case "directional":
      return (
        <>
          <directionalLight
            ref={lightRef}
            position={position}
            intensity={spec.intensity}
            color={color}
            target={targetObject}
            castShadow={castShadow}
            shadow-mapSize={[mapSize, mapSize]}
            shadow-radius={radius}
            shadow-blurSamples={SHADOW_BLUR_SAMPLES}
            shadow-bias={bias}
            shadow-camera-left={-SHADOW_FRUSTUM_EXTENT}
            shadow-camera-right={SHADOW_FRUSTUM_EXTENT}
            shadow-camera-top={SHADOW_FRUSTUM_EXTENT}
            shadow-camera-bottom={-SHADOW_FRUSTUM_EXTENT}
            shadow-camera-near={SHADOW_NEAR}
            shadow-camera-far={SHADOW_FAR}
          />
          <primitive object={targetObject} position={aim} />
        </>
      );
    case "point":
      return (
        <pointLight
          ref={lightRef}
          position={position}
          intensity={spec.intensity}
          color={color}
          distance={spec.distance ?? 0}
          decay={spec.decay ?? 2}
        />
      );
    case "spot":
      return (
        <>
          <spotLight
            ref={lightRef}
            position={position}
            intensity={spec.intensity}
            color={color}
            angle={spotHalfAngleRad(spec.angleDeg)}
            penumbra={spec.penumbra}
            distance={spec.distance ?? 0}
            decay={spec.decay ?? 2}
            target={targetObject}
            castShadow={castShadow}
            shadow-mapSize={[mapSize, mapSize]}
            shadow-radius={radius}
            shadow-blurSamples={SHADOW_BLUR_SAMPLES}
            shadow-bias={bias}
            shadow-camera-near={SHADOW_NEAR}
            shadow-camera-far={spec.distance && spec.distance > 0 ? spec.distance : SHADOW_FAR}
          />
          <primitive object={targetObject} position={aim} />
        </>
      );
    case "area":
      // Lights only Standard/Physical materials and never casts shadows (three.js #14161).
      return (
        <rectAreaLight
          ref={lightRef}
          position={position}
          intensity={spec.intensity}
          color={color}
          width={spec.width}
          height={spec.height}
        />
      );
    default:
      return null;
  }
}

export function StageLights({
  lights,
  shadowCasterIds,
  shadow,
  colors,
}: {
  /** The resolved, enabled, budget-capped light list (SceneStage owns the caps). */
  lights: LightSpec[];
  /** Ids inside the deterministic shadow-caster budget. */
  shadowCasterIds: ReadonlySet<string>;
  shadow: ThemeShadowSpec | undefined;
  colors: Theme["colors"];
}) {
  return (
    <>
      {lights.map((light) => (
        <FreeLight
          key={light.id}
          spec={light}
          shadow={shadow}
          allowShadow={shadowCasterIds.has(light.id)}
          colors={colors}
        />
      ))}
    </>
  );
}
