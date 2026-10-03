import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type InstancedMesh,
  Matrix4,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import {
  goboSunDirection,
  inkRasterSync,
  inkRibbonMaterial,
  inkStrands,
  type LookMaterialSpec,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  createKiteScratch,
  KITE_SUN,
  KITES,
  type Kite,
  kiteLines,
  kiteList,
  poseKite,
  windVeer,
} from "./kites";
import {
  KITE_FRAGMENT,
  KITE_VERTEX,
  LAKE_FRAGMENT,
  LAMP_FRAGMENT,
  LAMP_VERTEX,
  LINE_FRAGMENT,
  LINE_PATH,
  LINE_VERTEX_HOOK,
} from "./shaders";

const LAKE_RADIUS = 90;
/** Every transparent part shares this stage-centred bound, so three's sort ties and mount order is draw order. */
const STAGE_BOUND = 200;

const fullKites = kiteList(kiteLines(KITES.maxLines, KITES.maxTrain, 1, 3));
/** Instance capacity per cell variant (square, triangular) and lamps at the densest sliders. */
export const KITE_CAPACITY = [0, 1].map((v) => fullKites.filter((k) => k.variant === v).length);
const LAMP_CAPACITY = fullKites.length;

/** A two-cell box kite in kite space: keel along +z (nose), span x, height y; variant 0 square cells, 1 triangular. `aCell` 0 front cell, 1 rear cell, 2 spar; `aPanel` is panel uv for the hems. */
export function kiteGeometry(variant: 0 | 1): BufferGeometry {
  const pos: number[] = [];
  const cell: number[] = [];
  const panel: number[] = [];
  const h = variant === 0 ? 0.78 : 0.86;
  const corners: [number, number][] =
    variant === 0
      ? [
          [-0.5, -h / 2],
          [0.5, -h / 2],
          [0.5, h / 2],
          [-0.5, h / 2],
        ]
      : [
          [-0.5, -h / 2],
          [0.5, -h / 2],
          [0, h / 2],
        ];
  const quad = (a: number[], b: number[], c: number[], d: number[], id: number) => {
    pos.push(...a, ...b, ...c, ...c, ...b, ...d);
    panel.push(0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1);
    for (let i = 0; i < 6; i++) cell.push(id);
  };
  const cells: [number, number][] = [
    [0.3, 0.76],
    [-0.76, -0.3],
  ];
  cells.forEach(([z0, z1], id) => {
    corners.forEach((p, k) => {
      const q = corners[(k + 1) % corners.length];
      quad([p[0], p[1], z0], [q[0], q[1], z0], [p[0], p[1], z1], [q[0], q[1], z1], id);
    });
  });
  const rod = 0.018;
  for (const [x, y] of corners) {
    quad([x - rod, y, -0.8], [x + rod, y, -0.8], [x - rod, y, 0.8], [x + rod, y, 0.8], 2);
    quad([x, y - rod, -0.8], [x, y + rod, -0.8], [x, y - rod, 0.8], [x, y + rod, 0.8], 2);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("aCell", new Float32BufferAttribute(cell, 1));
  g.setAttribute("aPanel", new Float32BufferAttribute(panel, 2));
  g.computeVertexNormals();
  g.setAttribute(
    "aSwap",
    new InstancedBufferAttribute(new Float32Array(KITE_CAPACITY[variant]), 1),
  );
  return g;
}

function lampGeometry(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.setAttribute("aLamp", new InstancedBufferAttribute(new Float32Array(LAMP_CAPACITY * 3), 3));
  g.instanceCount = 0;
  g.boundingSphere = new Sphere(new Vector3(), STAGE_BOUND);
  return g;
}

function lakeGeometry(): CircleGeometry {
  const g = new CircleGeometry(LAKE_RADIUS, 96);
  g.rotateX(-Math.PI / 2);
  g.translate(0, KITES.floorY, 0);
  return g;
}

const mirrorDefines = (mirror: boolean): Record<string, number> => (mirror ? { BK_MIRROR: 1 } : {});

/** 1 for a light backing (the kites print darker than the sky), 0 for a dark one, eased across the gap between the two preset bands so a colour drag never pops. */
export function kitesLightness(backingLuminance: number): number {
  const t = Math.min(1, Math.max(0, (backingLuminance - 0.125) / 0.175));
  return t * t * (3 - 2 * t);
}

/** Box kites: Hargrave cellular kites on long lines ringing the sky, trains of two and three, heads tracing figure eights, a sway wave running up each line and one shared wind veer, over a flooded salt lake that mirrors them faintly. Kites are posed on the CPU from the closed-form line maths; the F2 lines run the same maths in the vertex stage. Exact 120 s loop. */
export function BoxKites({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const squareRef = useRef<InstancedMesh>(null);
  const triRef = useRef<InstancedMesh>(null);
  const squareMirrorRef = useRef<InstancedMesh>(null);
  const triMirrorRef = useRef<InstancedMesh>(null);

  const geometry = useMemo(
    () => ({
      cells: [kiteGeometry(0), kiteGeometry(1)] as const,
      lamps: lampGeometry(),
      lake: lakeGeometry(),
    }),
    [],
  );
  useLayoutEffect(
    () => () => {
      for (const g of [...geometry.cells, geometry.lamps, geometry.lake]) g.dispose();
    },
    [geometry],
  );
  const ribbons = useInkRibbonGeometry(
    () => inkStrands(KITES.maxLines, KITES.segments + 1, (l, i) => [i / KITES.segments, l]),
    [],
  );
  useLayoutEffect(() => {
    ribbons.boundingSphere = new Sphere(new Vector3(), STAGE_BOUND);
  }, [ribbons]);

  const lines = useMemo(
    () => kiteLines(params.lines, params.train, params.height, params.size),
    [params.lines, params.train, params.height, params.size],
  );
  const kites = useMemo(() => kiteList(lines), [lines]);
  const byVariant = useMemo(
    () => [0, 1].map((v) => kites.filter((k) => k.variant === v)) as [Kite[], Kite[]],
    [kites],
  );

  const mats = useLookMaterials(() => {
    const shared = {
      uT: { value: 0 },
      uReflect: { value: 0.24 },
      uLight: { value: 0 },
      uBacking: lookColorUniform("#0b0c0e"),
      uLine: lookColorUniform("#2a2624"),
    };
    const sun = new Vector3(...goboSunDirection(KITE_SUN.azimuthDeg, KITE_SUN.elevationDeg));
    const kiteUniforms = {
      ...shared,
      uSail: lookColorUniform("#62563f"),
      uCellC: lookColorUniform("#3a4a52"),
      uSun: { value: sun },
    };
    const kite = (mirror: boolean): LookMaterialSpec => ({
      key: mirror ? "box-kites/kite-mirror" : "box-kites/kite",
      vertexShader: KITE_VERTEX,
      fragmentShader: KITE_FRAGMENT,
      defines: mirrorDefines(mirror),
      side: DoubleSide,
      transparent: mirror,
      depthWrite: !mirror,
      alphaToCoverage: !mirror,
      uniforms: kiteUniforms,
    });
    const lineUniforms = {
      ...shared,
      uHead: { value: Array.from({ length: KITES.maxLines }, () => new Vector3()) },
      uAnchor: { value: Array.from({ length: KITES.maxLines }, () => new Vector3()) },
      uWave: { value: Array.from({ length: KITES.maxLines }, () => new Vector4()) },
      uShape: { value: Array.from({ length: KITES.maxLines }, () => new Vector4()) },
      uPsi: { value: 0 },
      uFigure: { value: 1 },
    };
    const line = (mirror: boolean) =>
      inkRibbonMaterial({
        key: mirror ? "box-kites/line-mirror" : "box-kites/line",
        path: LINE_PATH,
        vertex: LINE_VERTEX_HOOK,
        fragmentShader: LINE_FRAGMENT,
        defines: mirrorDefines(mirror),
        uniforms: lineUniforms,
        lineWidth: { world: 0.045, min: 1.2 },
      });
    const lampUniforms = {
      ...shared,
      uLamp: lookColorUniform("#b8864a"),
      uDark: { value: 1 },
      uInkRaster: { value: new Vector2() },
    };
    const lamp = (mirror: boolean): LookMaterialSpec => ({
      key: mirror ? "box-kites/lamp-mirror" : "box-kites/lamp",
      vertexShader: LAMP_VERTEX,
      fragmentShader: LAMP_FRAGMENT,
      defines: mirrorDefines(mirror),
      transparent: true,
      depthWrite: false,
      uniforms: lampUniforms,
    });
    return {
      lake: {
        key: "box-kites/lake",
        fragmentShader: LAKE_FRAGMENT,
        depthWrite: false,
        uniforms: { uLake: lookColorUniform("#1a1817"), uBacking: shared.uBacking },
      },
      kite: kite(false),
      kiteMirror: kite(true),
      line: line(false),
      lineMirror: line(true),
      lamp: lamp(false),
      lampMirror: lamp(true),
    };
  }, []);

  useLayoutEffect(() => {
    const k = mats.kite.uniforms;
    k.uSail.value.set(colors[0]);
    k.uCellC.value.set(colors[1]);
    k.uLine.value.set(colors[2]);
    k.uBacking.value.set(backing);
    mats.lamp.uniforms.uLamp.value.set(colors[3]);
    const back = k.uBacking.value as Color;
    const light = kitesLightness(lookLuminance(backing));
    k.uLight.value = light;
    mats.lamp.uniforms.uDark.value = 1 - light;
    const wet = new Color(colors[2]).lerp(back, 0.35);
    const dry = new Color(colors[0]).lerp(back, 0.55);
    mats.lake.uniforms.uLake.value.copy(wet.lerp(dry, light));
  }, [mats, colors[0], colors[1], colors[2], colors[3], backing]);

  useLayoutEffect(() => {
    const u = mats.line.uniforms;
    lines.forEach((l, i) => {
      u.uHead.value[i].set(...l.head);
      u.uAnchor.value[i].set(...l.anchor);
      u.uShape.value[i].set(l.span, l.step, l.zig, 1 - l.step * (l.count - 1));
      u.uWave.value[i].set(...l.wave);
    });
    showInkStrands(ribbons, lines.length);
    byVariant.forEach((list, v) => {
      const swap = geometry.cells[v].getAttribute("aSwap") as InstancedBufferAttribute;
      for (let i = 0; i < list.length; i++) swap.setX(i, list[i].swap);
      swap.needsUpdate = true;
    });
    geometry.lamps.instanceCount = kites.length;
  }, [mats, lines, kites, byVariant, ribbons, geometry]);

  const scratch = useMemo(
    () => ({
      kite: createKiteScratch(),
      matrix: new Matrix4(),
      lamp: [0, 0, 0] as [number, number, number],
      slots: [0, 0],
    }),
    [],
  );
  const meshes = useMemo(
    () => [
      [squareRef, squareMirrorRef],
      [triRef, triMirrorRef],
    ],
    [],
  );
  useLayoutEffect(() => {
    const tl = loopSeconds(t, KITES.period);
    const u = mats.line.uniforms;
    u.uT.value = tl;
    u.uPsi.value = windVeer(tl, params.veer);
    u.uFigure.value = params.figure;
    u.uReflect.value = params.reflect;
    const lampAttr = geometry.lamps.getAttribute("aLamp") as InstancedBufferAttribute;
    const { slots, matrix, lamp } = scratch;
    slots[0] = 0;
    slots[1] = 0;
    for (let i = 0; i < kites.length; i++) {
      const k = kites[i];
      poseKite(
        lines[k.line],
        k,
        tl,
        params.veer,
        params.figure,
        scratch.kite,
        matrix.elements,
        lamp,
      );
      const slot = slots[k.variant]++;
      for (const ref of meshes[k.variant]) ref.current?.setMatrixAt(slot, matrix);
      lampAttr.setXYZ(i, lamp[0], lamp[1], lamp[2]);
    }
    lampAttr.needsUpdate = true;
    for (let v = 0; v < 2; v++) {
      for (const ref of meshes[v]) {
        const mesh = ref.current;
        if (!mesh) continue;
        mesh.count = slots[v];
        mesh.instanceMatrix.needsUpdate = true;
        mesh.boundingSphere ??= new Sphere(new Vector3(), STAGE_BOUND);
      }
    }
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={geometry.lake} material={mats.lake} />
      <instancedMesh
        ref={squareRef}
        args={[undefined, undefined, KITE_CAPACITY[0]]}
        geometry={geometry.cells[0]}
        material={mats.kite}
        frustumCulled={false}
      />
      <instancedMesh
        ref={triRef}
        args={[undefined, undefined, KITE_CAPACITY[1]]}
        geometry={geometry.cells[1]}
        material={mats.kite}
        frustumCulled={false}
      />
      <instancedMesh
        ref={squareMirrorRef}
        args={[undefined, undefined, KITE_CAPACITY[0]]}
        geometry={geometry.cells[0]}
        material={mats.kiteMirror}
        frustumCulled={false}
      />
      <instancedMesh
        ref={triMirrorRef}
        args={[undefined, undefined, KITE_CAPACITY[1]]}
        geometry={geometry.cells[1]}
        material={mats.kiteMirror}
        frustumCulled={false}
      />
      <mesh
        geometry={ribbons}
        material={mats.lineMirror}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh
        geometry={geometry.lamps}
        material={mats.lampMirror}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh
        geometry={ribbons}
        material={mats.line}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh
        geometry={geometry.lamps}
        material={mats.lamp}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
