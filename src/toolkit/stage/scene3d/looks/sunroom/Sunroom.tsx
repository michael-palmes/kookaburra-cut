import { useLayoutEffect, useMemo } from "react";
import { type IUniform, PlaneGeometry, Vector2, Vector3 } from "three";
import { useFormat } from "../../../../../engine/format";
import { lookColorUniform, lookLuminance, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  SUNROOM_DAY_S,
  SUNROOM_FLOOR_Y,
  SUNROOM_FRONT_Z,
  SUNROOM_WALL_HEIGHT,
  type SunroomSunPath,
  sunroomRoom,
  sunroomWindow,
  writeSunroomSun,
} from "./room";
import { FLOOR_FRAGMENT, SUNROOM_BOUNCE, WALL_FRAGMENT } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
/** The floor runs out this far from the stage axis, past the fade into the backing. */
const FLOOR_REACH = 42;
const DARK_LUMINANCE = 0.2;

/** Sunroom: a warm plaster room round the stage, a low side sun falling through a venetian blind as slatted light across the back wall and on over the floor, drifting as the sun swings. Unlit, every stripe an analytic trace to the blind (F6), so colours stay exact and fill rate stays low. */
export function Sunroom({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const { aspect } = useFormat();
  const room = useMemo(() => sunroomRoom(params.wallDistance), [params.wallDistance]);
  const geometry = useMemo(() => {
    const depth = room.wallZ + SUNROOM_FRONT_Z;
    const wallY = SUNROOM_FLOOR_Y + SUNROOM_WALL_HEIGHT / 2;
    const back = new PlaneGeometry(2 * room.sideX, SUNROOM_WALL_HEIGHT).translate(
      0,
      wallY,
      -room.wallZ,
    );
    const left = new PlaneGeometry(depth, SUNROOM_WALL_HEIGHT)
      .rotateY(Math.PI / 2)
      .translate(-room.sideX, wallY, (SUNROOM_FRONT_Z - room.wallZ) / 2);
    const right = new PlaneGeometry(depth, SUNROOM_WALL_HEIGHT)
      .rotateY(-Math.PI / 2)
      .translate(room.sideX, wallY, (SUNROOM_FRONT_Z - room.wallZ) / 2);
    const floor = new PlaneGeometry(2 * FLOOR_REACH, room.wallZ + FLOOR_REACH)
      .rotateX(-Math.PI / 2)
      .translate(0, SUNROOM_FLOOR_Y, (FLOOR_REACH - room.wallZ) / 2);
    return { back, left, right, floor };
  }, [room]);
  useLayoutEffect(
    () => () => {
      for (const g of Object.values(geometry)) g.dispose();
    },
    [geometry],
  );

  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uPlaster: lookColorUniform("#2b221c"),
      uSunlight: lookColorUniform("#795b3e"),
      uFloorTone: lookColorUniform("#1f1914"),
      uBacking: lookColorUniform("#130f0c"),
      uSun: { value: new Vector3(0, 1, 0) },
      uWinCentre: { value: new Vector3() },
      uWinU: { value: new Vector3(1, 0, 0) },
      uWinN: { value: new Vector3(0, 0, 1) },
      uWinHalf: { value: new Vector2(1, 1) },
      uPanes: { value: 3 },
      uPitch: { value: 0.55 },
      uOpening: { value: 0.6 },
      uSoftness: { value: 1 },
      uBounce: { value: 1 },
      uRoom: { value: new Vector2(9, 13) },
    };
    return {
      wall: { key: "sunroom/wall", fragmentShader: WALL_FRAGMENT, uniforms: shared },
      floor: { key: "sunroom/floor", fragmentShader: FLOOR_FRAGMENT, uniforms: shared },
    };
  }, []);
  const u = mats.wall.uniforms;

  const [plaster, sunlight, floor] = colors;
  useLayoutEffect(() => {
    u.uPlaster.value.set(plaster);
    u.uSunlight.value.set(sunlight);
    u.uFloorTone.value.set(floor);
    u.uBacking.value.set(backing);
    u.uBounce.value = lookLuminance(plaster) < DARK_LUMINANCE ? SUNROOM_BOUNCE.dark : 1;
  }, [u, plaster, sunlight, floor, backing]);

  const win = useMemo(
    () =>
      sunroomWindow({
        sunAzimuthDeg: params.sunSide,
        sunElevationDeg: params.sunHeight,
        wallDistance: params.wallDistance,
        patch: params.patch,
        aspect,
      }),
    [params.sunSide, params.sunHeight, params.wallDistance, params.patch, aspect],
  );
  useLayoutEffect(() => {
    u.uWinCentre.value.set(...win.centre);
    u.uWinU.value.set(...win.u);
    u.uWinN.value.set(...win.normal);
    u.uWinHalf.value.set(win.halfWidth, win.halfHeight);
    u.uRoom.value.set(room.wallZ, room.sideX);
  }, [u, win, room]);

  const sun = useMemo<SunroomSunPath>(
    () => ({
      azimuthDeg: params.sunSide,
      elevationDeg: params.sunHeight,
      driftDeg: params.drift,
      periodS: SUNROOM_DAY_S,
    }),
    [params.sunSide, params.sunHeight, params.drift],
  );
  useLayoutEffect(() => {
    writeSunroomSun(u.uSun.value, sun, t);
    u.uPanes.value = Math.round(params.panes);
    u.uPitch.value = params.slatPitch;
    u.uOpening.value = params.opening;
    u.uSoftness.value = params.softness;
  }, [u, sun, t, params.panes, params.slatPitch, params.opening, params.softness]);

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={geometry.floor} material={mats.floor} />
      <mesh geometry={geometry.back} material={mats.wall} />
      <mesh geometry={geometry.left} material={mats.wall} />
      <mesh geometry={geometry.right} material={mats.wall} />
    </group>
  );
}
