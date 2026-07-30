import { defineScene, SceneStage } from "@kookaburra/toolkit";

/** The Softbox environment thumb: one near-mirror ball, so the card shows the actual procedural rig's reflections through the real PMREM bake path. */
export default defineScene({
  id: "thumb-softbox",
  durationMs: 1000,
  Scene() {
    return (
      <SceneStage>
        <mesh position={[0, 0, 0.6]}>
          <sphereGeometry args={[1.35, 64, 48]} />
          <meshStandardMaterial color="#c9ced6" roughness={0.06} metalness={1} />
        </mesh>
      </SceneStage>
    );
  },
});
