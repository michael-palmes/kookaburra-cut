import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { MatchStage } from "../lib/match";

export default defineScene({
  id: "unveil-cycles-match-01-name",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <MatchStage />
      </SceneStage>
    );
  },
});
