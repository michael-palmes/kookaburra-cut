import { defineScene, SceneStage, useFormat, useTheme } from "@kookaburra/toolkit";

export default defineScene({
  id: "fixture-inspector-redesign-content",
  durationMs: 1400,
  Scene() {
    const format = useFormat();
    const theme = useTheme();
    const pedestalWidth = Math.min(2.4, format.frame.width * 0.52);

    return (
      <SceneStage>
        <mesh position={[0, -1.08, -0.15]} receiveShadow>
          <boxGeometry args={[pedestalWidth, 0.12, 1.1]} />
          <meshStandardMaterial color={theme.colors.muted} roughness={0.7} metalness={0.05} />
        </mesh>
      </SceneStage>
    );
  },
});
