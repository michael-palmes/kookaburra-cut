import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BackSide,
  type InstancedMesh,
  PlaneGeometry,
  SphereGeometry,
  Vector2,
  Vector3,
} from "three";
import { useFormat } from "../../../../../engine/format";
import {
  createInstanceScratch,
  type InstancePose,
  lookColorUniform,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
  writeInstanceColors,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { GROUT_FRAGMENT, TILE_FRAGMENT, TILE_VERTEX } from "./shaders";
import {
  TESSERA,
  TESSERA_CAPACITY,
  TESSERA_LIGHT_WEIGHTS,
  type TesseraTile,
  tesseraLights,
  tesseraShape,
  tesseraSpring,
  tesseraTiles,
} from "./tessera";

const tilePose = (p: TesseraTile, _i: number, out: InstancePose) => {
  out.position.set(p.x, p.y, p.z);
  out.rotation.set(p.rx, p.ry, p.rz);
  out.scale.set(p.sx, p.sy, 1);
};

/** Tessera dome: a Byzantine gold mosaic of slightly tilted instanced tiles (F12, static anchors) on a saucer dome over the stage, with broad glint bands travelling round it from three drum-window lights. Tone and kind ride in the instance colour. */
export function TesseraDome({ colors, params, speed, backing }: Scene3dLookProps) {
  const tilesRef = useRef<InstancedMesh>(null);
  const t = useLookTime(speed);
  const { aspect } = useFormat();
  const quad = useMemo(() => new PlaneGeometry(1, 1), []);
  useLayoutEffect(() => () => quad.dispose(), [quad]);

  const { rimRadius, rise, tileSize, tilt } = params;
  const tiles = useMemo(
    () => tesseraTiles({ rimRadius, rise, tileSize, tilt }),
    [rimRadius, rise, tileSize, tilt],
  );
  const shape = useMemo(() => tesseraShape(rimRadius, rise), [rimRadius, rise]);
  const groutOffset = 0.05 + 0.2 * tileSize;
  const grout = useMemo(
    () => new SphereGeometry(shape.radius + groutOffset, 160, 48, 0, Math.PI * 2, 0, shape.phiMax),
    [shape, groutOffset],
  );
  useLayoutEffect(() => () => grout.dispose(), [grout]);

  const meshes = useMemo(() => [tilesRef], []);
  useStaticInstancedLayout(meshes, tiles, tilePose);
  const scratch = useMemo(createInstanceScratch, []);
  const coloured = useMemo(() => new WeakMap<InstancedMesh, readonly TesseraTile[]>(), []);
  useLayoutEffect(() => {
    const mesh = tilesRef.current;
    if (!mesh || coloured.get(mesh) === tiles) return;
    writeInstanceColors(mesh, tiles, (p, _i, out) => out.setRGB(p.tone, p.kind / 2, 0), scratch);
    coloured.set(mesh, tiles);
  });

  const mats = useLookMaterials(() => {
    const shared = {
      uGold: lookColorUniform("#000000"),
      uGrout: lookColorUniform("#000000"),
      uBacking: lookColorUniform("#000000"),
      uSpring: { value: new Vector2(4.3, 3.7) },
    };
    return {
      tiles: {
        key: "tessera-dome/tiles",
        vertexShader: TILE_VERTEX,
        fragmentShader: TILE_FRAGMENT,
        uniforms: {
          ...shared,
          uGlint: lookColorUniform("#000000"),
          uLights: { value: TESSERA_LIGHT_WEIGHTS.map(() => new Vector3(0, -1, 0)) },
          uGlintAmount: { value: 0.8 },
          uCentreY: { value: -9.5 },
        },
      },
      grout: {
        key: "tessera-dome/grout",
        fragmentShader: GROUT_FRAGMENT,
        side: BackSide,
        uniforms: { ...shared, uGap: { value: 0.12 } },
      },
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.tiles.uniforms;
    u.uGold.value.set(colors[0]);
    u.uGrout.value.set(colors[1]);
    u.uGlint.value.set(colors[2]);
    u.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const u = mats.tiles.uniforms;
    tesseraLights(t, params.glintPeriod, u.uLights.value);
    u.uGlintAmount.value = params.glint;
    u.uCentreY.value = shape.centreY;
    u.uSpring.value.set(...tesseraSpring(params.rimFade, aspect));
    mats.grout.uniforms.uGap.value = TESSERA.gap * tileSize;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <instancedMesh
        ref={tilesRef}
        args={[undefined, undefined, TESSERA_CAPACITY]}
        geometry={quad}
        material={mats.tiles}
        frustumCulled={false}
      />
      <mesh geometry={grout} material={mats.grout} position-y={shape.centreY} />
    </group>
  );
}
