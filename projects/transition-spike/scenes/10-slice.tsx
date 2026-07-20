import { AnimatedCounter, AnimatedHeadline, defineScene, useFormat } from "@kookaburra/toolkit";

/** v14 gate scene: the headline names the transition that brings this scene IN,
 *  so extracted seam frames are self-labelling. */
export default defineScene({
  id: "slice",
  durationMs: 1800,
  Scene() {
    const { frame, safe } = useFormat();
    const headlineY = frame.height / 2 - safe.top - 0.6;
    return (
      <group>
        <AnimatedHeadline text="Slice" from={0} to={450} position={[0, headlineY, 0]} />
        <AnimatedHeadline
          text="staggered strips"
          from={250}
          to={700}
          fontSize={0.32}
          position={[0, headlineY - 0.9, 0]}
        />
        <AnimatedCounter
          from={0}
          to={54}
          durationMs={1200}
          format={(n) => `${Math.round(n)}%`}
          position={[0, -frame.height / 2 + safe.bottom + 0.7, 0]}
        />
      </group>
    );
  },
});
