import { defineScene, SceneStage, useFormat, useTheme } from "@kookaburra/toolkit";

export default defineScene({
  id: "fixture-inspector-redesign-lighting",
  durationMs: 1600,
  Scene() {
    const format = useFormat();
    const theme = useTheme();
    const portrait = format.aspect < 1;
    const spread = Math.min(1.35, format.frame.width * 0.23);
    const scale = portrait ? 0.84 : 1;

    return (
      <SceneStage>
        <mesh position={[-spread, -0.42, 0.35]} scale={scale} castShadow receiveShadow>
          <sphereGeometry args={[0.55, 48, 32]} />
          <meshStandardMaterial color={theme.colors.muted} roughness={0.62} metalness={0} />
        </mesh>
        <mesh position={[spread, -0.5, 0.65]} scale={scale} castShadow receiveShadow>
          <sphereGeometry args={[0.44, 48, 32]} />
          <meshStandardMaterial color={theme.colors.text} roughness={0.08} metalness={0.92} />
        </mesh>
        <mesh position={[0, portrait ? 0.62 : -0.55, -0.6]} scale={scale} castShadow receiveShadow>
          <boxGeometry args={[1.1, 0.85, 0.36]} />
          <meshStandardMaterial color={theme.colors.accent} roughness={0.78} metalness={0.04} />
        </mesh>
      </SceneStage>
    );
  },
});
