import { type ExportPresetDoc, parseExportPreset } from "./presetSchema";
import ctv from "./presets/ctv.json";
import kookaburraMaster from "./presets/kookaburra-master.json";
import linkedinAds from "./presets/linkedin-ads.json";
import linkedinOrganic from "./presets/linkedin-organic.json";
import metaFeed from "./presets/meta-feed.json";
import metaReels from "./presets/meta-reels.json";
import reddit from "./presets/reddit.json";
import shareH264 from "./presets/share-h264.json";
import shareH265 from "./presets/share-h265.json";
import telegram from "./presets/telegram.json";
import tiktok from "./presets/tiktok.json";
import web from "./presets/web.json";
import x from "./presets/x.json";
import youtube from "./presets/youtube.json";
import youtubeShorts from "./presets/youtube-shorts.json";

/** The bundled preset lineup: the 2026 marketing set (decision 21) plus the two internal-sharing presets. Explicit imports so the structure pin asserts every bundled doc parses and resolves; array order is the modal's display order within groups. */
const RAW: [string, unknown][] = [
  ["kookaburra-master", kookaburraMaster],
  ["meta-reels", metaReels],
  ["meta-feed", metaFeed],
  ["tiktok", tiktok],
  ["youtube", youtube],
  ["youtube-shorts", youtubeShorts],
  ["linkedin-ads", linkedinAds],
  ["linkedin-organic", linkedinOrganic],
  ["x", x],
  ["reddit", reddit],
  ["telegram", telegram],
  ["ctv", ctv],
  ["web", web],
  ["share-h264", shareH264],
  ["share-h265", shareH265],
];

export const BUNDLED_EXPORT_PRESETS: ExportPresetDoc[] = RAW.flatMap(([id, raw]) => {
  const doc = parseExportPreset(raw, `bundled:${id}`);
  return doc ? [doc] : [];
});

export function findBundledPreset(id: string): ExportPresetDoc | undefined {
  return BUNDLED_EXPORT_PRESETS.find((p) => p.id === id);
}
