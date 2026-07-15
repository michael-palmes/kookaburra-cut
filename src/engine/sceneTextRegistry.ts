import { create } from "zustand";

/** The mounted text of each scene, by size: text primitives register their string + resolved fontSize from inside the canvas (an effect, never the render path), and the Scene tab derives its default scene name from the largest one. Read only by UI chrome; export purity is untouched. Entries are id-keyed because scenes render into multiple targets (the compositor's A/B pair), so duplicate mounts of the same text simply coexist. */

interface SceneTextEntry {
  text: string;
  fontSize: number;
}

interface SceneTextRegistryState {
  texts: Record<number, Record<string, SceneTextEntry>>;
}

export const useSceneTextRegistry = create<SceneTextRegistryState>(() => ({ texts: {} }));

let nextId = 0;

/** Register one mounted text element; returns the unregister cleanup. */
export function registerSceneText(sceneIndex: number, text: string, fontSize: number): () => void {
  const id = `t${nextId++}`;
  useSceneTextRegistry.setState((s) => ({
    texts: { ...s.texts, [sceneIndex]: { ...s.texts[sceneIndex], [id]: { text, fontSize } } },
  }));
  return () => {
    useSceneTextRegistry.setState((s) => {
      const scene = { ...s.texts[sceneIndex] };
      delete scene[id];
      const texts = { ...s.texts };
      if (Object.keys(scene).length === 0) delete texts[sceneIndex];
      else texts[sceneIndex] = scene;
      return { texts };
    });
  };
}

/** The first line of the largest mounted text in a scene, trimmed, or null. */
export function largestSceneText(
  texts: Record<number, Record<string, SceneTextEntry>>,
  sceneIndex: number,
): string | null {
  const entries = Object.values(texts[sceneIndex] ?? {});
  let best: SceneTextEntry | null = null;
  for (const entry of entries) {
    const line = entry.text.split("\n")[0]?.trim();
    if (!line) continue;
    if (!best || entry.fontSize > best.fontSize) best = { ...entry, text: line };
  }
  return best?.text ?? null;
}

/** Hook: the scene's largest mounted text (the default scene name). */
export function useLargestSceneText(sceneIndex: number): string | null {
  return useSceneTextRegistry((s) => largestSceneText(s.texts, sceneIndex));
}
