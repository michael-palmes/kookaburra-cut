import avocadoGlbUrl from "../../assets/models/objects/avocado.glb?url";
import boomboxGlbUrl from "../../assets/models/objects/boombox.glb?url";
import lanternGlbUrl from "../../assets/models/objects/lantern.glb?url";
import waterBottleGlbUrl from "../../assets/models/objects/water-bottle.glb?url";

/** Bundled object glbs keyed by their manifest `glb` value (explicit, not a glob: a missing file fails the build, not a gate). CC0 sources + re-encode notes: src/assets/models/objects/README.md. */
export const BUILTIN_OBJECT_GLB_URLS: Record<string, string> = {
  "lantern.glb": lanternGlbUrl,
  "water-bottle.glb": waterBottleGlbUrl,
  "avocado.glb": avocadoGlbUrl,
  "boombox.glb": boomboxGlbUrl,
};
