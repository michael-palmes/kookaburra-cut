// troika-three-text wires no type declarations (0.52.5's dist/types has no package.json entry); declare only what we import directly (drei's <Text> consumes it internally with its own typings).
declare module "troika-three-text" {
  import type { BufferGeometry, Material, Mesh, Object3DEventMap } from "three";

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
    /** Upload the SDF atlas from a `readPixels` copy instead of its canvas (the Kookaburra Cut patch): a worker's OffscreenCanvas upload is not a raw copy. */
    sdfAtlasReadback?: boolean;
  }): void;
  /** Fired when a typeset lands. */
  export interface TextEventMap extends Object3DEventMap {
    synccomplete: object;
  }
  /** The renderable text mesh: driven off-screen for panel-height measurement (framePanelMeasure.ts) and awaited per frame by the export text barrier. Only the members we touch. */
  export class Text extends Mesh<BufferGeometry, Material | Material[], TextEventMap> {
    text: string;
    font: string;
    fontSize: number;
    maxWidth: number;
    textAlign: string;
    /** Multiplier of the font's own line height, or "normal" (the default). */
    lineHeight: number | "normal";
    textRenderInfo?: { blockBounds: [number, number, number, number] };
    /** Any non-zero outline makes the `material` getter return `[outline, main]`. */
    outlineBlur: number | string;
    /** Atlas cell size; every site pins `SDF_GLYPH_SIZE` (theme/fonts.ts). */
    sdfGlyphSize: number | null;
    /** Private but stable in the pinned 0.52.5: the only quiescence signal, since `sync(cb)` drops the callback when no sync is needed (including mid-typeset). */
    _needsSync?: boolean;
    _isSyncing?: boolean;
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

/** Troika's font parser worker module, run on the main thread to vet a face before troika loads it (theme/fontVet.ts). */
declare module "troika-three-text/src/FontParser.js" {
  export interface TroikaParsedGlyph {
    index: number;
    advanceWidth: number;
    path: string;
  }
  export interface TroikaParsedFont {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineGap: number;
    capHeight: number;
    xHeight: number;
    supportsCodePoint(code: number): boolean;
    forEachGlyph(
      text: string,
      fontSize: number,
      letterSpacing: number,
      callback: (glyph: TroikaParsedGlyph, x: number, y: number, charIndex: number) => void,
    ): number;
  }
  const fontParser: { onMainThread(buffer: ArrayBuffer): Promise<TroikaParsedFont> };
  export default fontParser;
}

/** troika's font resolver factory; the wedge test drives it with a failing fallback client. */
declare module "troika-three-text/src/FontResolver.js" {
  export interface FontResolverClient {
    getFontsForString(
      text: string,
      options: object,
    ): Promise<{ fontUrls: string[]; chars: Uint8Array }>;
  }
  export function createFontResolver(
    fontParser: (buffer: ArrayBuffer) => unknown,
    client: FontResolverClient,
  ): (
    text: string,
    callback: (result: { chars: Uint8Array; fonts: unknown[] }) => void,
    options?: { fonts?: unknown[]; unicodeFontsURL?: string },
  ) => void;
}

/** The Typr build troika bundles; the cmap selection test drives `U.codeToGlyph` directly. */
declare module "troika-three-text/libs/typr.factory.js" {
  export interface TyprFont {
    cmap: Record<string, unknown> & { tables: unknown[] };
  }
  export interface Typr {
    parse(buffer: ArrayBuffer): TyprFont[];
    U: { codeToGlyph(font: TyprFont, code: number): number };
  }
  const typrFactory: () => Typr;
  export default typrFactory;
}

/** troika's typesetter factory; the font metrics parity test runs it on pre-parsed faces. */
declare module "troika-three-text/src/Typesetter.js" {
  export interface TroikaTypesetResult {
    topBaseline: number;
    blockBounds: [number, number, number, number];
  }
  export function createTypesetter(
    resolveFonts: unknown,
    bidi: unknown,
  ): {
    typeset(params: Record<string, unknown>, callback: (result: TroikaTypesetResult) => void): void;
  };
}
