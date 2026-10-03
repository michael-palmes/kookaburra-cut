# scene3d look kit

Shared building blocks for world-space 3D looks (`looks/<id>/`). Import from `../../kit`
(the barrel); tests import the pure modules directly.

## Rules

- **Linear in, three encodes.** Mix LINEAR colours (`lookColorUniform(hex)`, three converts the
  hex on parse) into `gl_FragColor`, then end `main()` with `#include <colorspace_fragment>`.
  Never write sRGB by hand and never decode samples yourself. The same program then encodes
  once on every path: the canvas (sRGB in the shader), the compositor's transition targets
  (linear out, hardware sRGB store) and effects projects (linear out, the composer's one ACES,
  like every backdrop). No `wrap.ts` reroute is needed; that exists only for the 2D fills,
  which write display-domain colour raw.
- **No post-processing.** Every effect (grain, halftone, fades) lives in the look's own
  materials in world, object or uv space, so text and devices are never restyled. Never
  `gl_FragCoord`: it scales with the preview DPR.
- **Unlit.** `toneMapped: false`, no lights, no fog; shading comes from a virtual light in the
  shader.
- **Deterministic.** Hash with `hash11/21/31/22` (the house PCG hash, integer inputs: floor
  floats through `ivec`), never `fract(sin())`. Motion is a pure function of look time.

`createLookMaterial` enforces the colourspace include, the hash ban, fragment-only derivatives
and the `gl_FragCoord` ban by throwing, so a bad material fails its first capture.

## Backing tone

Looks receive `backing`, the scene's backing as one sRGB hex (`resolveScene3dBackingTone` in
`../backing.ts`, resolved by `Scene3dBackdrop`). Fade toward it with `backingMix`, never by
alpha or a guessed tone: alpha fades blend in sRGB on the canvas but in linear on compositor
targets (the fade shifts at a transition), and a translucent part that writes depth shows
whatever drew before it.

| Backing | `backing` |
|---|---|
| `color` | the colour as is |
| `gradient` | its middle row averaged, sampled as the fixed raster does: distance fades converge at the horizon, so a vertical gradient gives its exact horizon colour |
| `shader` | its `Back` slot (the field's ground), else the mean of its colours |
| none, `image`, `video` | the frame clear colour, `theme.colors.background` |

```ts
uniforms: { uSkirt: lookColorUniform("#141a24"), uBacking: lookColorUniform("#0d1219") },
// layout effect: mats.skirt.uniforms.uBacking.value.set(backing);
// GLSL: ${LOOK_GLSL_BACKING} above main(), then
// gl_FragColor = vec4(backingMix(uSkirt, uBacking, 1.0 - fade), 1.0);
```

`backingMix` (fragment only, paste `LOOK_GLSL_BACKING`) blends in display space, so an alpha
fade converted to it keeps its approved canvas curve over the backing (Rain canopy's far drops); a plain
linear `mix` lifts dark fades by up to 18 code values. Keep alpha for coverage (line AA,
sub-pixel fades) and for any haze over the look's OWN translucent parts: Blue
and gold's far ground hazes over its glow shell, so an opaque mix there cut a dark seam.

## Materials

```ts
const t = useLookTime(speed);
const mats = useLookMaterials(
  () => ({
    floor: {
      key: "my-look/floor",
      fragmentShader: FLOOR,
      transparent: true,
      uniforms: { uInk: lookColorUniform(colors[0]), uTime: { value: 0 } },
    },
  }),
  [colors[0]],
);
useLayoutEffect(() => {
  mats.floor.uniforms.uTime.value = loopSeconds(t * PACE, PERIOD);
}, [mats, t]);
```

- `key` is `<look-id>/<part>`: the fixed program cache key and material name.
- Shaders use three's default dialect (`varying`, `gl_FragColor`, no `#version`/`precision`).
  The default vertex shader passes `vWorld`, `vUv`, `vNormalW` and `vInstanceColor`; declare only
  the varyings you read.
- `uResolution` (export px) and `uPx` (export height / 1080) are declared and synced by the kit
  from `useFormat()`, never the preview canvas: size pixel effects as `n * uPx` so a 320px tile,
  the preview and a 4K export agree. Do not declare or pass them yourself.
- Update uniform values in a layout effect; list only rebuild triggers in `deps`.
- `cutaway: true` sets `side: BackSide` for shells (F11): the near half culls away once the camera
  is outside, so the far wall stays behind the stage.
- `alphaToCoverage: true` turns alpha into MSAA coverage for opaque cut-outs (card flats,
  silhouettes): edges antialias with depth writes on and no sort. Keep alpha fractional only on
  the edge ramp: a broad alpha fade dithers, so cut near parts with `stageCut` (below) and
  fade tone with `backingMix` (`looks/paper-theatre/`, `looks/pop-up-terrace/`).
- Keep `depthTest` on for transparent parts: they draw after opaque meshes, so one with it off
  paints over devices (rejected). Pull a glow clear of its own petals in view space instead.
- `lookLuminance(hex)` is a preset hex's relative luminance: compare the backing with the
  palette to shade light and dark presets the right way round (`looks/calder-mobiles/`).
- `smoothstep` and `fract` (`./math`) are exact CPU mirrors of the GLSL builtins, for poses and
  uniforms that must agree with a shader.

## GLSL chunks

Prepended automatically and include-guarded.

| Chunk | Stage | Gives |
|---|---|---|
| `LOOK_GLSL_FRAME` | both | `uResolution`, `uPx` |
| `LOOK_GLSL_HASH` | both | `hash11(int)`, `hash21(ivec2)`, `hash31(ivec3)`, `hash22(ivec2)` |
| `LOOK_GLSL_NOISE` | both | `vnoise`, `fbm` (2D, 5 octaves), `vnoise3`, `fbm3` (3D, 4 octaves) |
| `LOOK_GLSL_STAGE` | both | `stageFade`, `stageFadeInLine` |
| `LOOK_GLSL_AA` | fragment only | `aaStep`, `aaBand`, `pitchGuard`, `aaLine`, `stageCut` (fwidth) |
| `LOOK_GLSL_VERTEX_HELPERS` | vertex only | `lookWorldPosition`, `lookWorldNormal`, `lookInstanceColor`, `exportPxPerUnit` |

- `aaStep`/`aaBand` antialias every procedural edge: MSAA does not smooth shader interiors.
- `pitchGuard(cellUv)` is 1 while a world-space cell is large on screen, 0 near pixel size: mix
  the pattern toward its MEAN tone with it, or fine patterns shimmer and moire.
- `aaLine(d, halfWidth)` draws a line (seam, crease) `halfWidth` either side of `d = 0`; below
  0.75 px each side it holds that width and fades coverage instead of thinning.
- `stageFade(wp)` (F11) is 0 between the camera and the stage, 1 elsewhere, over 0.75 to 0.97 of
  the camera-to-stage distance (the orbit reaches 50). `stageFade(wp, near, far)` sets the
  window; the sketches' one-argument form was 0.55 to 0.95.
- `stageCut(wp, near, far)` is that fade as one hard antialiased edge at its midpoint, for
  alpha-to-coverage and discard cuts. `stageFadeInLine(wp, near, far, missFrom, missTo)` fades
  only fragments whose view ray passes within `missFrom` to `missTo` of the stage centre, so
  walls beside the camera stay (`looks/colour-court/`, `looks/iris-screen/`). Both drop
  `near, far` for the default window.
- No text band calm. A camera-projected fade behind the headline made parts fade in and out
  and cut cables mid-span as the camera moved, so the owner removed it from every look: keep
  the headline readable through composition (layout, contrast, quiet tones) instead.

## Clock

`useLookTime(speed)` is seconds on the ABSOLUTE project clock (`globalMs`) times speed, so a look
flows across cuts. Bake a per-look pace constant, and wrap long loops with `loopSeconds(t,
period)` on the CPU so shader floats stay small. The existing ten looks keep scene-local time.

## Instanced layout (F12)

```ts
const items = useSeededPlacements(SEED, count, (rand, i) => ({ a: rand() * TAU, r: 12 + rand() * 3 }));
useInstancedLayout(meshRef, items, (p, i, out) => {
  out.position.set(Math.cos(p.a) * p.r, Math.sin(t + i), Math.sin(p.a) * p.r);
});
```

- Placements draw from one seeded stream in index order: that order is export contract.
- Matrices are written in the commit phase after every render, from scratch objects (no
  per-frame allocation). Give the mesh `frustumCulled={false}` and a fixed capacity (`args`);
  remount with `key` if the capacity changes.
- `writeInstanceColors` writes static linear instance colours (read with `lookInstanceColor()`);
  call it from a layout effect keyed on the palette, before the first render, so the program
  compiles with instance colours.
- Mount every renderable at first commit and toggle `visible`: the host stamps render order only
  on its own commits.

### Static anchors, shader motion

When every instance moves by a closed-form field (waves, swells), keep the CPU layout static and
animate in the vertex shader, so thousands of instances upload their matrices once, not per frame
(Rain canopy: about 2,260 drops plus their threads).

```ts
const cells = useMemo(() => hexLattice(params.spacing, 30), [params.spacing]);
useStaticInstancedLayout([dropsRef, threadsRef], cells, (p, _i, out) => {
  out.position.set(p.x, 0, p.z);
});
// vertex: `${LOOK_GLSL_INSTANCE_ANCHOR}` then `vec3 a = lookInstanceAnchor();`
```

- `hexLattice(spacing, radius)` is a hex-packed disc emitted row by row from -z to +z (export
  contract). No seed: it is regular by construction.
- `useStaticInstancedLayout(refs, items, pose)` writes once per mesh and `items` identity, so
  companion meshes (drops and threads) share one layout and a remounted mesh is caught. Memoise
  `items`; `pose` must be a pure function of the item.
- `LOOK_GLSL_INSTANCE_ANCHOR` (vertex only, paste it) gives `lookInstanceAnchor()`, the instance
  translation. Size the capacity for the densest slider value; `mesh.count` follows the layout.

## Ink ribbons (F2)

World-space lines drawn as screen-extruded quads, one instance per segment. Each point is a vec4
path param that the look's GLSL `inkPath` turns into a look-local position, so animated lines
build once and move in the vertex stage.

```ts
const geo = useInkRibbonGeometry(
  () => inkStrands(RINGS, 512, (k, i) => [(i / 512) * TAU, k], { closed: true, data: (k) => [k] }),
  [],
);
const mats = useLookMaterials(
  () => ({
    crest: inkRibbonMaterial({
      key: "my-look/crest",
      path: "vec3 inkPath(vec4 p) { return vec3(cos(p.x), 0.0, sin(p.x)) * (12.0 + p.y); }",
      fragmentShader: CREST, // gl_FragColor = vec4(uInk, inkCoverage()); then colorspace_fragment
      uniforms: { uInk: lookColorUniform(colors[0]) },
      lineWidth: { px: 2.2 },
      fade: [40, 80],
    }),
  }),
  [colors[0]],
);
return <mesh geometry={geo} material={mats.crest} frustumCulled={false} />;
```

- Strands: `inkPolyline(points, data)`, `inkLoop(points, data)` (wraps) and `inkStrands(count,
  points, param, { closed, data })` for many same-shaped strands (threads, streaks, rings).
  `data` is the per-strand vec4 `inkStrand` (vertex attribute) and `vInkStrand` (fragment).
  Build at the max count and slide with `showInkStrands(geo, n)`; never rebuild per frame.
- Width `uInkWidth` = (world, px, min): the line is `max(world width, px * uPx)` wide; below
  `min * uPx` (never under 1.2 export px) it keeps that width and fades coverage instead of
  thinning, so dense far lines dim rather than alias. Per-point widths: pass `width`, GLSL
  defining `vec2 inkWidth(vec4 p, vec3 world)`.
- Joins are mitred from the neighbouring points, so joined segments share edges (no overlap
  beads, no gaps). Segments crossing the near plane are clipped.
- Fragment: `inkCoverage()` is edge AA (fwidth) x floor coverage x the `fade` distance window.
  The chunk declares `vWorld`, `vInkAlong` (0 to 1 along the strand) and `vInkStrand`; add your
  own varyings with `vertex`, GLSL defining `void inkVertex(vec4 p, vec3 world)`.
- `lift` pulls ink toward the camera by that fraction of its depth (no screen shift), so a crest
  drawn on its own surface wins the depth test (0.002 to 0.004 suits a floor at 10 to 50 units).

## Stroke splats (F3)

Painterly brush strokes (daubs, foliage, reflection strokes) as instanced quads masked by a
seeded dry-brush atlas and laid as flat, layered paint.

```ts
const splats = useMemo(() => orderSplatsFarToNear(place()), []); // StrokeSplat[]: id, x/y/z, yaw, tilt, length, width, shape, tone, rank
const geo = useStrokeSplatGeometry(splats);
const boilStep = useSplatBoilStep(params.boilFps);
const mats = useLookMaterials(
  () => ({
    daubs: {
      key: "my-look/daubs",
      ...STROKE_SPLAT_MATERIAL,
      vertexShader: DAUBS, // `${STROKE_SPLAT_GLSL_VERTEX}` + main()
      fragmentShader: PAINT, // `${STROKE_SPLAT_GLSL_FRAGMENT}` + main(): splatMask(vAtlasUv)
      uniforms: { ...brushMaskUniforms(), uBoilStep: { value: 0 } },
    },
  }),
  [],
);
return <mesh geometry={geo} material={mats.daubs} frustumCulled={false} />;
```

- **No flicker.** Draw order is fixed at build (`orderSplatsFarToNear`: farthest from the stage
  first, id ties) with depth writes off, so overlaps layer like paint and never z-fight or
  re-sort. Keep tilts low (8 to 18 degrees reads as paint on the ground), take tone steps from
  the REST pose (sway must never flip a step) and blend time-varying tone (cloud shadows)
  smoothly.
- **Boil.** `splatBoilStep(globalMs, rate)` is an integer from the frame index; hash it with
  `splatRandStep(salt, step)` for stop-motion jitter. Default the rate to 0.
- **Vertex helpers** (`STROKE_SPLAT_GLSL_VERTEX`): `splatLocalCorner(position.xy, len, width)`,
  `splatLocalNormal()`, `splatYaw`, `splatTip` (0 root edge, 1 free edge, for wind shear),
  `splatRand(salt)`, `splatHidden(keep)` with `splatCulled()` (thin by rank at the densest pool,
  no rebuilds) and `splatAtlasUv(uv)`. Fade far strokes by projected size (`exportPxPerUnit`)
  before they shrink to pixels.
- **Atlas.** `brushMaskTexture()` is one 256x128 RGBA8 texture built on first use from seeded
  maths (no canvas): four shapes (`BRUSH_SHAPES`: flat, curved, short, tapered), R the paint
  load, A the coverage, and a JS mip chain that weights paint by coverage. Mix a dark rim to
  the lit tone with `splatMask(uv).x`; `.y` is the soft-thresholded coverage.
- Every look part shares a stage-centred bounding sphere (`createStrokeSplatGeometry` sets
  one), so three's transparent sort ties and mount order is draw order. Worked example:
  `looks/blue-and-gold/`.

## Print screen (F4)

Grain, screens, halftone and dither for print looks (riso, mezzotint, Ben-Day). Paste
`${LOOK_GLSL_PRINT}` above a fragment's `main()` (fragment-only: it uses `fwidth`).

```glsl
vec2 slip = printSlip(p, uSlip);                 // uSlip = printPlateSlip(misregister)
float screen = printScreen(p, 1.0 / 22.0, 1.0);  // threshold field, mean 0.5
float ink = printInk(density(p + slip), screen); // AA coverage of one plate
col = mix(paper, inkColour, ink);
```

- Coordinates are world or object space only (planar xz for floors, angle x radius and y for
  rings, direction for domes). Nothing takes time: grain moves only with the camera, which
  motion vectors predict, so H.264/H.265 bitrates stay sane.
- `printGrain(p, pitch)` (vec2 or vec3) is value-noise grain in -0.5..0.5; `printScreen(p,
  pitch, amount)` is a fine plus coarse (x22/6) threshold field. Both fall to their mean once a
  cell nears pixel size, so far and tile-sized surfaces print clean two-tone bands, and skip
  their noise lookups there (the guard is taken before the branch, so derivatives stay valid).
- `printInk(density, threshold)` is the one-pixel AA coverage of a plate screened against a
  threshold (zero density prints nothing).
- `printHalftone(p, pitch, angle, tone)` draws round dots whose area tracks tone;
  `printDither(p, pitch, tone, blue)` is an 8x8 Bayer (`blue` 0) or R2 low-discrepancy (`blue`
  1, blue-noise-like, no tile) ordered dither. Both fall to flat tone under ~1.5 px cells.
- Misregistration: `printPlateSlip(amount, angleDeg?)` (TS) gives plate A's slip, plate B takes
  its negation; `printSlip(p, slip)` folds it to zero once it nears pixel size, so fringes
  resolve into clean registration instead of shimmering. Screen each plate at its own slipped
  position (sample the tone there), never shift a finished plate.
- `printBayer`, `printR2` and `printDotRadius` have exact CPU mirrors for tests.

## Analytic gobos (F6)

Patterned light pools on floors and walls, no shadow maps: each receiving fragment traces its
ray toward a virtual sun to the occluder and evaluates the occluder's OWN pattern function
there, with an edge width that grows with the distance travelled. Paste `${LOOK_GLSL_GOBO}`
above a fragment's `main()` (fragment-only).

```glsl
GoboHit h = goboCylinder(vWorld, uSun, uRadius);         // or goboPlane(p, uSun, origin, normal)
float open = pattern(coordsAt(h.point), goboPenumbra(h.dist) / cellSize);
float light = open * goboReach(h.dist, 14.0) * h.hit * goboClearing(vWorld, uClear, 3.0);
```

- Write the pattern once as `float pattern(vec2 uv, float width)` built from `goboEdge(sdf,
  width, size)` and call it on the occluder with `width` 0 (pixel AA) and on the receiver with
  the penumbra: the pools then match the screen exactly. `size` (the aperture half-width) dims
  a pinhole narrower than its penumbra instead of blooming it.
- Drums: `goboTurns(q)` is (turns round the axis, height), `goboTurnsWidth(q)` their pixel
  widths without the atan seam spike; pitch-guard from those widths, not `fwidth` of the coords.
- The sun is CPU closed form: `writeGoboSun(uniform.value, path, t)` from a `GoboSunPath`
  (v9 orbit convention, optional sway), and `goboCompanionSun(path, { intensity, kelvin })`
  builds the preset's companion `sun` from the same numbers, so devices light from where the
  pools fall. Keep receivers' derivative work out of branches: compute the pattern, then mix.
- `traceGoboCylinder`, `traceGoboPlane` and `goboPenumbra` are CPU mirrors for tests and
  placement. Worked example: `looks/iris-screen/`.

## Polar medallions

Dials and inlaid floors drawn in polar coordinates on a disc (floor at y -2, optionally a
mirrored ceiling that faces down and culls once the camera rises above it). Paste
`${LOOK_GLSL_MEDALLION}` above a fragment's `main()`.

```glsl
float px = max(length(fwidth(q)) * 0.75, 1e-4);          // world units per pixel, from the plane
float strand = medLine(sdf / gradLen, halfWidth, px);    // normalised SDFs: pass the pixel size
float sheen = medLobe(atan(q.y, q.x), uSheenAngle, 0.32); // wrapped angular lobe
```

- `medLine(d, halfWidth, px)` holds 0.6 px each side and fades coverage below it, so the mean
  tone holds (`medallionLine` is the CPU mirror). For plain distances with derivatives, use the
  kit's `aaLine`.
- `medAngle` wraps to [-PI, PI); `medLobe(angle, centre, width)` is a wrapped Gaussian for
  sheens, glints and drifting arcs. Integer harmonics (`sin(n * theta)`) and even ray counts
  stay seamless across the `atan` seam; take pitch from `length(fwidth(xz)) / r`, never
  `fwidth(theta)`.
- `medCeilingLeave(wp)` is how far a mirrored ceiling gives way to the backing: near the camera
  (stage fade 0.5 to 0.9) and on a dolly out (16 to 28 units). The chunk is vertex-safe, so
  per-instance fades can run in the vertex stage (`looks/flip-disc-floor/`).
- `medallionTurn(t, period)` (TS) is a wrapped dial angle on the look clock; pass angles, not
  time, so shader floats stay small. Worked examples: `looks/guilloche-medallion/`,
  `looks/sunburst-terrazzo/`.

## Dish floors

A floor pattern seen from the default front camera collapses into a few lines at the horizon.
A dish keeps the stage flat and rises in a convex curve past `start`, so far bands face a level
camera. Convexity is the safety rule: no chord between two points above the surface dips under
it, so a camera inside never loses the stage behind it, and from outside the near side shows
only back faces, which cull (an F11 cutaway for free).

```ts
const disc = useMemo(() => createDishDiscGeometry(48, 192, 60), []); // unit polar grid, faces up
// uniforms: { uDish: { value: new Vector3(9, 31, rise) }, uDiscRadius, uFloorY }
// floor: vertexShader DISH_FLOOR_VERTEX_SHADER; anything on it: `${LOOK_GLSL_DISH}` and
// y = floorY + dishHeight(length(xz), uDish), normal = dishShear(n, xz, uDish)
```

- `dishHeight`/`dishSlope` (TS and GLSL) take the shape `(start, span, rise)`: `rise` higher
  one `span` past `start`, squared. `dishNormal(xz, dish)` is the surface normal; shade grazing
  guards against it, not world up, so the risen bands keep their contrast.
- End the disc where the floor has faded to the backing (`uDiscRadius`), which keeps the rim
  low: from outside the cut rim reads as a dish edge, so mix `dishEdgeOn(wp, up)` into the fade
  to soften its silhouette.
- Lift ribbons and props on the dish by the same height (plus 0.01 or so against the facets)
  and keep them single-sided like the floor. Worked example: `looks/sand-table/`.

## Glow slots, companion lighting and near fade (F9, F10, F11)

- **Glow slots (F9).** Flag at most two slots `glow: true` for small emissive parts (hoops,
  lamps, slots); dark presets may take them to luminance 0.30. Place them out of the headline's
  way, and leave a little headroom under 0.30 (the Theme tile retints the anchor and can land a hair
  over).
- **Companion lighting (F10).** A preset's optional `lighting` block is a whole cheap rig
  (environment, sun, ambient, a light or two) so a device reads under it even when no lower
  layer lights the scene. `companionLightingProblem(block)` is the rule set (vitest runs it over
  every bundled preset): ids start `bg3d-`, no area lights or area-paired fixtures, no free-light
  shadows, at most `COMPANION_MAX_LIGHTS` real lights beside the sun, and `normalizeLighting`
  returns it unchanged. `stageSpot(id, { azimuthDeg, elevationDeg, distance, irradiance, coneDeg,
  color | kelvin })` aims a world spot at the stage with intensity from the irradiance it lands.
  Fixtures draw unfaded, so leave out any that could cross the stage on a dolly out.
- **Near fade (F11).** Tune `stageFade(wp, near, far)` per look and use one window for every
  part: Plexus loom's threads and hoops share 0.72 to 1.0, which hides the near half of the loom
  once the camera leaves it.

## Sky dome and tiny textures (F7, F8)

An inward sphere around the stage, shaded by direction from its centre (so tessellation and
output size never show), opaque with depth writes off: floors and content paint over it.

```ts
const dome = useSkyDomeGeometry(); // radius 70: clamped past the 50-unit camera reach, inside far 1000
const mats = useLookMaterials(
  () => ({
    sky: skyDomeMaterial({
      key: "my-look/sky",
      fragmentShader: SKY, // reads varying vSkyDir (normalise it) and vWorld
      uniforms: { uPaperTex: { value: getPaperGrainTexture() } },
    }),
  }),
  [],
);
return <mesh geometry={dome} material={mats.sky} />;
```

- `skyDomeMaterial` prepends `LOOK_GLSL_SKY`; paste it yourself into parts that share the sky
  field (Wash dome's floor shadows).
- `skyPlane(dir, lift)` maps a direction onto a virtual ceiling (`dir.xz` over elevation) for
  clouds and weather. It compresses toward the horizon, so sample it through `skyFbm(p,
  length(fwidth(p)))`, whose octaves fade to their mean before a cell nears two pixels, and keep
  the horizon clear of cloud (Wash dome fades clouds in from 9 to 13 degrees).
- The dome is the whole backdrop, so the backing never shows: shade it from the `backing` prop
  (Backing tone, above) so the inspector's Backing control still drives it, not from a paper
  or sky colour slot that duplicates the backing.
- `skyZenithFade(dir)` is 1 below the zenith band and 0 at the zenith, starting lower in
  portrait frames; `skyZenithFade(dir, start, end)` takes sin(elevation) bounds.

Tiny textures are small byte images uploaded as repeat-wrapped trilinear `DataTexture`s with JS
box-filtered mips (GPU mip generation is driver-defined), built synchronously on first use: no
fetch, DOM or canvas.

- `getPaperGrainTexture()` is the shared 128 px watercolour paper, raw RGBA with mean 0.5 per
  channel: r tooth, g fibres (streaks along x), b mottle, a a second tooth. Sample it as tone
  (`texture2D(uPaperTex, uv).r - 0.5`), anchored in world or direction space and static in time.
  The mips are the pitch guard: far and grazing samples settle to the mean by themselves.
- Sample outside loops and branches so implicit derivatives stay defined. On domes blend three
  planar taps by `abs(dir)` to the fourth (`looks/wash-dome/`).
- New textures: `tinyTexture(key, () => image)` caches a `TinyImage` (1 or 4 channels,
  power-of-two sides) from `decodeTinyBytes(base64)` or seeded maths (`tinyHash` is the GLSL
  `kkHash` in JS; `periodicNoise` tiles). Pin generated bytes with a golden hash: they are export
  contract.

## Ring bands (F5)

Seamless 360 degree horizons: ranges, flats, lace and cyclorama walls round the stage axis.
`createRingBandsGeometry(bands, { segments, floor })` builds ONE mesh holding every band (an
inward-facing open cylinder `{ radius, bottom, top }`) plus an optional ground disc, laid out and
grouped far to near. Draw order is then fixed by the index buffer, never by the camera-dependent
transparent sort, so a translucent sky wall, the floor and every ridge always composite back to
front.

```ts
const geometry = useMemo(() => createRingBandsGeometry(BANDS, { floor: FLOOR }), []);
const mats = useLookMaterials(() => {
  const ring = createRingBandUniforms(); // shared: one update drives every part
  const base = { vertexShader: RING_BANDS_VERTEX_SHADER, transparent: true };
  return {
    sky: { ...base, key: "my-look/sky", fragmentShader: SKY, uniforms: { ...ring } },
    ridge: { ...base, key: "my-look/ridge", fragmentShader: RIDGE, uniforms: { ...ring } },
  };
}, []);
// material index = band input index; the floor takes bands.length
<mesh geometry={geometry} material={[mats.sky, mats.ridge, mats.ridge, mats.floor]} frustumCulled={false} />
```

- One material draws the whole stack in a single call (groups are ignored); a material array
  draws one group per band, still far to near. The floor is drawn after every band at or beyond
  its radius, so a sky wall at the floor's radius goes first.
- Bands wind inward: the default FrontSide culls a band's near half once the camera is outside
  it (F11 cutaway built in). Still multiply ridge alpha by `stageFade`.
- `uRingAngle[i]` spins band `i`; write it with `ringBandAngle(t, turns, period)`, whole signed
  turns per period, so the stack loops exactly (8 turns per 3600 s is 0.8 degrees/s).
  `uRingFade[i]` scales it, and 0 collapses its vertices: toggle layers there, never by
  remounting. The floor (band -1) never spins.
- `RING_BANDS_VERTEX_SHADER` gives `vWorld`, `vRing` (band-space position that turns with the
  band: sample silhouettes and surface noise here), `vRingBand` and `vRingFade`. Write your own
  `main()` around `ringBandVertex()` (`LOOK_GLSL_RING_VERTEX`) to add varyings.
- `LOOK_GLSL_RING_BANDS` (both stages): `ringNoise(dir, freq, seed)` is fbm on the unit circle
  (`dir = normalize(vRing.xz)`), so no angle ever seams; `ringCrest(dir, lo, hi, freq, seed)` a
  mountain profile; `ringRotate(p, angle)` drifts a surface pattern (mist wisps) against its
  band. For surface grain use 3D noise on `vRing`, never `atan` or `uv.x` (both seam).
- `LOOK_GLSL_RING_EDGE` (fragment): `ringEdge(d, hardness, bleed, bleedWidth)` morphs a ragged wet
  bleed into a crisp `aaStep` cut, `d` being world units below the crest.
- At most `RING_BANDS_MAX` (8) bands per stack. Per-band look values ride in the look's own
  `[RING_BANDS_MAX]` uniform arrays, indexed by `int(floor(vRingBand + 0.5))`
  (`looks/ink-ranges/`).
- Mount ribbon meshes with `onBeforeRender={inkRasterSync}`: the raster floor and edge pad then
  hold in the pixels actually drawn (preview canvas, picker tiles). Without it, lines narrower
  than a canvas pixel break into dashes on a canvas smaller than the export; on an export-size
  target it changes nothing.
