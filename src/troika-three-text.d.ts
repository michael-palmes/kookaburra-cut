// troika-three-text ships no type declarations; declare only what we import directly (drei's <Text> consumes it internally with its own typings).
declare module "troika-three-text" {
  import type { Material } from "three";

  export function preloadFont(
    options: { font?: string; characters?: string | string[]; sdfGlyphSize?: number },
    callback: () => void,
  ): void;
  /** Must be called before the first font request (ignored with a warning after). */
  export function configureTextBuilder(config: {
    useWorker?: boolean;
    sdfGlyphSize?: number;
    /** Global fallback face tried after the per-Text font; the unused slot the symbols fallback occupies. */
    defaultFontURL?: string;
    /** Base URL for the unicode-font-resolver data; we pin it to a dead same-origin path. */
    unicodeFontsURL?: string;
  }): void;
  /** Derives troika's glyph-rendering material from a base material; the stagger material chains a second derivation on top of this one. Untyped upstream. */
  export function createTextDerivedMaterial(baseMaterial: Material): Material & {
    isTroikaTextMaterial: true;
    // biome-ignore lint/suspicious/noExplicitAny: troika uniforms are untyped upstream
    uniforms: Record<string, { value: any }>;
  };
}

declare module "troika-three-utils" {
  import type { Material } from "three";

  /** Injects custom shader chunks into an existing material. Options subset we use. */
  export function createDerivedMaterial(
    baseMaterial: Material,
    options: {
      chained?: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: three accepts flat arrays for uniform arrays
      uniforms?: Record<string, { value: any }>;
      vertexDefs?: string;
      vertexTransform?: string;
      fragmentDefs?: string;
      fragmentColorTransform?: string;
    },
  ): Material & {
    isTroikaTextMaterial?: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: troika uniforms are untyped upstream
    uniforms: Record<string, { value: any }>;
  };
}
