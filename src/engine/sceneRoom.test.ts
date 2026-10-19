import { AmbientLight, DirectionalLight, Scene } from "three";
import { describe, expect, it } from "vitest";
import type { LightingSpec, Theme } from "../theme/tokens";
import { applyFrameLighting, registerLightingAnimatable } from "./lightingAnimation";
import { resolveSceneLocalMs } from "./musicTime";
import { collectParseWarnings } from "./parseWarnings";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";
import { buildLightingTracks, resolveFrameLighting } from "./sceneLighting";
import {
  buildRoomTracks,
  collectRoomThemeIds,
  mixRoomColour,
  normalizeRoomTrack,
  ROOM_FLOOD_MS,
  ROOM_FLOOD_SEGMENTS,
  resolveRoomAt,
  roomFloodCircle,
  sampleRoom,
  validateRoomKey,
  validateRoomKeys,
} from "./sceneRoom";
import { buildSceneRenderStates, resolveFramePlans, resolveFrameSceneStates } from "./sceneState";
import { buildSceneTimeline, resolveAt } from "./sceneTimeline";

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: "test",
    name: "Test",
    colors: { background: "#0b0f14", text: "#ffffff", accent: "#00ffcc", muted: "#888888" },
    typography: {
      headline: { family: "Inter", weight: 400 },
      body: { family: "Inter", weight: 400 },
      scale: 1.25,
    },
    motion: {
      durations: { fast: 200, base: 500, slow: 900 },
      easings: { standard: "outQuad", emphasized: "outExpo" },
    },
    ...overrides,
  };
}

const LIT: LightingSpec = {
  sun: { azimuthDeg: 30, elevationDeg: 50, intensity: 2, color: "#ffffff" },
  ambient: 0.4,
  lights: [
    {
      id: "wash",
      type: "point",
      intensity: 6,
      colorToken: "background",
      placement: { mode: "point", position: [0, 2, 3] },
    },
    {
      id: "rim",
      type: "point",
      intensity: 3,
      kelvin: 6500,
      placement: { mode: "point", position: [0, 2, -3] },
    },
  ],
};

const theme = makeTheme({ lighting: LIT });
const night = makeTheme({
  id: "night",
  colors: { background: "#101a3a", text: "#e8ecff", accent: "#ff7a59", muted: "#5d6788" },
  lighting: {
    sun: { azimuthDeg: 0, elevationDeg: 10, intensity: 0.5, colorToken: "accent" },
    ambient: 0.1,
    ambientColor: "#203060",
    lights: [
      {
        id: "rim",
        type: "point",
        intensity: 9,
        color: "#ff0000",
        placement: { mode: "point", position: [0, 0, 0] },
      },
    ],
  },
});

const doc = (room: unknown, extra: Partial<SceneDoc> = {}): SceneDoc =>
  ({ version: 1, room, ...extra }) as SceneDoc;

describe("room key validation", () => {
  it("resolves numbers, and musical positions against the scene's music", () => {
    expect(resolveRoomAt(1200)).toBe(1200);
    expect(resolveRoomAt(-5)).toBe(0);
    expect(resolveRoomAt("bar:2.3")).toBeUndefined();
    expect(resolveRoomAt("soon")).toBeNull();
    const music = { startOffsetMs: 0, cues: { drop: 2000 }, sections: {} };
    const expected = resolveSceneLocalMs("cue:drop", music, 500);
    if (!expected.ok) throw new Error("the cue should resolve");
    expect(resolveRoomAt("cue:drop", { music, sceneStartMs: 500 })).toBe(expected.projectMs);
    expect(resolveRoomAt("cue:nope", { music, sceneStartMs: 500 })).toBeNull();
    const warnings: string[] = [];
    expect(
      validateRoomKey({ at: "cue:nope", colour: "#ff0000" }, "k", (m) => warnings.push(m), {
        music,
        sceneStartMs: 0,
      }),
    ).toBeNull();
    expect(warnings[0]).toContain("doesn't resolve");
    expect(validateRoomKey({ at: "bar:2", colour: "#ff0000" }, "k")).not.toBeNull();
  });

  it("defaults a cut, fills a flood, and warns on bad fields", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(validateRoomKey({ at: 0, colour: "accent" }, "k", warn)).toEqual({
      at: 0,
      colour: "accent",
      transition: "cut",
      origin: [0.5, 0.5],
      durationMs: 0,
      ease: "inOutQuad",
    });
    const flood = validateRoomKey(
      {
        at: 100,
        colour: "#abc",
        transition: "flood",
        ease: "wobbly",
        color: "#fff",
        origin: [1, 0],
      },
      "k",
      warn,
    );
    expect(flood?.durationMs).toBe(ROOM_FLOOD_MS);
    expect(flood?.ease).toBe("inOutQuad");
    expect(flood?.origin).toEqual([1, 0]);
    expect(warnings.some((w) => w.includes('ease "wobbly"'))).toBe(true);
    expect(warnings.some((w) => w.includes("k.color isn't a room field"))).toBe(true);
    expect(validateRoomKey({ at: 0, colour: "teal" }, "k", warn)).toBeNull();
  });

  it("sorts keys and ends a flood at the next key", () => {
    const warnings: string[] = [];
    const keys = validateRoomKeys(
      [
        { at: 900, colour: "#000000" },
        { at: 500, colour: "#ffffff", transition: "flood", durationMs: 1000 },
      ],
      "room",
      (m) => warnings.push(m),
    );
    expect(keys.map((k) => k.at)).toEqual([500, 900]);
    expect(keys[0].durationMs).toBe(400);
    expect(warnings[0]).toContain("runs past the next key");
  });

  it("parses the sidecar block shallowly, keeping raw keys and reporting through parseWarn", () => {
    const raw = {
      version: 1,
      room: {
        keys: [
          { at: "bar:2", colour: "#ff0000" },
          { at: "soon", colour: "#0000ff" },
          { at: 0, colour: "#00ff00" },
        ],
      },
    };
    const { result, warnings } = collectParseWarnings(() => parseSceneDoc(raw, "scenes/a.json"));
    expect(result?.room?.keys).toHaveLength(3);
    expect(warnings.some((w) => w.includes("room.keys[0].at"))).toBe(false);
    expect(warnings.some((w) => w.includes("room.keys[1].at"))).toBe(true);
    const dropped = collectParseWarnings(() =>
      parseSceneDoc({ version: 1, room: { keys: [] } }, "scenes/b.json"),
    );
    expect(dropped.result?.room).toBeUndefined();
    expect(dropped.warnings[0]).toContain("room needs a non-empty keys array");
  });

  it("collects the theme ids room keys name", () => {
    expect(
      collectRoomThemeIds([
        doc({
          keys: [
            { at: 0, themeId: "night" },
            { at: 1, themeId: "night" },
          ],
        }),
        undefined,
        doc({ keys: [{ at: 0, themeId: "ws:dusk" }] }),
      ]),
    ).toEqual(["night", "ws:dusk"]);
  });
});

describe("buildRoomTracks", () => {
  it("is null when no scene has a room (the legacy path)", () => {
    expect(
      buildRoomTracks([undefined, { version: 1 }], { sceneThemes: [theme, theme] }),
    ).toBeNull();
    expect(
      buildRoomTracks([doc({ keys: [{ at: "bar:1", colour: "#fff" }] })], { sceneThemes: [theme] }),
    ).toBeNull();
  });

  it("resolves colours: hex, token, a themeId's background, else the previous room", () => {
    const track = normalizeRoomTrack(
      {
        keys: [
          { at: 0, colour: "#ABC" },
          { at: 100, colour: "accent" },
          { at: 200, themeId: "night" },
          { at: 300, lighting: { ambient: 1 } },
          { at: 400, themeId: "night", colour: "accent" },
        ],
      },
      { sceneTheme: theme, roomThemes: { night }, docLighting: undefined },
    );
    expect(track?.keys.map((k) => k.colour)).toEqual([
      "#aabbcc",
      "#00ffcc",
      "#101a3a",
      "#101a3a",
      "#ff7a59",
    ]);
  });

  it("relights from the themeId, follows tokened lights, fills every key to the union", () => {
    const track = normalizeRoomTrack(
      {
        keys: [
          { at: 0, colour: "#336699" },
          { at: 1000, themeId: "night", lighting: { lights: { wash: { intensity: 2 } } } },
        ],
      },
      { sceneTheme: theme, roomThemes: { night } },
    );
    if (!track) throw new Error("no track");
    // Base values for every touched field; the tokened wash follows the scene's own background.
    expect(track.basePose).toEqual({
      ambient: 0.4,
      ambientColor: "#ffffff",
      sun: { intensity: 2, color: "#ffffff" },
      lights: {
        wash: { intensity: 6, color: "#0b0f14" },
        rim: { intensity: 3, color: expect.any(String) },
      },
    });
    // Key 0: only the tokened wash changes (it follows the room colour).
    expect(track.keys[0].pose.lights?.wash).toEqual({ intensity: 6, color: "#336699" });
    expect(track.keys[0].pose.sun).toEqual({ intensity: 2, color: "#ffffff" });
    // Key 1: the night theme's sun (its accent token), ambient, rim; the key's own wash intensity wins.
    expect(track.keys[1].pose).toEqual({
      ambient: 0.1,
      ambientColor: "#203060",
      sun: { intensity: 0.5, color: "#ff7a59" },
      lights: {
        wash: { intensity: 2, color: "#101a3a" },
        rim: { intensity: 9, color: "#ff0000" },
      },
    });
  });

  it("is index-aligned and reads each scene's own doc lighting", () => {
    const tracks = buildRoomTracks([undefined, doc({ keys: [{ at: 0, colour: "#ffffff" }] })], {
      sceneThemes: [theme, theme],
    });
    expect(tracks?.[0]).toBeNull();
    expect(tracks?.[1]?.keys[0].colour).toBe("#ffffff");
  });
});

describe("sampleRoom", () => {
  const track = normalizeRoomTrack(
    {
      keys: [
        { at: 500, colour: "#ff0000", lighting: { ambient: 0 } },
        {
          at: 1000,
          colour: "#0000ff",
          transition: "flood",
          durationMs: 400,
          ease: "linear",
          origin: [0, 1],
          lighting: { ambient: 1 },
        },
      ],
    },
    { sceneTheme: theme },
  );
  if (!track) throw new Error("no track");

  it("shows the scene's own background before the first key, then cuts", () => {
    expect(sampleRoom(track, 0)).toEqual({ colour: null, key: -1, flood: null, pose: {} });
    const cut = sampleRoom(track, 500);
    expect(cut.colour).toBe("#ff0000");
    expect(cut.pose.ambient).toBe(0);
  });

  it("floods over the previous room with the lights lerping by the eased amount", () => {
    const mid = sampleRoom(track, 1100);
    expect(mid.colour).toBe("#ff0000");
    expect(mid.key).toBe(0);
    expect(mid.flood).toEqual({ colour: "#0000ff", origin: [0, 1], progress: 0.25, radius: 0.25 });
    expect(mid.pose.ambient).toBeCloseTo(0.25, 10);
    const done = sampleRoom(track, 1400);
    expect(done).toMatchObject({ colour: "#0000ff", key: 1, flood: null });
    expect(done.pose.ambient).toBe(1);
  });

  it("keeps the lights between the two rooms when a Back ease overshoots", () => {
    const back = normalizeRoomTrack(
      {
        keys: [
          { at: 0, colour: "#ff0000", lighting: { ambient: 0.2 } },
          {
            at: 100,
            colour: "#0000ff",
            transition: "flood",
            durationMs: 400,
            ease: "inBack",
            lighting: { ambient: 3 },
          },
          {
            at: 600,
            colour: "#00ff00",
            transition: "flood",
            durationMs: 400,
            ease: "outBack",
            lighting: { ambient: 1 },
          },
        ],
      },
      { sceneTheme: theme },
    );
    if (!back) throw new Error("no track");
    const dip = sampleRoom(back, 150);
    expect(dip.flood?.radius).toBeLessThan(0);
    expect(dip.pose.ambient).toBe(0.2);
    const over = sampleRoom(back, 900);
    expect(over.flood?.radius).toBeGreaterThan(1);
    expect(over.pose.ambient).toBe(1);
  });

  it("a first flood spreads over the scene's own background from the base pose", () => {
    const first = normalizeRoomTrack(
      { keys: [{ at: 0, colour: "#ffffff", transition: "flood", lighting: { ambient: 2 } }] },
      { sceneTheme: theme },
    );
    if (!first) throw new Error("no track");
    const start = sampleRoom(first, 0);
    expect(start.colour).toBeNull();
    expect(start.flood?.radius).toBe(0);
    expect(start.pose.ambient).toBe(0.4);
  });

  it("mixes colours in linear light with exact endpoints", () => {
    expect(mixRoomColour("#ff0000", "#0000ff", 0)).toBe("#ff0000");
    expect(mixRoomColour("#ff0000", "#0000ff", 1)).toBe("#0000ff");
    // Linear-light midpoint of 255 and 0 is sRGB 188 (0xbc).
    expect(mixRoomColour("#ff0000", "#0000ff", 0.5)).toBe("#bc00bc");
  });
});

describe("roomFloodCircle", () => {
  it("centres on the origin and covers the frame at radius 1", () => {
    const halfH = 50 * Math.tan((50 * Math.PI) / 360);
    const halfW = halfH * (16 / 9);
    const centre = roomFloodCircle(50, 16 / 9, 50, [0.5, 0.5], 1);
    expect(centre.x).toBeCloseTo(0, 10);
    expect(centre.y).toBeCloseTo(0, 10);
    const inscribed = centre.r * Math.cos(Math.PI / ROOM_FLOOD_SEGMENTS);
    expect(inscribed).toBeGreaterThan(Math.hypot(halfW, halfH));
    const corner = roomFloodCircle(50, 16 / 9, 50, [0, 0], 0.5);
    expect(corner.x).toBeCloseTo(-halfW, 10);
    expect(corner.y).toBeCloseTo(halfH, 10);
    expect(corner.r).toBeCloseTo(centre.r, 10);
    expect(roomFloodCircle(50, 1, 50, [0.5, 0.5], 0).r).toBe(0);
  });
});

describe("resolveFramePlans", () => {
  const slots = buildSceneTimeline([
    { id: "a", durationMs: 1000, transition: { type: "crossfade", durationMs: 400 } },
    { id: "b", durationMs: 1000 },
  ]);
  const roomDoc = doc({
    keys: [
      { at: 0, colour: "#ff0000" },
      { at: 300, colour: "#00ff00", transition: "flood", durationMs: 400 },
    ],
  });
  const docs = [undefined, roomDoc];
  const themes = [theme, theme];

  it("takes today's path exactly without rooms", () => {
    const states = buildSceneRenderStates(theme, themes, { sceneDocs: [undefined, undefined] });
    const tracks = buildLightingTracks(themes, undefined, [undefined, undefined]);
    const resolved = resolveAt(slots, 800);
    const plans = resolveFramePlans({ sceneStates: states, lightingTracks: tracks }, resolved);
    expect(plans.statePlan).toEqual(resolveFrameSceneStates(states, resolved));
    expect(plans.lightingPlan).toBeUndefined();
    expect(resolveFrameLighting(tracks, resolved)).toBeNull();
  });

  it("samples each transition side's own room at its own scene-local time", () => {
    const states = buildSceneRenderStates(theme, themes, { sceneDocs: docs });
    expect(states).not.toBeNull();
    const roomTracks = buildRoomTracks(docs, { sceneThemes: themes });
    const lightingTracks = buildLightingTracks(themes, undefined, docs);
    // Global 800 = scene A at 800, scene B at 200 (before its flood).
    const early = resolveFramePlans(
      { sceneStates: states, lightingTracks, roomTracks },
      resolveAt(slots, 800),
    );
    expect(early.statePlan?.a?.background.getHexString()).toBe("0b0f14");
    expect(early.statePlan?.b?.background.getHexString()).toBe("ff0000");
    expect(early.lightingPlan?.a).toBeUndefined();
    expect(early.lightingPlan?.b).toMatchObject({ index: 1, roomed: true });
    // Global 1000 = scene B at 400, mid-flood: the state keeps the room underneath.
    const solo = resolveFramePlans(
      { sceneStates: states, lightingTracks, roomTracks },
      resolveAt(slots, 1000),
    );
    expect(solo.statePlan?.solo?.background.getHexString()).toBe("ff0000");
  });

  it("writes room colours on roomed samples only, ambient included", () => {
    const scene = new Scene();
    const sun = new DirectionalLight("#ffffff", 2);
    const ambient = new AmbientLight("#ffffff", 0.4);
    const cleanups = [
      registerLightingAnimatable("room:sun", {
        kind: "sun",
        sceneIndex: 7,
        light: sun,
        base: { azimuthDeg: 0, elevationDeg: 45, intensity: 2 },
        baseColor: "#ffffff",
      }),
      registerLightingAnimatable("room:ambient", {
        kind: "ambient",
        sceneIndex: 7,
        light: ambient,
        base: 0.4,
        baseColor: "#ffffff",
      }),
    ];
    applyFrameLighting(scene, {
      index: 7,
      pose: { ambient: 0.2, ambientColor: "#ff0000", sun: { color: "#00ff00" } },
      roomed: true,
    });
    expect(ambient.color.getHexString()).toBe("ff0000");
    expect(sun.color.getHexString()).toBe("00ff00");
    applyFrameLighting(scene, { index: 7, pose: {}, roomed: true });
    expect(ambient.color.getHexString()).toBe("ffffff");
    expect(sun.color.getHexString()).toBe("ffffff");
    ambient.color.set("#123456");
    applyFrameLighting(scene, { index: 7, pose: { ambient: 0.3 } });
    expect(ambient.color.getHexString()).toBe("123456");
    for (const cleanup of cleanups) cleanup();
  });
});
