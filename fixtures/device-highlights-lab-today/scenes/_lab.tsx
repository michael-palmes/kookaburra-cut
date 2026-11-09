import {
  AnimatedHeadline,
  Device,
  SceneStage,
  ScreenRegion,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

/** Shared research rig: the sidecar's devices on the theme's stage, an optional static title, an optional lifted card (flat or glass), and an optional mirror and satin probe pair for reading the environment. Not a scene module. */
export function LabScene() {
  const devices = useSceneDevices();
  const title = useSceneText("title", "");
  const probe = useSceneText("probe", "");
  const card = useSceneText("card", "");
  return (
    <SceneStage>
      {title ? (
        <AnimatedHeadline
          text={title}
          textKey="title"
          preset="static"
          fontSize={0.5}
          anchorX="center"
          textAlign="center"
          position={[1.15, 0.05, 0]}
        />
      ) : null}
      {probe ? (
        <>
          <mesh position={[-0.85, 0, 0]}>
            <sphereGeometry args={[0.7, 96, 64]} />
            <meshStandardMaterial color="#ffffff" metalness={1} roughness={0} />
          </mesh>
          <mesh position={[0.85, 0, 0]}>
            <sphereGeometry args={[0.7, 96, 64]} />
            <meshStandardMaterial color="#ffffff" metalness={1} roughness={0.3} />
          </mesh>
        </>
      ) : null}
      {devices.map((d) => (
        <Device key={d.id} {...d}>
          {card ? (
            <ScreenRegion
              rect={[0.04, 0.523, 0.96, 0.613]}
              durationMs={300}
              lift={0.32}
              glassEdge={card === "glass" ? 0.05 : undefined}
            />
          ) : null}
        </Device>
      ))}
    </SceneStage>
  );
}
