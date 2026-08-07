# Lighting thumbs

One-off app-screenshot bakes for the Lighting drill-in's preset cards plus the procedural
Softbox environment card: `scripts/lighting-thumb-bake.sh` renders each scene of
`fixtures/preview-lab-lighting/` through the deterministic screenshot action and downscales
to 320x180 JPEG. Not Blender (that pipeline only handles file-backed HDRIs, see
`src/assets/hdri-thumbs/`), and not wired into option-previews: re-run the script by hand
when a preset's spec or a bake scene changes, then commit the JPEGs.
