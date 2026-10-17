import { defineScene, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** The calm opener: a title on the theme's flat background, crossfading into the strobe. */
export default defineScene({
  id: "flash-spike-title",
  durationMs: 2000,
  Scene() {
    const title = useSceneText("title", "Flash check");
    const subtitle = useSceneText("subtitle", "");
    return <TitleBlock title={title} subtitle={subtitle} from={150} to={800} />;
  },
});
