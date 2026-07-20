import { AnimatedCounter, AnimatedHeadline, defineScene, useFormat } from "@kookaburra/toolkit";

/** v14 gate scene: the headline names the transition that brings this scene IN
 *  (its boundary also carries ease: "snappy", gating the easing path). */
export default defineScene({
  id: "warp",
  durationMs: 1800,
  Scene() {
    const { frame, safe } = useFormat();
    const headlineY = frame.height / 2 - safe.top - 0.6;
    return (
      <group>
        <AnimatedHeadline text="Warp" from={0} to={450} position={[0, headlineY, 0]} />
        <AnimatedHeadline
          text="lens pull"
          from={250}
          to={700}
          fontSize={0.32}
          position={[0, headlineY - 0.9, 0]}
        />
        <AnimatedCounter
          from={0}
          to={81}
          durationMs={1200}
          format={(n) => `${Math.round(n)}%`}
          position={[0, -frame.height / 2 + safe.bottom + 0.7, 0]}
        />
      </group>
    );
  },
});
