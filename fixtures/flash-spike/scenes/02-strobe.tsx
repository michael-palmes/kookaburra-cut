import { defineScene, useFormat, useTheme, useTimeline } from "@kookaburra/toolkit";

const HOLD_MS = 500;
const STROBE_END_MS = 1500;
const STROBE_STATE_MS = 100;
const CONTROL_STATE_MS = 250;

/** Which theme colour fills the frame: dark through the incoming crossfade, then 100 ms states for one second (5 flashes a second, a fail), then 250 ms states (2 a second, the control). */
function lit(localMs: number): boolean {
  if (localMs < HOLD_MS) return false;
  if (localMs < STROBE_END_MS) return Math.floor((localMs - HOLD_MS) / STROBE_STATE_MS) % 2 === 1;
  return Math.floor((localMs - STROBE_END_MS) / CONTROL_STATE_MS) % 2 === 1;
}

export default defineScene({
  id: "flash-spike-strobe",
  durationMs: 2500,
  Scene() {
    const { localMs } = useTimeline();
    const { frame } = useFormat();
    const theme = useTheme();
    const colour = lit(localMs) ? theme.colors.text : theme.colors.background;
    return (
      <mesh scale={[frame.width * 1.1, frame.height * 1.1, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color={colour} toneMapped={false} />
      </mesh>
    );
  },
});
