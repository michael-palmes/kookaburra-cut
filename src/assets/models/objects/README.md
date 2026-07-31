# Bundled starter objects

CC0 models from the Khronos glTF-Sample-Assets repository
(https://github.com/KhronosGroup/glTF-Sample-Assets), each re-encoded here with
`gltf-transform optimize --compress false --texture-compress webp --texture-size 1024`
(no Draco/meshopt, webp textures only: the offline deterministic-export rule in
`src/toolkit/objects/schema.ts`). Committed, unlike the licensed device models:
CC0 needs no gitignore split.

| File | Source model | Licence | Author |
| --- | --- | --- | --- |
| bitcoin-coin.glb | Original project asset | Project-owned | Authored for Kookaburra Cut (THREE.GLTFExporter) |
| water-bottle.glb | WaterBottle | CC0 1.0 | Public domain (2017) |
| avocado.glb | Avocado | CC0 1.0 | Public domain (2017) |
| boombox.glb | BoomBox | CC0 1.0 | Public domain (2017) |

Modifications: texture downscale to 1024 + webp, mesh weld/prune (geometry unchanged).
