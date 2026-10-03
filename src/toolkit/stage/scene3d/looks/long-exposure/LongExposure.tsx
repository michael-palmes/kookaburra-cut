import { useLayoutEffect, useMemo } from "react";
import {
  CircleGeometry,
  type IUniform,
  PlaneGeometry,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import {
  inkRasterSync,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  coastGeometry,
  headlandUniformValues,
  lampBeamAngle,
  lampPosition,
  SEA,
  SEA_RADIUS,
} from "./coast";
import {
  COAST_FRAGMENT,
  COAST_VERTEX,
  LAMP_FRAGMENT,
  LAMP_VERTEX,
  SEA_FRAGMENT,
  SEA_LOOK,
  SKY_FRAGMENT,
} from "./shaders";
import { LONG_EXPOSURE, namedStarPolar, poleBasis, skyTurn } from "./sky";

const DEG = Math.PI / 180;
/** Seconds for a swell crest to roll one spacing toward the coast. */
const SWELL_PERIOD = 4;
/** Mist drift along x, world units a second, and the mist's x frequency. */
const MIST = { speed: 0.6, freq: 0.055 } as const;

function seaGeometry(): CircleGeometry {
  const g = new CircleGeometry(SEA_RADIUS, SEA.segments);
  g.rotateX(-Math.PI / 2);
  g.translate(0, SEA.y, 0);
  g.boundingSphere = new Sphere(new Vector3(), SEA.domeRadius);
  return g;
}

/** Long exposure: southern circumpolar star trails at infinity on one sky dome (F7), turning clockwise round an off-stage pole once every 3 minutes, the Southern Cross and the Pointers as bright trails with head beads, over a still sea that mirrors them from the real camera, low headlands at 25 to 60 units and a lighthouse whose beam sweeps every 8 s. The water's mist and swell are world space, so a camera move glides over the sea toward the coast. Every trail is closed form in the turn angle: no persistence buffer. */
export function LongExposure({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const coast = Math.round(params.coast);
  const dome = useSkyDomeGeometry(LONG_EXPOSURE.radius);
  const sea = useMemo(seaGeometry, []);
  const land = useMemo(() => coastGeometry(coast), [coast]);
  const quad = useMemo(() => new PlaneGeometry(2, 2), []);
  useLayoutEffect(() => () => sea.dispose(), [sea]);
  useLayoutEffect(() => () => land.dispose(), [land]);
  useLayoutEffect(() => () => quad.dispose(), [quad]);

  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uTrail: lookColorUniform("#535d76"),
      uBright: lookColorUniform("#8893a9"),
      uHorizon: lookColorUniform("#3a302a"),
      uBacking: lookColorUniform("#0c101a"),
      uPole: { value: new Vector3(0, 1, 0) },
      uU: { value: new Vector3(1, 0, 0) },
      uV: { value: new Vector3(0, 0, 1) },
      uTurn: { value: 0 },
      uLen: { value: 38 * DEG },
      uDensity: { value: 0.45 },
      uHorizonAmt: { value: 0.6 },
      uLight: { value: 0 },
      uMist: { value: 0.5 },
      uStars: { value: namedStarPolar().map(([r, p, w]) => new Vector3(r, p, w)) },
      uInkRaster: { value: new Vector2() },
      uHead: { value: Array.from({ length: SEA.maxHeadlands }, () => new Vector4()) },
      uHeadShape: { value: Array.from({ length: SEA.maxHeadlands }, () => new Vector4()) },
      uCoastReach: { value: new Vector2(25, 4) },
      uLamp: { value: new Vector3(0, SEA.y, -30) },
      uBeam: { value: new Vector2(0, -1) },
      uLampAmt: { value: 0.8 },
      uSwell: { value: 0.5 },
      uSwellPhase: { value: 0 },
      uMistDrift: { value: new Vector2() },
    };
    // Sea and coast first: three sorts opaque draws by material id, so the dome is depth culled behind them.
    return {
      sea: { key: "long-exposure/sea", fragmentShader: SEA_FRAGMENT, uniforms: shared },
      coast: {
        key: "long-exposure/coast",
        vertexShader: COAST_VERTEX,
        fragmentShader: COAST_FRAGMENT,
        alphaToCoverage: true,
        uniforms: shared,
      },
      sky: skyDomeMaterial({
        key: "long-exposure/sky",
        fragmentShader: SKY_FRAGMENT,
        uniforms: shared,
      }),
      lamp: {
        key: "long-exposure/lamp",
        vertexShader: LAMP_VERTEX,
        fragmentShader: LAMP_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: shared,
      },
    };
  }, []);

  const basis = useMemo(
    () => poleBasis(params.poleAzimuth, params.poleHeight),
    [params.poleAzimuth, params.poleHeight],
  );
  const heads = useMemo(
    () => headlandUniformValues(coast, params.headlands),
    [coast, params.headlands],
  );
  const lamp = useMemo(() => lampPosition(coast, params.headlands), [coast, params.headlands]);

  useLayoutEffect(() => {
    const u = mats.sky.uniforms;
    u.uTrail.value.set(colors[0]);
    u.uBright.value.set(colors[1]);
    u.uHorizon.value.set(colors[2]);
    u.uBacking.value.set(backing);
    u.uLight.value = lookLuminance(backing) > 0.3 ? 1 : 0;
    u.uPole.value.set(...basis.pole);
    u.uU.value.set(...basis.u);
    u.uV.value.set(...basis.v);
  }, [mats, colors[0], colors[1], colors[2], backing, basis]);

  useLayoutEffect(() => {
    const u = mats.sky.uniforms;
    const head = u.uHead.value as Vector4[];
    const shape = u.uHeadShape.value as Vector4[];
    for (let i = 0; i < SEA.maxHeadlands; i++) {
      head[i].fromArray(heads.head, i * 4);
      shape[i].fromArray(heads.shape, i * 4);
    }
    u.uCoastReach.value.set(...heads.reach);
    u.uLamp.value.set(...lamp);
  }, [mats, heads, lamp]);

  const showCoast = params.headlands > 0;
  const showLamp = showCoast && params.lamp > 0;
  useLayoutEffect(() => {
    const u = mats.sky.uniforms;
    u.uTurn.value = skyTurn(t, params.turn, params.skyHour);
    u.uLen.value = params.trailLength * DEG;
    u.uDensity.value = params.density;
    u.uHorizonAmt.value = params.horizon;
    u.uMist.value = params.mist;
    u.uSwell.value = params.swell;
    u.uLampAmt.value = showLamp ? params.lamp : 0;
    u.uSwellPhase.value = loopSeconds(t, SWELL_PERIOD * SEA_LOOK.swellLoop) / SWELL_PERIOD;
    u.uMistDrift.value.set(-t * MIST.speed * MIST.freq, 0);
    const beam = lampBeamAngle(t);
    u.uBeam.value.set(Math.sin(beam), -Math.cos(beam));
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh
        geometry={dome}
        material={mats.sky}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh
        geometry={sea}
        material={mats.sea}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh geometry={land} material={mats.coast} frustumCulled={false} visible={showCoast} />
      <mesh
        geometry={quad}
        material={mats.lamp}
        frustumCulled={false}
        visible={showLamp}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
