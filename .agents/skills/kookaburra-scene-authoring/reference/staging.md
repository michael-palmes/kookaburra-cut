# Staged 3D films

A staged film puts the product on a lit set: devices on a `satin` or `floor` backdrop under
`<SceneStage floorY>`, a key light with haze, real lens blur. This file is the order and the
checks that got a staged film signed off; the fields live in lighting.md, backgrounds.md,
camera.md and devices.md. The bundled `unveil` template is the worked example: read its
scenes under the app's Resources folder (`projects/unveil/scenes/`).

| To see | Unveil scene |
| --- | --- |
| The hero shot, signed off first, whose world every scene shares | `04-reveal` from bar 11 |
| A cold open with layers, lens blur and a travelling camera | `01-edge`, `02-glass` |
| One subject over several cuts: one angle, a new shot size each cut | `03-glimpses` |
| Focus held on a lifted card the viewer must read | `06-proof-1` |
| Devices that land and settle on the floor | `12-lineup` |
| Light carried across a cut | `15-hero` into `16-lockup` |

## Look first, then one world

Lit shots built before the look is agreed drift from it, and scenes built one at a time
end up in different worlds (some in a black void, some in amber haze): the film reads as a
hobby render, however good each shot is alone.

1. Agree a target frame before building any lit shot: one still the person picks (their
   reference, or a frame you render and show) with the subject, light, floor and type.
   Keep its path and compare against it every round.
2. Build one hero shot to sign-off in the app: usually the shot that carries the name. The
   person plays it in Kookaburra Cut and says it is there; a still you describe is not
   sign-off. Build nothing else lit until then.
3. Roll its world across every scene: the same sidecar `backdrop`, `background` and
   `lighting` (key, fill, haze, environment), and the same lens look in the `effects` on
   each scene's entry in `project.json` (Unveil's `lens`: bloom 0.08, halation 0.2,
   reference/project.md, Lens). Save the sidecar blocks once in
   `.kb/agents/<name>/world.json` and apply them with
   `./kb doc S merge @.kb/agents/<name>/world.json`. Keep the subject on the hero's mark
   where you can, so the key, its haze box and the floor's pools still land on it (Unveil's
   glimpses put four phones on the hero's spot). Then vary the camera, the subject and the
   key's intensity for the shot's distance (Unveil keeps the key `#ffc79a` and retunes it:
   360 for the close opening, 520 on the hero, 1200 for the wide line-up).
4. Check each scene beside the hero: one sheet of settled frames, the hero's included
   (`./kb capture --frames <hero>@<sec>,<scene>@<sec>,... --sheet`). Fix any scene
   that is flatter, brighter, a different colour or off the floor. Text cards between staged
   shots stay on the stage too (DESIGN.md, Backgrounds).

## The product is the software

Shots of the phone itself (its lenses, buttons, a bare edge) read as a hardware ad when what
shipped is the app; light recordings in a dark film glare as a wall of cream; a screen
framed edge to edge crops words at the frame and stops reading as a device.

- Every product shot shows the app working on screen: a recording playing, or a screenshot
  with something moving on it (a tap, a `ScreenRegion` lift). Hardware detail gets a shot
  only when the hardware is what shipped. A silhouette cold open is fine when the screen
  wakes before it ends (Unveil's `01-edge` and `02-glass`, two bars).
- A dark film takes dark-mode recordings and screenshots, so ask for them in the brief
  (DESIGN.md, Brief first). A light screen becomes the brightest thing in a dark frame and
  pulls the eye off everything else. Unveil's samples are all `*-dark-phone` recordings.
- Frame on the part of the screen that moves (the card being added, the toast, the list
  reordering), with the phone's dark edge and the stage still in frame. To show more of
  the screen, pull back; never fill the frame with it.

## The staged-shot checklist

A phone floating on black, lit broad and flat, shot as a 6 cm macro with a few centimetres
of drift, reads as a low quality rasterised render. Capture each staged shot and check:

- [ ] **Layers.** Something behind (haze, smoke, dust bokeh, a pool of light on the floor),
      the subject, and sometimes something in front (another device, the floor's near edge
      in blur). A subject on flat black has no depth.
- [ ] **A motivated key and rim.** One key from a side you could point to (a spot with
      `castShadow`), a rim that draws the edge against the dark (an area light in the
      `dark-rim` pattern, or a narrow `environment.strips` line from behind,
      reference/lighting.md, Environment strips), and `ambient` at or near 0 (Unveil: 0).
      Broad even light flattens metal and glass.
- [ ] **Real lens blur from a little way off.** `dof` mode `lens`, the camera 2.7 to 4.5
      units (15 to 25 cm) from the subject on a long lens (`fov` 16 to 18) at `fStop` 4 to
      5.6, so the background melts into round bokeh. At about 1 unit (a 6 cm macro) the
      lens blur saturates and reads as a smear (camera.md, Depth of field).
- [ ] **A travelling camera.** Half a unit or more a shot, in one direction (camera.md,
      Moves with a reason). A few centimetres of drift reads as a frozen frame.
- [ ] **Atmosphere.** Haze or soft smoke in the key's beam (`volumetric` with `haze` and
      `smoke`), its `box` around where the light falls and clear of the titles.
- [ ] **Devices on a floor stand flat.** `placement.ground: true` with no lean or roll
      (`rotationDeg` `[0, yaw, 0]`), so the reflection meets the device. A few degrees of
      lean stands it on one corner and its reflection never touches it (Unveil's hero
      failed at `[-8, 34, 4]` and passed at `[0, 42, 0]`).
- [ ] **Arrivals land and settle.** A device that enters comes down onto its mark on a
      decelerating ease, its tilt easing out after it lands, with shadow and reflection
      meeting it. Never slide one in sideways in mid-air: with nothing under it, it reads
      as artificial. Unveil's `12-lineup` drops a phone onto its mark each beat, about 3.5
      units in 0.75 s, then eases out a few degrees of tilt over the next half second.
- [ ] **A floor between mirror and matte.** Roughness, not reflection blur, is what makes a
      surface: at `roughness` 0.12 even a heavily blurred reflection still read as a
      mirror, and 0.45 burned out the lit corner. Unveil's `satin`: `roughness` 0.35,
      `specular` 0.3, `reflection` `{ "strength": 1.3, "blur": 24, "contact": 0.75 }`, so
      the phone's rim reads as a soft shape and mirrored text stays illegible. For a
      sharper floor, try `blur` 16 and `roughness` 0.22.
- [ ] **Dust dim and boxed.** `dust` with a `min`/`max` box around the lit area, a few
      hundred motes and a low `gain` (Unveil's hero: 380 at 0.45; the close opening: 280
      larger motes at 0.26, so they blur into smooth bokeh). At `gain` 1, or spread over the
      dark, motes read as stars.

## Render settings

Dark staged device films shimmer along metal edges, alias and band in haze at the default
settings, and blur-based text presets ghost. Start from Unveil's `project.json` `render`:

```json
"render": {
  "toneMapping": "neutral",
  "antialias": "smaa",
  "supersample": 16,
  "dither": true,
  "specularAA": true,
  "textBlur": "optical"
}
```

- `neutral` keeps warm metal and product colours true (`aces` whitens gold); `smaa`
  smooths hot highlights after the tone map; `dither` stops near-black haze and bloom
  banding; `specularAA` stops device metal sparkling in motion (lighting.md, Display
  transform).
- `textBlur: "optical"`: `tracking`, `slam`, `develop` and `vapor` soften each glyph's edge,
  so overlapping letters ghost as stacked copies. Optical turns that into a true defocus
  (text.md). Without it, never use those presets in a launch film; pick `fade-up` or
  `mask-reveal` instead.
- `supersample` 16 exports take about 2.4 times as long as at 4 (8 is the middle, about
  1.5 times); a 60 s 4K film took about half an hour. Iterate with captures and
  `./kb preview`, export once, and keep the Mac unlocked and awake (export.md). Samples
  can't calm a tiny hot highlight: fix the light first (lighting.md).
