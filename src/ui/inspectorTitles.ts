/** Stable screen names used by Scene-inspector back bars. */
const SCENE_INSPECTOR_SCREEN_TITLES: Record<string, string> = {
  text: "Text",
  objects: "Objects",
  frame: "Overlay",
  camera: "Camera",
  lighting: "Lighting",
  "lighting.environment": "Environment",
  "lighting.sun": "Sun & ambient",
  "lighting.fixtures": "Lights & fixtures",
  "lighting.shadows": "Shadows",
  "lighting.animation": "Animation",
  motion: "Timing",
  "text.edit": "Edit text",
  "style.background": "Background",
  "frame.panel": "Panel",
  "frame.icon": "Panel icon",
  "frame.decorations": "Decorations",
  "compare.edit": "Comparison",
  "chart.edit": "Chart",
  "chart.font": "Chart font",
  "chart.position": "Position",
  // One media screen, three route ids: the legacy image and video-window ids still resolve to it.
  "media.edit": "Media",
  "image.edit": "Media",
  "videoWindow.edit": "Media",
  "media.picker": "Choose media",
  "legacyImage.edit": "Image",
  "objects.picker": "Choose object",
  "device.change": "Change device",
  "device.position": "Arrange devices",
};

const CHART_SERIES_ROUTE_PREFIX = "chart.series:u16:";
const TEXT_ICON_ROUTE_PREFIX = "text.icon.";

export type ChartInspectorScreen =
  | { kind: "overview" }
  | { kind: "font" }
  | { kind: "series"; seriesId: string };

export type TextIconInspectorScreen = {
  kind: "emoji" | "image";
  itemKey: string;
};

function encodeUtf16(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index++) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function decodeUtf16(value: string): string | null {
  if (value.length % 4 !== 0) return null;
  let decoded = "";
  for (let index = 0; index < value.length; index += 4) {
    const codeUnit = value.slice(index, index + 4);
    if (!/^[0-9a-f]{4}$/i.test(codeUnit)) return null;
    decoded += String.fromCharCode(Number.parseInt(codeUnit, 16));
  }
  return decoded;
}

export function chartSeriesInspectorRoute(seriesId: string): string {
  return `${CHART_SERIES_ROUTE_PREFIX}${encodeUtf16(seriesId)}`;
}

export function chartInspectorScreenForRoute(route: string | null): ChartInspectorScreen | null {
  if (route === "chart.edit") return { kind: "overview" };
  if (route === "chart.font") return { kind: "font" };
  if (!route?.startsWith(CHART_SERIES_ROUTE_PREFIX)) return null;
  const encodedId = route.slice(CHART_SERIES_ROUTE_PREFIX.length);
  const seriesId = decodeUtf16(encodedId);
  if (seriesId === null) return null;
  return { kind: "series", seriesId };
}

export function textIconInspectorRoute(
  kind: TextIconInspectorScreen["kind"],
  itemKey: string,
): string {
  return `${TEXT_ICON_ROUTE_PREFIX}${kind}:u16:${encodeUtf16(itemKey)}`;
}

export function textIconInspectorScreenForRoute(
  route: string | null,
): TextIconInspectorScreen | null {
  const match = route?.match(/^text\.icon\.(emoji|image):u16:(.*)$/);
  if (!match) return null;
  const kind = match[1] as TextIconInspectorScreen["kind"];
  const itemKey = decodeUtf16(match[2] ?? "");
  return itemKey === null ? null : { kind, itemKey };
}

export function sceneInspectorScreenTitle(
  route: string,
  options: { deviceCount?: number } = {},
): string | undefined {
  if (route === "device") return (options.deviceCount ?? 0) > 1 ? "Devices" : "Device";
  if (chartInspectorScreenForRoute(route)?.kind === "series") return "Series";
  const textIconScreen = textIconInspectorScreenForRoute(route);
  if (textIconScreen?.kind === "emoji") return "Emoji";
  if (textIconScreen?.kind === "image") return "Image";
  return SCENE_INSPECTOR_SCREEN_TITLES[route];
}

export function namedInspectorTitle(name: string | undefined, fallback: string): string {
  return name?.trim() ? name : fallback;
}
