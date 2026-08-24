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
  /** The renderable text node; we drive it off-screen for panel-height measurement (framePanelMeasure.ts). Only the members we touch. */
  export class Text {
    text: string;
    font: string;
    fontSize: number;
    maxWidth: number;
    textAlign: string;
    /** Multiplier of the font's own line height, or "normal" (the default). */
    lineHeight: number | "normal";
    textRenderInfo?: { blockBounds: [number, number, number, number] };
    sync(callback?: () => void): void;
    dispose(): void;
  }
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
      /** Injected inline at the end of the wrapping main, after the base chain has run. */
      vertexMainOutro?: string;
      fragmentDefs?: string;
      fragmentColorTransform?: string;
      /** Full-source rewrite hook, applied before injection (part of the program cache key). */
      customRewriter?: (shaders: { vertexShader: string; fragmentShader: string }) => {
        vertexShader: string;
        fragmentShader: string;
      };
    },
  ): Material & {
    isTroikaTextMaterial?: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: troika uniforms are untyped upstream
    uniforms: Record<string, { value: any }>;
  };
}
