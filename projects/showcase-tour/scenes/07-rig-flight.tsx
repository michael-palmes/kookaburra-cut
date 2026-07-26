import {
  AnimatedHeadline,
  DepthStage,
  Device,
  defineScene,
  ImageCard,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Showcase tour scene 7 — a DepthStage fly-through: the camera rig travels through four
 * depth bands with a tangent aim, banking as it goes and narrowing its lens on the way in.
 */
export default defineScene({
  id: "tour-rig-flight",
  durationMs: 2000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Fly right through it");
    const devices = useSceneDevices();
    return (
      <SceneStage>
        <DepthStage
          foreground={
            <>
              <ImageCard src="assets/app-icon.png" position={[-2.7, 1.1, 0]} width={1.3} />
              <ImageCard src="assets/app-icon.png" position={[2.9, -1.1, 0]} width={1.5} />
            </>
          }
          content={
            <>
              <AnimatedHeadline
                text={headline}
                textKey="headline"
                from={200}
                to={1000}
                position={[0, portrait ? 1.5 : 1.32, 0]}
                fontSize={portrait ? 0.23 : 0.42}
              />
              {devices.map((d) => {
                const scale = (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92);
                return (
                  <Device
                    key={d.id}
                    {...d}
                    placement={{
                      ...d.placement,
                      position: d.placement?.position ?? [0, -1.5 + 1.3 * scale, 0],
                      scale,
                    }}
                  />
                );
              })}
            </>
          }
          midground={
            <>
              <ImageCard src="assets/app-icon.png" position={[-2.1, 0.4, 0]} width={1.1} />
              <ImageCard src="assets/app-icon.png" position={[2.3, 0.8, 0]} width={1.1} />
            </>
          }
          backdrop={<ImageCard src="assets/app-icon.png" position={[0.4, 0.2, 0]} width={3} />}
        />
      </SceneStage>
    );
  },
});
