import avocadoGlbUrl from "../../assets/models/objects/avocado.glb?url";
import bitcoinCoinGlbUrl from "../../assets/models/objects/bitcoin-coin.glb?url";
import candlestickGlbUrl from "../../assets/models/objects/candlestick.glb?url";
import candlestickAmberGlbUrl from "../../assets/models/objects/candlestick-amber.glb?url";
import ethereumCoinGlbUrl from "../../assets/models/objects/ethereum-coin.glb?url";

/** Bundled object glbs keyed by their manifest `glb` value (explicit, not a glob: a missing file fails the build, not a gate). CC0 sources + re-encode notes: src/assets/models/objects/README.md. */
export const BUILTIN_OBJECT_GLB_URLS: Record<string, string> = {
  "bitcoin-coin.glb": bitcoinCoinGlbUrl,
  "ethereum-coin.glb": ethereumCoinGlbUrl,
  "avocado.glb": avocadoGlbUrl,
  "candlestick.glb": candlestickGlbUrl,
  "candlestick-amber.glb": candlestickAmberGlbUrl,
};
