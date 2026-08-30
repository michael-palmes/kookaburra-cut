/** Website scene content: field-level parsing, secure URL normalisation, capture freshness and shared frame geometry. The live native view and deterministic WebGL poster both consume this pure contract. */

export type SceneWebsiteViewportPreset = "desktop" | "tablet" | "mobile" | "custom";
export type SceneWebsiteOrientation = "landscape" | "portrait";
export type SceneWebsiteAppearance = "match-theme" | "light" | "dark";
export type SceneWebsiteShadow = "none" | "soft" | "strong";
export type SceneWebsiteCaptureSource = "snapshot" | "image";

export interface SceneDocWebsiteViewport {
  preset?: SceneWebsiteViewportPreset;
  orientation?: SceneWebsiteOrientation;
  width?: number;
  height?: number;
  zoom?: number;
}

export interface SceneDocWebsiteFrame {
  appearance?: SceneWebsiteAppearance;
  cornerRadius?: number;
  shadow?: SceneWebsiteShadow;
}

export interface SceneDocWebsiteCapture {
  src?: string;
  width?: number;
  height?: number;
  source?: SceneWebsiteCaptureSource;
  sourceOrigin?: string;
  fingerprint?: string;
}

export interface SceneDocWebsite {
  url?: string;
  requestedOrigins?: string[];
  viewport?: SceneDocWebsiteViewport;
  frame?: SceneDocWebsiteFrame;
  position?: [number, number];
  size?: number;
  capture?: SceneDocWebsiteCapture;
}

export interface WebsiteUrlInfo {
  url: string;
  origin: string;
  loopback: boolean;
}

export interface ResolvedSceneWebsite {
  url: string | null;
  origin: string | null;
  loopback: boolean;
  requestedOrigins: string[];
  viewport: {
    preset: SceneWebsiteViewportPreset;
    orientation: SceneWebsiteOrientation;
    width: number;
    height: number;
    zoom: number;
  };
  frame: {
    appearance: SceneWebsiteAppearance;
    cornerRadius: number;
    shadow: SceneWebsiteShadow;
  };
  position: [number, number];
  size: number;
  capture: SceneDocWebsiteCapture | null;
  fingerprint: string;
  captureStale: boolean;
}

export const WEBSITE_VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900, orientation: "landscape" },
  tablet: { width: 1024, height: 768, orientation: "landscape" },
  mobile: { width: 390, height: 844, orientation: "portrait" },
} as const;

export const WEBSITE_DEFAULTS = {
  viewportPreset: "desktop" as SceneWebsiteViewportPreset,
  orientation: "landscape" as SceneWebsiteOrientation,
  zoom: 1,
  appearance: "match-theme" as SceneWebsiteAppearance,
  cornerRadius: 14,
  shadow: "soft" as SceneWebsiteShadow,
  size: 0.72,
} as const;

export const WEBSITE_VIEWPORT_WIDTH_MIN = 320;
export const WEBSITE_VIEWPORT_WIDTH_MAX = 3840;
export const WEBSITE_VIEWPORT_HEIGHT_MIN = 240;
export const WEBSITE_VIEWPORT_HEIGHT_MAX = 2160;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasExplicitPort(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return false;
  const authority = value
    .slice(schemeEnd + 3)
    .split(/[/?#]/, 1)[0]
    .split("@")
    .at(-1);
  if (!authority) return false;
  if (authority.startsWith("[")) return /^\[[^\]]+\]:\d+$/.test(authority);
  return /:\d+$/.test(authority);
}

function normaliseWebsiteUrlWithPolicy(
  value: string,
  requireExplicitLoopbackPort: boolean,
): WebsiteUrlInfo | null {
  const authored = value.trim();
  if (!authored) return null;
  let parsed: URL;
  try {
    parsed = new URL(authored);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
  if (loopback && requireExplicitLoopbackPort && !hasExplicitPort(authored)) return null;
  return { url: authored, origin: parsed.origin, loopback };
}

/** Apply the authored top-level URL policy. Null is safe failure and never triggers a request. */
export function normaliseWebsiteUrl(value: string): WebsiteUrlInfo | null {
  return normaliseWebsiteUrlWithPolicy(value, true);
}

/** Normalise a canonical origin, whose default port may have been removed by URL serialisation. */
export function normaliseWebsiteOrigin(value: string): WebsiteUrlInfo | null {
  return normaliseWebsiteUrlWithPolicy(value, false);
}

function parseRequestedOrigins(raw: unknown, source: string): string[] | undefined {
  if (!Array.isArray(raw)) {
    console.warn(`[sceneDoc] ${source}: website.requestedOrigins isn't an array, dropped`);
    return undefined;
  }
  const origins: string[] = [];
  for (const value of raw) {
    const info = typeof value === "string" ? normaliseWebsiteOrigin(value) : null;
    if (!info) {
      console.warn(
        `[sceneDoc] ${source}: website.requestedOrigins contains an unsafe origin, dropped`,
      );
      continue;
    }
    if (!origins.includes(info.origin)) origins.push(info.origin);
  }
  return origins;
}

function parseViewport(raw: unknown, source: string): SceneDocWebsiteViewport | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: website.viewport isn't an object, dropped`);
    return undefined;
  }
  const out: SceneDocWebsiteViewport = {};
  if (
    raw.preset === "desktop" ||
    raw.preset === "tablet" ||
    raw.preset === "mobile" ||
    raw.preset === "custom"
  ) {
    out.preset = raw.preset;
  } else if (raw.preset !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.viewport.preset is unknown, dropped`);
  }
  if (raw.orientation === "landscape" || raw.orientation === "portrait") {
    out.orientation = raw.orientation;
  } else if (raw.orientation !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.viewport.orientation is invalid, dropped`);
  }
  for (const key of ["width", "height", "zoom"] as const) {
    if (finiteNumber(raw[key])) out[key] = raw[key];
    else if (raw[key] !== undefined) {
      console.warn(`[sceneDoc] ${source}: website.viewport.${key} isn't a finite number, dropped`);
    }
  }
  return out;
}

function parseFrame(raw: unknown, source: string): SceneDocWebsiteFrame | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: website.frame isn't an object, dropped`);
    return undefined;
  }
  const out: SceneDocWebsiteFrame = {};
  if (raw.appearance === "match-theme" || raw.appearance === "light" || raw.appearance === "dark") {
    out.appearance = raw.appearance;
  } else if (raw.appearance !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.frame.appearance is invalid, dropped`);
  }
  if (finiteNumber(raw.cornerRadius)) out.cornerRadius = raw.cornerRadius;
  else if (raw.cornerRadius !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.frame.cornerRadius isn't a number, dropped`);
  }
  if (raw.shadow === "none" || raw.shadow === "soft" || raw.shadow === "strong") {
    out.shadow = raw.shadow;
  } else if (raw.shadow !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.frame.shadow is invalid, dropped`);
  }
  return out;
}

function safeCapturePath(value: string): boolean {
  return (
    value.startsWith("assets/") &&
    !value.startsWith("assets//") &&
    !value.split("/").includes("..") &&
    !value.includes("\\")
  );
}

function parseCapture(raw: unknown, source: string): SceneDocWebsiteCapture | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: website.capture isn't an object, dropped`);
    return undefined;
  }
  const out: SceneDocWebsiteCapture = {};
  if (typeof raw.src === "string" && safeCapturePath(raw.src)) out.src = raw.src;
  else if (raw.src !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.capture.src isn't a safe asset path, dropped`);
  }
  for (const key of ["width", "height"] as const) {
    if (finiteNumber(raw[key])) out[key] = raw[key];
    else if (raw[key] !== undefined) {
      console.warn(`[sceneDoc] ${source}: website.capture.${key} isn't a number, dropped`);
    }
  }
  if (raw.source === "snapshot" || raw.source === "image") out.source = raw.source;
  else if (raw.source !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.capture.source is invalid, dropped`);
  }
  if (typeof raw.sourceOrigin === "string") {
    const info = normaliseWebsiteOrigin(raw.sourceOrigin);
    if (info) out.sourceOrigin = info.origin;
    else console.warn(`[sceneDoc] ${source}: website.capture.sourceOrigin is unsafe, dropped`);
  } else if (raw.sourceOrigin !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.capture.sourceOrigin isn't a string, dropped`);
  }
  if (typeof raw.fingerprint === "string" && raw.fingerprint.startsWith("v1:")) {
    out.fingerprint = raw.fingerprint;
  } else if (raw.fingerprint !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.capture.fingerprint is invalid, dropped`);
  }
  return out;
}

/** Field-level parser: malformed fields drop independently and a malformed block drops whole. */
export function parseSceneWebsite(raw: unknown, source: string): SceneDocWebsite | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: website isn't an object, dropped`);
    return undefined;
  }
  const out: SceneDocWebsite = {};
  if (typeof raw.url === "string") {
    const info = normaliseWebsiteUrl(raw.url);
    if (info) out.url = info.url;
    else console.warn(`[sceneDoc] ${source}: website.url is unsafe, dropped`);
  } else if (raw.url !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.url isn't a string, dropped`);
  }
  if (raw.requestedOrigins !== undefined) {
    const origins = parseRequestedOrigins(raw.requestedOrigins, source);
    if (origins) out.requestedOrigins = origins;
  }
  if (raw.viewport !== undefined) {
    const viewport = parseViewport(raw.viewport, source);
    if (viewport) out.viewport = viewport;
  }
  if (raw.frame !== undefined) {
    const frame = parseFrame(raw.frame, source);
    if (frame) out.frame = frame;
  }
  if (
    Array.isArray(raw.position) &&
    finiteNumber(raw.position[0]) &&
    finiteNumber(raw.position[1])
  ) {
    out.position = [raw.position[0], raw.position[1]];
  } else if (raw.position !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.position isn't [x, y], dropped`);
  }
  if (finiteNumber(raw.size)) out.size = raw.size;
  else if (raw.size !== undefined) {
    console.warn(`[sceneDoc] ${source}: website.size isn't a finite number, dropped`);
  }
  if (raw.capture !== undefined) {
    const capture = parseCapture(raw.capture, source);
    if (capture) out.capture = capture;
  }
  return out;
}

function orientedDimensions(
  width: number,
  height: number,
  orientation: SceneWebsiteOrientation,
): { width: number; height: number } {
  const landscape = width >= height;
  if ((orientation === "landscape") === landscape) return { width, height };
  return { width: height, height: width };
}

interface FingerprintInput {
  url: string | null;
  viewport: ResolvedSceneWebsite["viewport"];
  frame: ResolvedSceneWebsite["frame"];
}

/** Stable, inspectable v1 fingerprint. Position and display size intentionally stay out. */
export function websiteCaptureFingerprint(input: FingerprintInput): string {
  return `v1:${JSON.stringify([
    input.url ?? "",
    input.viewport.preset,
    input.viewport.orientation,
    input.viewport.width,
    input.viewport.height,
    input.viewport.zoom,
    input.frame.appearance,
    input.frame.cornerRadius,
    input.frame.shadow,
  ])}`;
}

/** Resolve the authored block into bounded values. Null preserves the legacy path. */
export function resolveSceneWebsite(
  doc: { website?: SceneDocWebsite } | undefined,
): ResolvedSceneWebsite | null {
  const raw = doc?.website;
  if (!raw) return null;
  const preset = raw.viewport?.preset ?? WEBSITE_DEFAULTS.viewportPreset;
  const natural =
    preset === "custom"
      ? {
          width: clamp(
            Math.round(raw.viewport?.width ?? WEBSITE_VIEWPORT_PRESETS.desktop.width),
            WEBSITE_VIEWPORT_WIDTH_MIN,
            WEBSITE_VIEWPORT_WIDTH_MAX,
          ),
          height: clamp(
            Math.round(raw.viewport?.height ?? WEBSITE_VIEWPORT_PRESETS.desktop.height),
            WEBSITE_VIEWPORT_HEIGHT_MIN,
            WEBSITE_VIEWPORT_HEIGHT_MAX,
          ),
        }
      : WEBSITE_VIEWPORT_PRESETS[preset];
  const defaultOrientation =
    preset === "custom"
      ? natural.width >= natural.height
        ? "landscape"
        : "portrait"
      : WEBSITE_VIEWPORT_PRESETS[preset].orientation;
  const orientation = raw.viewport?.orientation ?? defaultOrientation;
  const oriented = orientedDimensions(natural.width, natural.height, orientation);
  const dimensions =
    preset === "custom"
      ? {
          width: clamp(oriented.width, WEBSITE_VIEWPORT_WIDTH_MIN, WEBSITE_VIEWPORT_WIDTH_MAX),
          height: clamp(oriented.height, WEBSITE_VIEWPORT_HEIGHT_MIN, WEBSITE_VIEWPORT_HEIGHT_MAX),
        }
      : oriented;
  const urlInfo = raw.url ? normaliseWebsiteUrl(raw.url) : null;
  const requestedOrigins = [...(raw.requestedOrigins ?? [])];
  if (urlInfo && !requestedOrigins.includes(urlInfo.origin)) requestedOrigins.push(urlInfo.origin);
  const position = raw.position ?? [0, 0];
  const capture = raw.capture?.src ? raw.capture : null;
  const base = {
    url: urlInfo?.url ?? null,
    origin: urlInfo?.origin ?? null,
    loopback: urlInfo?.loopback ?? false,
    requestedOrigins,
    viewport: {
      preset,
      orientation,
      width: dimensions.width,
      height: dimensions.height,
      zoom: clamp(raw.viewport?.zoom ?? WEBSITE_DEFAULTS.zoom, 0.5, 2),
    },
    frame: {
      appearance: raw.frame?.appearance ?? WEBSITE_DEFAULTS.appearance,
      cornerRadius: clamp(raw.frame?.cornerRadius ?? WEBSITE_DEFAULTS.cornerRadius, 0, 32),
      shadow: raw.frame?.shadow ?? WEBSITE_DEFAULTS.shadow,
    },
    position: [clamp(position[0], -1.5, 1.5), clamp(position[1], -1.5, 1.5)] as [number, number],
    size: clamp(raw.size ?? WEBSITE_DEFAULTS.size, 0.05, 1.5),
    capture,
  };
  const fingerprint = websiteCaptureFingerprint(base);
  return {
    ...base,
    fingerprint,
    captureStale: !!capture && capture.fingerprint !== fingerprint,
  };
}

interface RectCS {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneWebsiteFrameLayout {
  window: RectCS;
  toolbar: RectCS;
  page: RectCS;
  originBar: RectCS;
  controls: { x: number; y: number; radius: number; gap: number };
  radius: number;
  toolbarHeight: number;
}

/** Shared world-space geometry. The native overlay converts `page` only into app pixels. */
export function sceneWebsiteLayout(
  website: ResolvedSceneWebsite,
  frame: { width: number; height: number },
): SceneWebsiteFrameLayout {
  const width = website.size * frame.width;
  const pageHeight = width * (website.viewport.height / website.viewport.width);
  const toolbarHeight = width * (52 / website.viewport.width);
  const height = pageHeight + toolbarHeight;
  const x = (website.position[0] * frame.width) / 2;
  const y = (website.position[1] * frame.height) / 2;
  const top = y + height / 2;
  const radius = width * (website.frame.cornerRadius / website.viewport.width);
  const controlRadius = toolbarHeight * 0.105;
  const controlGap = toolbarHeight * 0.42;
  const controlsX = x - width / 2 + toolbarHeight * 0.56;
  const toolbar = { x, y: top - toolbarHeight / 2, width, height: toolbarHeight };
  const page = { x, y: y - toolbarHeight / 2, width, height: pageHeight };
  const originLeft = controlsX + controlGap * 2 + controlRadius + toolbarHeight * 0.26;
  const originRight = x + width / 2 - toolbarHeight * 0.25;
  return {
    window: { x, y, width, height },
    toolbar,
    page,
    originBar: {
      x: (originLeft + originRight) / 2,
      y: toolbar.y,
      width: Math.max(toolbarHeight, originRight - originLeft),
      height: toolbarHeight * 0.58,
    },
    controls: { x: controlsX, y: toolbar.y, radius: controlRadius, gap: controlGap },
    radius,
    toolbarHeight,
  };
}
