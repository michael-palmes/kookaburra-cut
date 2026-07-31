import avocadoGlbUrl from "../../assets/models/objects/avocado.glb?url";
import bitcoinCoinGlbUrl from "../../assets/models/objects/bitcoin-coin.glb?url";
import boomboxGlbUrl from "../../assets/models/objects/boombox.glb?url";
import waterBottleGlbUrl from "../../assets/models/objects/water-bottle.glb?url";

/** Bundled object glbs keyed by their manifest `glb` value (explicit, not a glob: a missing file fails the build, not a gate). CC0 sources + re-encode notes: src/assets/models/objects/README.md. */
export const BUILTIN_OBJECT_GLB_URLS: Record<string, string> = {
  "bitcoin-coin.glb": bitcoinCoinGlbUrl,
  "water-bottle.glb": waterBottleGlbUrl,
  "avocado.glb": avocadoGlbUrl,
  "boombox.glb": boomboxGlbUrl,
};
