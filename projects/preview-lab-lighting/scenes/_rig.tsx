import { HeroObject, SceneStage, useTheme } from "@kookaburra/toolkit";

/**
 * The shared thumbnail bake rig (the ws:lighting-audit arrangement, minus the headline):
 * a matte sphere for falloff and direction, a near-mirror sphere for environment
 * reflections, a rough slab for shadow shape, the handset for the real product material.
 * Not a scene module: only the light-*.tsx scenes reference it, so the scene glob never
 * loads it directly.
 */
export function Rig() {
  const theme = useTheme();
  return (
    <SceneStage>
      <mesh position={[-2.1, -0.35, 0.4]} castShadow receiveShadow>
        <sphereGeometry args={[0.58, 48, 32]} />
        <meshStandardMaterial color={theme.colors.muted} roughness={0.55} metalness={0} />
      </mesh>
      <mesh position={[-0.75, -0.5, 0.9]} castShadow receiveShadow>
        <sphereGeometry args={[0.42, 48, 32]} />
        <meshStandardMaterial color="#c9ced6" roughness={0.06} metalness={1} />
      </mesh>
      <mesh position={[2.0, -0.55, 0.2]} rotation={[0, -0.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.15, 0.9, 0.35]} />
        <meshStandardMaterial color={theme.colors.text} roughness={0.75} metalness={0} />
      </mesh>
      <HeroObject model="handset" position={[0.75, -0.05, 0]} scale={0.62} />
    </SceneStage>
  );
}
