import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from "react";
import {
  CircleGeometry,
  DoubleSide,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
} from "three";
import {
  ROOM_DEFAULT_ORIGIN,
  ROOM_FLOOD_SEGMENTS,
  type RoomSample,
  type RoomTrack,
  roomFloodCircle,
  sampleRoom,
} from "../../engine/sceneRoom";
import { useTimeline } from "../../engine/timeline";
import { configureFixed, FixedQuad } from "./FixedBackdrop";
import { FIXED_BG_DISTANCE } from "./fixedMath";

/** Rooms are camera-locked colour, drawn after the fixed background (-100) and 3D looks (-50) and before all content; the flood circle draws one above the room quad. Export contract. */
export const ROOM_RENDER_ORDER = -40;

const RoomTrackContext = createContext<RoomTrack | null>(null);

/** Provides one scene's normalised room track to `useRoom` and the host `SceneRoom`. */
export function SceneRoomScope({
  track,
  children,
}: {
  track: RoomTrack | null;
  children: ReactNode;
}) {
  return <RoomTrackContext.Provider value={track}>{children}</RoomTrackContext.Provider>;
}

/** The scene's room at the frame instant (its colour, any flood in progress and the room's lighting pose), or null when the scene has no sidecar `room`. */
export function useRoom(): RoomSample | null {
  const track = useContext(RoomTrackContext);
  const { localMs } = useTimeline(0);
  return useMemo(() => (track ? sampleRoom(track, localMs) : null), [track, localMs]);
}

/** One unlit, exact-colour material (the fixed colour background's program), created once so a colour change never compiles anything. */
function useRoomMaterial(colour: string): MeshBasicMaterial {
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ side: DoubleSide });
    m.toneMapped = false;
    configureFixed(m);
    return m;
  }, []);
  useLayoutEffect(() => () => material.dispose(), [material]);
  useLayoutEffect(() => {
    material.color.set(colour);
  }, [material, colour]);
  return material;
}

export interface RoomFloodProps {
  /** The incoming room colour (hex, e.g. a theme token). */
  colour: string;
  /** Where the flood starts, in frame fractions: [0, 0] top-left to [1, 1] bottom-right; default the centre. */
  origin?: readonly [number, number];
  /** 0..1 of the radius that covers the whole frame; ease it yourself (e.g. `ramp`). */
  radius: number;
}

/** A camera-locked circle of colour growing from a point in the frame (a 256-gon over the room, under all content). For scenes composing their own flood; the sidecar `room` block draws its own. */
export function RoomFlood({ colour, origin = ROOM_DEFAULT_ORIGIN, radius }: RoomFloodProps) {
  const material = useRoomMaterial(colour);
  const geometry = useMemo(() => new CircleGeometry(1, ROOM_FLOOD_SEGMENTS), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const meshRef = useRef<Mesh>(null);
  const [ox, oy] = origin;
  const onBeforeRender = useMemo(() => {
    const translate = new Matrix4();
    const scale = new Matrix4();
    return (_renderer: unknown, _scene: unknown, camera: unknown) => {
      const mesh = meshRef.current;
      const cam = camera as PerspectiveCamera;
      if (!mesh || !cam.isPerspectiveCamera) return;
      const c = roomFloodCircle(cam.fov, cam.aspect, FIXED_BG_DISTANCE, [ox, oy], radius);
      translate.makeTranslation(c.x, c.y, -FIXED_BG_DISTANCE);
      scale.makeScale(c.r, c.r, 1);
      mesh.matrixWorld.copy(cam.matrixWorld).multiply(translate).multiply(scale);
    };
  }, [ox, oy, radius]);
  return (
    <mesh
      ref={meshRef}
      visible={radius > 0}
      geometry={geometry}
      material={material}
      renderOrder={ROOM_RENDER_ORDER + 1}
      frustumCulled={false}
      matrixAutoUpdate={false}
      onBeforeRender={onBeforeRender}
    />
  );
}

export interface RoomProps {
  /** The room colour filling the frame behind all content (hex); null shows the scene's own background. */
  colour: string | null;
  /** A flood growing over the room. */
  flood?: RoomFloodProps | null;
}

/** A camera-locked room: a frame-filling colour behind all content plus an optional flood. Both meshes stay mounted, so a room changing never mounts or compiles anything mid-run. */
export function Room({ colour, flood }: RoomProps) {
  const material = useRoomMaterial(colour ?? "#000000");
  return (
    <>
      <group visible={colour !== null}>
        <FixedQuad material={material} renderOrder={ROOM_RENDER_ORDER} />
      </group>
      <RoomFlood
        colour={flood?.colour ?? colour ?? "#000000"}
        origin={flood?.origin}
        radius={flood?.radius ?? 0}
      />
    </>
  );
}

function SceneRoomTrack() {
  const sample = useRoom();
  if (!sample) return null;
  return <Room colour={sample.colour} flood={sample.flood} />;
}

/** The host mount beside `SceneBackground`: draws the sidecar `room` track, and nothing (no mesh, no clock subscription) for a scene without one. */
export function SceneRoom() {
  const track = useContext(RoomTrackContext);
  return track ? <SceneRoomTrack /> : null;
}
