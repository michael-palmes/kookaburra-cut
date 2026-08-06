import { describe, expect, it } from "vitest";

// Every bundled project's scene source, read raw so the ids can be read without importing (and running) the modules.
const sceneSources = import.meta.glob<string>("../../projects/*/scenes/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** A scene module's authored `defineScene` id; null for the persistent/helper modules that share `scenes/` without defining a scene. */
function defineSceneId(source: string): string | null {
  const match = source.match(/defineScene\(\{[\s\S]*?\bid:\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

const byProject = new Map<string, { file: string; id: string }[]>();
for (const [path, source] of Object.entries(sceneSources)) {
  const id = defineSceneId(source);
  if (!id) continue;
  const [, project, file] = path.match(/projects\/([^/]+)\/(scenes\/.+\.tsx)$/) ?? [];
  if (!project) continue;
  const scenes = byProject.get(project) ?? [];
  scenes.push({ file, id });
  byProject.set(project, scenes);
}

describe("bundled scene ids", () => {
  it("finds scenes in every bundled project", () => {
    expect(byProject.size).toBeGreaterThan(0);
  });

  it.each([...byProject.keys()].sort())(
    "%s gives every scene its own defineScene id",
    (project) => {
      const scenes = byProject.get(project) ?? [];
      const seen = new Map<string, string>();
      const clashes: string[] = [];
      for (const scene of scenes) {
        const first = seen.get(scene.id);
        if (first) clashes.push(`"${scene.id}" in ${first} and ${scene.file}`);
        else seen.set(scene.id, scene.file);
      }
      expect(clashes).toEqual([]);
    },
  );
});
