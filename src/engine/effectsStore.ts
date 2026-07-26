import { create } from "zustand";
import type { EffectsConfig, EffectsOverride } from "../theme/tokens";
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from "./renderSettings";

/** Which postprocessing effects the loaded project declares: the project-wide default (from the theme) plus per-scene overrides keyed by scene index. The compositor reads this store imperatively (`useEffectsStore.getState()`) inside the r3f render, the same store-backed pattern as `clock.ts`/`editorStore.ts`, because React context does not bridge into the `<Canvas>`. `sceneDefaults` holds the base stack for scenes whose sidecar swaps the theme, a full replacement of `projectDefault` for that scene index (see `sceneBaseEffects`), sparse: scenes without a theme override have no entry. A project with an empty `projectDefault`, no `overrides` and no effect-bearing `sceneDefaults` means no effects, so the compositor keeps its original byte-identical (composer-free) paths. See docs/determinism.md. */
interface EffectsState {
  projectDefault: EffectsConfig;
  overrides: Record<number, EffectsOverride>;
  sceneDefaults: Record<number, EffectsConfig>;
  /** The project's display transform (v9 · PR 8): the composer path reads it here; the r3f path applies the same values onto the renderer (RenderSettingsApplier / the export run start). ACES at 1.0 = the byte-identical default. */
  renderSettings: RenderSettings;
  setProjectEffects: (
    projectDefault: EffectsConfig,
    overrides: Record<number, EffectsOverride>,
    sceneDefaults?: Record<number, EffectsConfig>,
    renderSettings?: RenderSettings,
  ) => void;
  clearEffects: () => void;
}

export const useEffectsStore = create<EffectsState>((set) => ({
  projectDefault: {},
  overrides: {},
  sceneDefaults: {},
  renderSettings: DEFAULT_RENDER_SETTINGS,
  setProjectEffects: (
    projectDefault,
    overrides,
    sceneDefaults = {},
    renderSettings = DEFAULT_RENDER_SETTINGS,
  ) => set({ projectDefault, overrides, sceneDefaults, renderSettings }),
  clearEffects: () =>
    set({
      projectDefault: {},
      overrides: {},
      sceneDefaults: {},
      renderSettings: DEFAULT_RENDER_SETTINGS,
    }),
}));
