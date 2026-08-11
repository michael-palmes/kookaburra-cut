/** Stable screen names used by Scene-inspector back bars. */
const SCENE_INSPECTOR_SCREEN_TITLES: Record<string, string> = {
  text: "Text",
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
  "frame.decorations": "Decorations",
  "videoWindow.edit": "Video window",
  "compare.edit": "Comparison",
  "chart.edit": "Chart",
  "chart.font": "Chart font",
  "chart.position": "Position",
  "image.edit": "Image",
  "legacyImage.edit": "Image",
  "device.change": "Change device",
  "device.position": "Arrange devices",
};

const CHART_SERIES_ROUTE_PREFIX = "chart.series:u16:";

export type ChartInspectorScreen =
  | { kind: "overview" }
  | { kind: "font" }
  | { kind: "series"; seriesId: string };

export function chartSeriesInspectorRoute(seriesId: string): string {
  let encoded = "";
  for (let index = 0; index < seriesId.length; index++) {
    encoded += seriesId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `${CHART_SERIES_ROUTE_PREFIX}${encoded}`;
}

export function chartInspectorScreenForRoute(route: string | null): ChartInspectorScreen | null {
  if (route === "chart.edit") return { kind: "overview" };
  if (route === "chart.font") return { kind: "font" };
  if (!route?.startsWith(CHART_SERIES_ROUTE_PREFIX)) return null;
  const encodedId = route.slice(CHART_SERIES_ROUTE_PREFIX.length);
  if (encodedId.length % 4 !== 0) return null;
  let seriesId = "";
  for (let index = 0; index < encodedId.length; index += 4) {
    const codeUnit = encodedId.slice(index, index + 4);
    if (!/^[0-9a-f]{4}$/i.test(codeUnit)) return null;
    seriesId += String.fromCharCode(Number.parseInt(codeUnit, 16));
  }
  return { kind: "series", seriesId };
}

export function sceneInspectorScreenTitle(
  route: string,
  options: { deviceCount?: number } = {},
): string | undefined {
  if (route === "device") return (options.deviceCount ?? 0) > 1 ? "Devices" : "Device";
  if (chartInspectorScreenForRoute(route)?.kind === "series") return "Series";
  return SCENE_INSPECTOR_SCREEN_TITLES[route];
}

export function namedInspectorTitle(name: string | undefined, fallback: string): string {
  return name?.trim() ? name : fallback;
}
