# Bundled environment maps

All CC0 from Poly Haven (https://polyhaven.com/license): no attribution required,
commercial use and redistribution permitted. 1k Radiance `.hdr`, converted from the
source EXRs by `pnpm assets:hdri` (headless Blender; see scripts/prepare-hdri.sh).
Lighting-only IBL: PMREM prefilters away the detail, so 1k is the correct and final
resolution, and the maps are never visible as backgrounds.

CONVERSION IS A DETERMINISM BOUNDARY: re-converting a shipped file through a different
Blender silently rebases every project that uses it. The script skips existing outputs;
`KOOKABURRA_HDRI_FORCE=1` is a deliberate full rebase.

| Bundled id | Poly Haven slug | Converted with |
|---|---|---|
| kookaburra:ferndale-studio | ferndale_studio_07 | Blender 4.x (v8 · M1) |
| kookaburra:monochrome-studio | monochrome_studio_01 | Blender 4.x (v8 · M1) |
| kookaburra:story-studio | story_studio_01 | Blender 4.x (v8 · M1) |
| kookaburra:warehouse | empty_warehouse_01 | Blender 5.1.2 (v9 · PR 3) |
| kookaburra:night-city | shanghai_bund | Blender 5.1.2 (v9 · PR 3) |
| kookaburra:sunset | venice_sunset | Blender 5.1.2 (v9 · PR 3) |
| kookaburra:cyclorama | cyclorama_hard_light | Blender 5.1.2 (v9 · PR 3) |
| kookaburra:dawn | kiara_1_dawn | Blender 5.1.2 (v9 · PR 3) |
| kookaburra:interior | lebombo | Blender 5.1.2 (v9 · PR 3) |

The picker thumbnails in `../hdri-thumbs/` are UI-only JPEGs (scripts/hdri-thumb.py),
never an export input, and safe to regenerate at any time.
