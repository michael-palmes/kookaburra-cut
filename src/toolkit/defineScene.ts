import type { SceneModule } from "./types";

/** Every scene file must `export default defineScene({...})`; an identity wrapper today, kept as the seam for future validation/registration. */
export function defineScene(cfg: SceneModule): SceneModule {
  return cfg;
}
