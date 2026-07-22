import { create } from "zustand";

/** Cache-bust versions for workspace assets re-imported in place (the app icon overwrites a fixed `assets/app-icon.png`, so its webview URL never changes and the texture, WKWebView asset and mounted-slide caches all keep the old pixels). Bumping appends a `?v=N` query so a swap yields a genuinely new URL that every mounted + new consumer re-fetches. Default 0 = no suffix, so untouched assets and fresh loads (every export baseline) stay byte-identical. */
interface AssetVersionState {
  versions: Record<string, number>;
  bump: (projectId: string, rel: string) => void;
}

export function assetVersionKey(projectId: string, rel: string): string {
  return `${projectId}::${rel.replace(/^\.?\//, "")}`;
}

export const useAssetVersionStore = create<AssetVersionState>((set) => ({
  versions: {},
  bump: (projectId, rel) =>
    set((s) => {
      const key = assetVersionKey(projectId, rel);
      return { versions: { ...s.versions, [key]: (s.versions[key] ?? 0) + 1 } };
    }),
}));

/** Non-reactive read for the URL builders (ImageCard + the export preamble); both must apply the same suffix so the warm and the request match. */
export function assetVersionSuffix(projectId: string, rel: string): string {
  const v = useAssetVersionStore.getState().versions[assetVersionKey(projectId, rel)] ?? 0;
  return v > 0 ? `?v=${v}` : "";
}
