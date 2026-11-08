import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { NameTitle, SceneDevices } from "../../atmosphere-spike/lib/staging";

export default defineScene({
  id: "atmos-perf-21-name-today",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <NameTitle position={[1.544, 0.03, 0]} fontSize={0.582} tiltDeg={4.9} />
        <SceneDevices />
      </SceneStage>
    );
  },
});
