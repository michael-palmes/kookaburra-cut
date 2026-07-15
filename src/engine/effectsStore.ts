import { create } from "zustand";
import type { EffectsConfig, EffectsOverride } from "../theme/tokens";

/** Which postprocessing effects the loaded project declares: the project-wide default (from the theme) plus per-scene overrides keyed by scene index. The compositor reads this store imperatively (`useEffectsStore.getState()`) inside the r3f render, the same store-backed pattern as `clock.ts`/`editorStore.ts`, because React context does not bridge into the `<Canvas>`. `sceneDefaults` holds the base stack for scenes whose sidecar swaps the theme, a full replacement of `projectDefault` for that scene index (see `sceneBaseEffects`), sparse: scenes without a theme override have no entry. A project with an empty `projectDefault`, no `overrides` and no effect-bearing `sceneDefaults` means no effects, so the compositor keeps its original byte-identical (composer-free) paths. See docs/determinism.md. */
interface EffectsState {
  projectDefault: EffectsConfig;
  overrides: Record<number, EffectsOverride>;
  sceneDefaults: Record<number, EffectsConfig>;
  setProjectEffects: (
    projectDefault: EffectsConfig,
    overrides: Record<number, EffectsOverride>,
    sceneDefaults?: Record<number, EffectsConfig>,
  ) => void;
  clearEffects: () => void;
}

export const useEffectsStore = create<EffectsState>((set) => ({
  projectDefault: {},
  overrides: {},
  sceneDefaults: {},
  setProjectEffects: (projectDefault, overrides, sceneDefaults = {}) =>
    set({ projectDefault, overrides, sceneDefaults }),
  clearEffects: () => set({ projectDefault: {}, overrides: {}, sceneDefaults: {} }),
}));
