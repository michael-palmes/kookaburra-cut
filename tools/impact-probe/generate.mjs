#!/usr/bin/env node
// Writes the throwaway fixtures/impact-probe project: one scene per text motion and stamp style, each landing inside a fixed window.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "fixtures/impact-probe");

export const SCENE_MS = 1100;
export const FROM_MS = 100;
export const WINDOW_MS = 600;
export const REFERENCE_EASE = "outCubic";

const WHOLE_OR_WORD = [
  "none",
  "fade",
  "fade-up",
  "blur-in",
  "slide",
  "mask-reveal",
  "fade-scale",
  "twist-scale",
  "slam",
  "dolly",
  "chromatic",
  "line-stretch",
  "highlight-wipe",
  "rise-mask",
  "word-cycle",
  "ribbon",
  "stand-up",
  "spring-pop",
  "spotlight",
  "underline-draw",
  "weight-build",
  "glint-wipe",
  "stamp",
  "build",
  "typewriter",
];
const PER_CHARACTER = [
  "scatter-scale",
  "tracking",
  "orbit",
  "develop",
  "flip-cascade",
  "converge",
  "vapor",
];

const motion = (preset, text) =>
  `<AnimatedHeadline text="${text}" preset="${preset}" ease="${REFERENCE_EASE}" from={${FROM_MS}} to={${FROM_MS + WINDOW_MS}} fontSize={0.8} />`;

const entries = [
  ...WHOLE_OR_WORD.map((id) => ({ id, kind: "motion", jsx: motion(id, "IMPACT") })),
  ...PER_CHARACTER.map((id) => ({ id, kind: "motion", jsx: motion(id, "M") })),
  {
    id: "Stamp",
    kind: "stamp",
    jsx: `<Stamp at={${FROM_MS}}><AnimatedHeadline text="IMPACT" preset="static" fontSize={0.8} /></Stamp>`,
  },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "scenes"), { recursive: true });
const scenes = entries.map((entry, i) => {
  const stem = `${String(i + 1).padStart(2, "0")}-${entry.id.toLowerCase()}`;
  writeFileSync(
    join(OUT, "scenes", `${stem}.tsx`),
    `import { AnimatedHeadline, defineScene${entry.kind === "stamp" ? ", Stamp" : ""} } from "@kookaburra/toolkit";\n\nexport default defineScene({\n  id: "impact-${entry.id.toLowerCase()}",\n  durationMs: ${SCENE_MS},\n  Scene() {\n    return ${entry.jsx};\n  },\n});\n`,
  );
  return { file: `scenes/${stem}.tsx`, durationMs: SCENE_MS };
});
writeFileSync(
  join(OUT, "project.json"),
  `${JSON.stringify({ id: "impact-probe", name: "Impact probe", version: 2, themeId: "kookaburra-onyx", formats: ["phone-landscape"], scenes }, null, 2)}\n`,
);
writeFileSync(
  join(OUT, "manifest.json"),
  `${JSON.stringify({ sceneMs: SCENE_MS, fromMs: FROM_MS, windowMs: WINDOW_MS, ease: REFERENCE_EASE, entries: entries.map(({ id, kind }) => ({ id, kind })) }, null, 2)}\n`,
);
console.log(`impact-probe: ${entries.length} scenes in fixtures/impact-probe`);
