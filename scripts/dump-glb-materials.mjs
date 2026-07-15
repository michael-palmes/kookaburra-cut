// Dump a GLB's material names, baseColorFactor and texture bindings (node scripts/dump-glb-materials.mjs <file.glb>).
// The exported glb is the ground truth for colour overrides: vendor blends hide colour in node
// groups the Blender dump can't read, but the glTF exporter resolves them to factors.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/dump-glb-materials.mjs <file.glb>");
  process.exit(2);
}
const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));

const hex = (f = [1, 1, 1, 1]) =>
  `#${f
    .slice(0, 3)
    .map((c) => {
      const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(Math.max(0, Math.min(1, s)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;

for (const m of gltf.materials ?? []) {
  const pbr = m.pbrMetallicRoughness ?? {};
  const f = pbr.baseColorFactor ?? [1, 1, 1, 1];
  console.log(
    `${JSON.stringify(m.name)} base=[${f.map((n) => n.toFixed(4)).join(",")}] srgb=${hex(f)} ` +
      `metal=${pbr.metallicFactor ?? 1} rough=${pbr.roughnessFactor ?? 1} ` +
      `tex=${pbr.baseColorTexture ? "base" : ""}${m.normalTexture ? "+normal" : ""}`,
  );
}
console.log(`meshes=${(gltf.meshes ?? []).length} nodes=${(gltf.nodes ?? []).length}`);
