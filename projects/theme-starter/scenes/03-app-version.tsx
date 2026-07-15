import {
  AnimatedHeadline,
  defineScene,
  ImageCard,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Theme starter scene 3 — the app-version slide: icon, name, version. The icon is a flat
 * `ImageCard` (colour-exact, PNG alpha corners); name and version are theme text in the
 * headline and body faces. All strings live in the sidecar.
 */
export default defineScene({
  id: "starter-app-version",
  durationMs: 2600,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const name = useSceneText("name", "Your App");
    const version = useSceneText("version", "Version 8.0");
    const iconWidth = portrait ? 1.0 : 1.15;
    return (
      <SceneStage>
        <ImageCard
          src="assets/app-icon.png"
          from={150}
          to={700}
          position={[0, portrait ? 1.05 : 0.85, 0]}
          width={iconWidth}
        />
        <AnimatedHeadline
          text={name}
          textKey="name"
          from={400}
          to={1100}
          position={[0, portrait ? -0.35 : -0.45, 0]}
          fontSize={portrait ? 0.3 : 0.44}
        />
        <AnimatedHeadline
          text={version}
          textKey="version"
          from={700}
          to={1400}
          face="body"
          defaultColor="muted"
          position={[0, portrait ? -0.95 : -1.05, 0]}
          fontSize={portrait ? 0.14 : 0.2}
        />
      </SceneStage>
    );
  },
});
