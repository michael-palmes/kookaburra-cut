import { baseCameraPose, type CameraPose } from "../engine/cameraTrack";
import type { ProjectMusic } from "../engine/musicTime";
import { collectParseWarnings } from "../engine/parseWarnings";
import { buildSceneCameraTracks, sceneCameraPose } from "../engine/sceneCamera";
import { deviceTrackPoseAt, resolveDeviceTrack } from "../engine/sceneDeviceTrack";
import { parseSceneDoc, type SceneDoc } from "../engine/sceneDocSchema";

type Raw = Record<string, unknown>;
type V3 = [number, number, number];

/** Conformance vectors for kb's camera mirror (`scripts/kblib/camera/sample.py`): raw sidecars run through `parseSceneDoc`, `buildSceneCameraTracks` and `sceneCameraPose` (kicks included, no floor or frame known), and the device track's offsets and rotations through `deviceTrackPoseAt`. kb must land on the same poses to within float noise. */

export interface CameraPoseExpect {
  position: V3;
  lookAt: V3;
  fov: number;
  rollDeg: number;
  dof: {
    mode: string;
    blur: number;
    focus: number;
    range: number;
    focusB: number;
    fStop: number;
    focalMm: number | null;
    sensorMm: number;
  } | null;
}

export interface CameraVector {
  id: string;
  music: ProjectMusic;
  sceneStartMs: number[];
  docs: Raw[];
  poses: { scene: number; tMs: number; expect: CameraPoseExpect }[];
  devices: { scene: number; id: string; tMs: number; expect: { offset: V3; rotationDeg: V3 } }[];
}

export interface CameraVectors {
  version: 1;
  cases: CameraVector[];
}

const MUSIC: ProjectMusic = {
  grid: { bpm: 128, offsetMs: -17.358, beatsPerBar: 4 },
  startOffsetMs: 0,
  cues: { "full-stop": "bar:8.4", hit: 2000 },
  sections: {},
};
const NO_MUSIC: ProjectMusic = { startOffsetMs: 0, cues: {}, sections: {} };

const point = (at: V3) => ({ mode: "point", at });
const key = (id: string, tMs: number, position: V3, aim: unknown, extra: Raw = {}) => ({
  id,
  tMs,
  pose: { position, aim, ...extra },
});
const orbitKey = (id: string, tMs: number, pose: Raw) => ({ id, tMs, pose });
const rig = (keys: unknown[], segments: unknown[], extra: Raw = {}): Raw => ({
  version: 1,
  cameraMode: "rig",
  cameraRig: { keys, segments },
  ...extra,
});
const phone = (id: string, placement: Raw) => ({ id, model: "iphone-15-pro", placement });

const EASES = [
  "linear",
  "jump",
  "inSine",
  "outQuad",
  "inOutCubic",
  "outQuart",
  "inOutQuint",
  "inExpo",
  "outCirc",
  "inOutBack",
  "outBack",
  "bogus",
];

const RAW_CASES: {
  id: string;
  music?: ProjectMusic;
  sceneStartMs?: number[];
  times?: number[];
  docs: Raw[];
}[] = [
  ...EASES.map((ease) => ({
    id: `rig-ease-${ease}`,
    times: [0, 137.5, 500, 863, 999, 1000],
    docs: [
      rig(
        [
          key("a", 0, [0, 0, 6], point([0, 0, 0]), { fov: 30 }),
          key("b", 1000, [1, 0.5, 4], point([0.2, 0, 0]), { fov: 24, rollDeg: 3 }),
        ],
        [{ from: "a", to: "b", ease }],
      ),
    ],
  })),
  {
    id: "rig-spline-neighbours",
    docs: [
      rig(
        [
          key("a", 0, [0, 0, 6], point([0, 0, 0])),
          key("b", 800, [1, 0.2, 5], point([0, 0, 0])),
          key("c", 1600, [3, 0.4, 2], point([0, 0, 0])),
          key("d", 2400, [4, -0.3, 0.5], point([0, 0, 0])),
        ],
        [
          { from: "a", to: "b", ease: "linear" },
          { from: "b", to: "c", ease: "inOutSine" },
          { from: "c", to: "d", ease: "outCubic", smooth: false },
        ],
      ),
    ],
  },
  {
    id: "rig-jump-cuts",
    docs: [
      rig(
        [
          key("g1a", 0, [-0.1355, 0.4881, 2.3371], point([0.0282, 0.3651, -0.004]), { fov: 28 }),
          key("g1b", 1874, [-0.0617, 0.4776, 2.1412], point([0.0282, 0.3651, -0.004]), { fov: 28 }),
          key("g2a", 1875, [25.1414, 0.5007, 1.9211], point([24.9718, 0.3647, -0.0167]), {
            fov: 28,
          }),
          key("g2b", 3749, [25.0648, 0.4889, 1.7565], point([24.9718, 0.3647, -0.0167]), {
            fov: 28,
          }),
        ],
        [
          { from: "g1a", to: "g1b", ease: "linear" },
          { from: "g1b", to: "g2a", ease: "jump" },
          { from: "g2a", to: "g2b", ease: "linear" },
        ],
      ),
    ],
  },
  {
    id: "rig-channel-eases-and-held-keys",
    docs: [
      rig(
        [
          key("a", 0, [0, 1, 7], point([0, 0, 0]), { fov: 40 }),
          key("b", 1200, [2, 0, 4], point([1, 0.5, 0])),
          key("c", 2000, [2, 0, 4], point([1, 0.5, 0]), { rollDeg: -6 }),
          key("d", 3000, [-1, 0.5, 3], point([0, 0, 0]), { fov: 20 }),
        ],
        [
          {
            from: "a",
            to: "b",
            ease: "inOutQuad",
            easePosition: "linear",
            easeRotation: "outExpo",
            easeLens: "inCubic",
          },
          { from: "c", to: "d", ease: "inOutSine", easeLens: "nope" },
        ],
      ),
    ],
  },
  {
    id: "rig-tangent-aims",
    docs: [
      rig(
        [
          key("a", 0, [-0.9, 0.9, 7.6], { mode: "tangent", at: [-0.45, 0.6, 6.4] }, { fov: 52 }),
          key("b", 700, [-0.45, 0.6, 6.4], { mode: "tangent", at: [-0.1, 0.35, 5.2] }),
          key(
            "c",
            1400,
            [-0.1, 0.35, 5.2],
            { mode: "tangent", at: [0.1, 0.2, 4.5] },
            {
              rollDeg: -4,
            },
          ),
          key("d", 2000, [0.1, 0.2, 4.5], point([0, -0.1, 0]), { fov: 38 }),
          key("e", 2600, [0.1, 0.2, 4.5], { mode: "tangent", at: [0, 0, 0] }),
        ],
        [
          { from: "a", to: "b", ease: "inOutSine" },
          { from: "b", to: "c", ease: "linear" },
          { from: "c", to: "d", ease: "inOutQuad", easeLens: "inCubic" },
          { from: "d", to: "e", ease: "linear", smooth: false },
        ],
      ),
    ],
  },
  {
    id: "rig-object-aims",
    docs: [
      rig(
        [
          key("a", 0, [0, 0, 6], { mode: "object", id: "loose", at: [9, 9, 9] }),
          key("b", 600, [1, 0, 5], { mode: "object", id: "grounded", at: [-1, 0.2, 0] }),
          key("c", 1200, [2, 0, 4], { mode: "object", id: "card", at: [5, 5, 5] }),
          key("d", 1800, [2, 1, 4], { mode: "object", id: "missing", at: [0, 1, 0] }),
        ],
        [
          { from: "a", to: "b", ease: "linear" },
          { from: "b", to: "c", ease: "outSine" },
          { from: "c", to: "d", ease: "inSine" },
        ],
        {
          devices: [
            phone("loose", { position: [0.5, -0.2, 0], rotationDeg: [0, 14, -3] }),
            phone("grounded", { position: [-2, 0.1, 0], ground: true }),
          ],
          media: [
            {
              id: "card",
              kind: "image",
              src: "assets/card.png",
              host: "stage",
              stage: { position: [0.4, 0.6, 0.2] },
            },
          ],
        },
      ),
    ],
  },
  {
    id: "rig-dof-carry",
    docs: [
      rig(
        [
          key("k1", 0, [0, -0.985, 11.488], point([0, 0, 0]), {
            fov: 21,
            dof: { mode: "depth", blur: 1, focus: 10.42, range: 0.3 },
          }),
          key("k2", 1875, [0.07, -0.97, 11.3], point([0, 0, 0])),
          key("k3", 3750, [0.15, -0.95, 11.1], point([0, 0, 0]), { dof: { focus: 12 } }),
          key("k4", 5000, [0.15, -0.95, 10], point([0, 0, 0]), { dof: { focus: "auto" } }),
        ],
        [
          { from: "k1", to: "k2", ease: "linear" },
          { from: "k2", to: "k3", ease: "linear", easeDof: "inOutSine" },
          { from: "k3", to: "k4", ease: "outQuad" },
        ],
      ),
    ],
  },
  {
    id: "rig-lens-dof",
    docs: [
      rig(
        [
          key("k1", 0, [0.0991, 0.5231, 2.7554], point([-2.6045, -0.3709, -0.4666]), {
            fov: 18,
            dof: { mode: "lens", fStop: 22, focus: 4.2222 },
          }),
          key("k2", 2812, [-0.1037, 0.4561, 2.5138], point([-2.6045, -0.3709, -0.4666]), {
            dof: { fStop: 27, focus: 3.3389, focalMm: 80 },
          }),
          key("k3", 3750, [-0.1713, 0.4337, 2.4332], point([-2.0549, -0.1892, 0.1884]), {
            dof: { fStop: 99, sensorMm: 36, blur: 0.5 },
          }),
        ],
        [
          { from: "k1", to: "k2", ease: "linear", smooth: false },
          { from: "k2", to: "k3", ease: "inOutSine", smooth: false, easePosition: "linear" },
        ],
      ),
    ],
  },
  {
    id: "rig-malformed",
    docs: [
      rig(
        [
          key("a", 500, [0, 0, 5], point([0, 0, 0]), { fov: 200 }),
          key("a", 900, [9, 9, 9], point([0, 0, 0])),
          { id: "bad", tMs: 100, pose: { position: [0, 0], aim: point([0, 0, 0]) } },
          key("neg", -50, [0, 1, 6], point([0, 0, 0])),
          key("c", 1500, [1, 1, 4], point([0, 0, 0]), { fov: 5 }),
        ],
        [
          { from: "neg", to: "a", ease: "linear" },
          { from: "a", to: "c", ease: "inOutQuad" },
          { from: "neg", to: "c", ease: "linear" },
          { from: "c", to: "a", ease: "linear" },
          { from: "a", to: "nobody", ease: "linear" },
        ],
      ),
      {
        version: 1,
        cameraMode: "rig",
        cameraRig: { keys: [key("x", 0, [0, 0, 1], point([0, 0, 0]))] },
      },
      {
        version: 0,
        cameraMode: "rig",
        cameraRig: { keys: [key("x", 0, [0, 0, 1], point([0, 0, 0]))], segments: [] },
      },
    ],
  },
  {
    id: "continue-from-previous",
    sceneStartMs: [0, 2000],
    docs: [
      rig(
        [
          key("a", 0, [0, 0, 6], point([0, 0, 0]), { fov: 30 }),
          key("b", 2000, [1, 1, 4], point([0, 0.5, 0]), { fov: 26, rollDeg: 2 }),
        ],
        [{ from: "a", to: "b", ease: "inOutSine" }],
      ),
      rig(
        [
          { ...key("c", 0, [9, 9, 9], point([9, 9, 0])), continueFromPrevious: true },
          key("d", 1500, [0, 0, 3], point([0, 0, 0])),
        ],
        [{ from: "c", to: "d", ease: "outCubic" }],
      ),
    ],
  },
  {
    id: "orbit-track",
    docs: [
      {
        version: 1,
        camera: {
          keys: [
            orbitKey("k1", 0, { target: [0, 0, 0], azimuthDeg: -20, elevationDeg: 8, distance: 5 }),
            orbitKey("k2", 1875, {
              target: [0.2, 0.1, 0],
              azimuthDeg: 25,
              elevationDeg: 2,
              distance: 4.545,
              dof: { mode: "depth", blur: 0.6, range: 0.4 },
            }),
            orbitKey("k3", 3000, {
              target: [0.2, 0.1, 0],
              azimuthDeg: 25,
              elevationDeg: 2,
              distance: 3,
              dof: { focus: 2.5 },
            }),
          ],
          segments: [
            { from: "k1", to: "k2", ease: "linear" },
            { from: "k2", to: "k3", ease: "inOutBack", easeDof: "outSine" },
          ],
        },
      },
      {
        version: 1,
        cameraMode: "rig",
        camera: {
          keys: [
            orbitKey("o1", 0, { target: [0, 0, 0], azimuthDeg: 10, elevationDeg: 0, distance: 6 }),
          ],
          segments: [],
        },
      },
    ],
  },
  {
    id: "kicks",
    sceneStartMs: [18733.358, 0],
    docs: [
      rig(
        [
          key("k1", 0, [0, -0.985, 11.488], point([0, -0.1, 0]), { fov: 21 }),
          key("k4", 3750, [0.15, -0.95, 11.1], point([0, -0.1, 0]), { fov: 21 }),
        ],
        [{ from: "k1", to: "k4", ease: "linear" }],
        {
          cameraKicks: [
            { at: "bar:11", zoom: 1.03, releaseMs: 350 },
            { at: "bar:12.3", zoom: 1.02, rollDeg: 0.5, releaseMs: 500 },
            {
              at: 1000,
              offset: [0.1, -0.05, 0.2],
              attackMs: 80,
              holdMs: 40,
              releaseMs: 300,
              ease: "inOutSine",
            },
            { at: 1100, zoom: 9, rollDeg: -1, releaseMs: 200, ease: "nope", attackMs: -5 },
            { at: -10, zoom: 1.1, releaseMs: 100 },
            { at: "cue:missing", zoom: 1.1, releaseMs: 100 },
            { at: "nonsense", zoom: 1.1, releaseMs: 100 },
            { at: 3000, releaseMs: 100 },
            { at: 3200, zoom: 1.2, releaseMs: 0, ease: "jump" },
          ],
        },
      ),
      { version: 1, cameraKicks: [{ at: "cue:hit", zoom: 1.05, attackMs: 50, releaseMs: 250 }] },
    ],
  },
  {
    id: "device-track",
    docs: [
      rig([key("k1", 0, [0, 0, 6], point([0, 0, 0]))], [], {
        devices: [
          phone("hero", {
            position: [-2.05, 0.079, -0.318],
            rotationDeg: [0, 42, 0],
            scale: 1.39,
            ground: true,
          }),
          phone("parked", { position: [0, 0, 0] }),
          { id: "nomodel", placement: { position: [1, 1, 1] } },
        ],
        deviceTrack: {
          keys: [
            {
              id: "d1",
              tMs: 0,
              pose: { hero: { rotationDeg: [0, 0, 0] }, parked: { offset: [0, 0, 400] } },
            },
            { id: "d2", tMs: 2812, pose: { hero: { rotationDeg: [0, 0, 0] } } },
            {
              id: "d3",
              tMs: 3300,
              pose: {
                hero: { rotationDeg: [0, -6, 0], offset: [0, 0.1, 0] },
                parked: { offset: [0, 0, 0] },
              },
            },
            { id: "bad", pose: {} },
          ],
          segments: [
            { from: "d1", to: "d2", ease: "jump" },
            { from: "d2", to: "d3", ease: "outCubic" },
            { from: "d3", to: "d1", ease: "linear" },
            { from: "d1", to: "d3" },
          ],
        },
      }),
    ],
  },
];

const TIMES = [
  0, 1, 250, 600, 937, 1050, 1200, 1500, 1874, 1875, 2050, 2600, 2812, 3000, 3210, 3300, 3750, 4400,
  6000,
];

function expectPose(pose: CameraPose): CameraPoseExpect {
  const dof = pose.dof;
  return {
    position: [...pose.position] as V3,
    lookAt: [...pose.lookAt] as V3,
    fov: pose.fov,
    rollDeg: pose.rollDeg ?? 0,
    dof: dof
      ? {
          mode: dof.mode,
          blur: dof.blur,
          focus: dof.focus,
          range: dof.range,
          focusB: dof.focusB,
          fStop: dof.fStop,
          focalMm: dof.focalMm,
          sensorMm: dof.sensorMm,
        }
      : null,
  };
}

function buildCase(c: (typeof RAW_CASES)[number]): CameraVector {
  const music = c.music ?? (c.id === "kicks" ? MUSIC : NO_MUSIC);
  const sceneStartMs = c.sceneStartMs ?? c.docs.map(() => 0);
  const docs = c.docs.map(
    (raw, i) =>
      collectParseWarnings(() => parseSceneDoc(structuredClone(raw), `${c.id}#${i}`)).result,
  );
  const tracks = collectParseWarnings(() =>
    buildSceneCameraTracks(docs as (SceneDoc | undefined)[], undefined, undefined, {
      music,
      sceneStartMs,
    }),
  ).result;
  const poses: CameraVector["poses"] = [];
  const devices: CameraVector["devices"] = [];
  docs.forEach((doc, scene) => {
    const deviceTrack = collectParseWarnings(() => resolveDeviceTrack(doc)).result;
    for (const tMs of c.times ?? TIMES) {
      poses.push({
        scene,
        tMs,
        expect: expectPose(sceneCameraPose(tracks[scene], tMs, baseCameraPose())),
      });
      for (const device of doc?.devices ?? []) {
        const pose = deviceTrackPoseAt(deviceTrack, device.id, tMs);
        devices.push({
          scene,
          id: device.id,
          tMs,
          expect: { offset: [...pose.offset] as V3, rotationDeg: [...pose.rotationDeg] as V3 },
        });
      }
    }
  });
  return { id: c.id, music, sceneStartMs, docs: c.docs, poses, devices };
}

export function buildCameraVectors(): CameraVectors {
  return { version: 1, cases: RAW_CASES.map(buildCase) };
}

export function serialiseCameraVectors(vectors: CameraVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}
