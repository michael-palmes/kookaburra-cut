// Dump a GLB's material names, baseColorFactor and texture bindings (node scripts/dump-glb-materials.mjs <file.glb>).
// Optional --expect-materials a,b --expect-uvs a,b --expect-skins N --expect-clip Name turn it into a post-build assertion (exit 1).
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
for (const skin of gltf.skins ?? []) {
  console.log(
    `skin ${JSON.stringify(skin.name)} joints=${skin.joints.map((j) => gltf.nodes[j].name).join(",")}`,
  );
}
for (const clip of gltf.animations ?? []) {
  const keys = Math.max(...clip.samplers.map((s) => gltf.accessors[s.input].count));
  const end = Math.max(...clip.samplers.map((s) => gltf.accessors[s.input].max?.[0] ?? 0));
  console.log(
    `clip ${JSON.stringify(clip.name)} channels=${clip.channels.length} keys=${keys} end=${end}s`,
  );
}

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? (process.argv[at + 1] ?? "") : "";
};
const problems = [];
const coloured = (gltf.meshes ?? []).filter((m) =>
  m.primitives.some((p) => "COLOR_0" in p.attributes),
);
if (flag("--expect-materials") && coloured.length) {
  problems.push(
    `vertex colours would fork materials on: ${coloured.map((m) => m.name).join(", ")}`,
  );
}
const materialNames = new Set((gltf.materials ?? []).map((m) => m.name));
for (const name of flag("--expect-materials").split(",").filter(Boolean)) {
  if (!materialNames.has(name)) problems.push(`material missing: ${name}`);
}
for (const name of flag("--expect-uvs").split(",").filter(Boolean)) {
  const bare = (gltf.meshes ?? []).flatMap((mesh) =>
    mesh.primitives
      .filter((p) => gltf.materials[p.material]?.name === name && !("TEXCOORD_0" in p.attributes))
      .map(() => mesh.name),
  );
  if (bare.length) problems.push(`no UVs for screen media on ${name}: ${bare.join(", ")}`);
}
const skins = flag("--expect-skins");
if (skins && (gltf.skins ?? []).length !== Number(skins)) {
  problems.push(`expected ${skins} skin(s), found ${(gltf.skins ?? []).length}`);
}
const clip = flag("--expect-clip");
if (clip && !(gltf.animations ?? []).some((a) => a.name === clip))
  problems.push(`clip missing: ${clip}`);
if (problems.length) {
  for (const p of problems) console.error(`[dump-glb-materials] ERROR: ${p}`);
  process.exit(1);
}
