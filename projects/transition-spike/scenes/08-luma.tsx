import { AnimatedCounter, AnimatedHeadline, defineScene, useFormat } from "@kookaburra/toolkit";

/** v10 · M2 gate scene — the headline names the transition that brings this scene IN,
 *  so extracted seam frames are self-labelling. High-contrast text + a counter give the
 *  blur/whip/zoom/glitch seams structure to act on. */
export default defineScene({
  id: "luma",
  durationMs: 1800,
  Scene() {
    const { frame, safe } = useFormat();
    const headlineY = 0.35;
    return (
      <group>
        <AnimatedHeadline text="Iris wipe" from={0} to={450} position={[0, headlineY, 0]} />
        <AnimatedHeadline
          text="procedural luma"
          from={250}
          to={700}
          fontSize={0.32}
          position={[0, headlineY - 0.9, 0]}
        />
        <AnimatedCounter
          from={0}
          to={86}
          durationMs={1200}
          format={(n) => `${Math.round(n)}%`}
          position={[0, -frame.height / 2 + safe.bottom + 0.7, 0]}
        />
      </group>
    );
  },
});
