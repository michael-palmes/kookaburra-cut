#!/usr/bin/env node
// Writes fixtures/preview-lab-bg-<look>/ (project.json plus 11 scene pairs) from scene3d preset data.
// Usage: node scripts/gen-bg3d-preview-labs.ts <look-id> [...] | --all   (Node 24+, type stripping)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type {
  Scene3dBackgroundDef,
  Scene3dBackgroundPreset,
} from "../src/toolkit/stage/scene3d/index.ts";
import {
  scene3dPreviewCamera,
  scene3dPreviewCameraTrack,
} from "../src/toolkit/stage/scene3d/previewCamera.ts";

type Registry = {
  SCENE3D_BACKGROUNDS: Record<string, Scene3dBackgroundDef>;
  SCENE3D_BACKGROUND_IDS: string[];
  SCENE3D_BACKGROUND_PRESETS: Record<string, Scene3dBackgroundPreset[]>;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = "—";
const PRESET_IDS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];

function background(look: string, preset: Scene3dBackgroundPreset) {
  return {
    type: "scene3d",
    look,
    colors: preset.colors,
    speed: preset.speed ?? 1,
    ...(preset.params ? { params: preset.params } : {}),
    backing: { type: "color", color: preset.backing },
    preset: preset.id,
  };
}

const sceneStub = (
  label: string,
  id: string,
  durationMs: number,
) => `import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab ${DASH} ${label}. DEV-ONLY: rendered by \`pnpm kookaburra:run --action option-previews\`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "${id}",
  durationMs: ${durationMs},
  Scene() {
    return null;
  },
});
`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Writes one look's lab project and returns the JSON paths for the formatter pass. */
function writeLab(look: string, def: Scene3dBackgroundDef, presets: Scene3dBackgroundPreset[]) {
  const byId = new Map(presets.map((p) => [p.id, p]));
  const missing = PRESET_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`${look}: missing presets ${missing.join(", ")}`);
  const preset = (id: string) => byId.get(id) as Scene3dBackgroundPreset;
  const kind = scene3dPreviewCamera(def);
  const scenes = [
    {
      stem: `bg-${look}`,
      durationMs: 2000,
      clip: true,
      preset: preset("p6"),
      label: `3D background sample for "${look}" ("${preset("p6").name}")`,
    },
    {
      stem: `bg-${look}-light`,
      durationMs: 2000,
      clip: true,
      preset: preset("p1"),
      label: `light-mode 3D background sample for "${look}" ("${preset("p1").name}")`,
    },
    ...PRESET_IDS.map((id) => ({
      stem: `bgp-${look}-${id}`,
      durationMs: 1000,
      clip: false,
      preset: preset(id),
      label: `preset still for the "${look}" 3D background ("${preset(id).name}")`,
    })),
  ];
  const labId = `preview-lab-bg-${look}`;
  const dir = join(ROOT, "fixtures", labId);
  mkdirSync(join(dir, "scenes"), { recursive: true });
  const jsonPaths = [join(dir, "project.json")];
  writeFileSync(
    jsonPaths[0],
    json({
      id: labId,
      name: `Preview Lab ${DASH} bg-${look} (dev-only)`,
      version: 2,
      themeId: "kookaburra-studio-white",
      formats: ["16:9"],
      scenes: scenes.map((s) => ({ file: `scenes/${s.stem}.tsx`, durationMs: s.durationMs })),
    }),
  );
  for (const s of scenes) {
    writeFileSync(
      join(dir, "scenes", `${s.stem}.tsx`),
      sceneStub(s.label, `lab-${s.stem}`, s.durationMs),
    );
    const sidecar = join(dir, "scenes", `${s.stem}.json`);
    writeFileSync(
      sidecar,
      json({
        version: 1,
        name: s.label,
        background: background(look, s.preset),
        camera: scene3dPreviewCameraTrack(kind, s.clip),
      }),
    );
    jsonPaths.push(sidecar);
  }
  return jsonPaths;
}

async function loadRegistry(): Promise<Registry> {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@kookaburra/toolkit": join(ROOT, "src", "toolkit", "index.ts") } },
  });
  try {
    return (await server.ssrLoadModule("/src/toolkit/stage/scene3d/index.ts")) as Registry;
  } finally {
    await server.close();
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/gen-bg3d-preview-labs.ts <look-id> [...] | --all");
  process.exit(1);
}
const registry = await loadRegistry();
const looks = args.includes("--all") ? registry.SCENE3D_BACKGROUND_IDS : args;
const unknown = looks.filter((look) => !registry.SCENE3D_BACKGROUNDS[look]);
if (unknown.length > 0) {
  console.error(`unknown 3D look: ${unknown.join(", ")}`);
  process.exit(1);
}
const written = looks.flatMap((look) =>
  writeLab(
    look,
    registry.SCENE3D_BACKGROUNDS[look],
    registry.SCENE3D_BACKGROUND_PRESETS[look] ?? [],
  ),
);
// Biome owns the JSON layout (inline short arrays), so the files match `pnpm lint` byte for byte.
const format = spawnSync(
  join(ROOT, "node_modules", ".bin", "biome"),
  ["format", "--write", ...written],
  {
    cwd: ROOT,
    encoding: "utf8",
  },
);
if (format.status !== 0) {
  console.error(format.stderr || format.stdout);
  process.exit(1);
}
for (const look of looks) console.log(`wrote fixtures/preview-lab-bg-${look}/`);
