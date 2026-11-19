import { isDefaultMotionBlur } from "../engine/motionBlur";
import {
  DEFAULT_EXPOSURE,
  DEFAULT_TONE_MAPPING,
  type RenderSettings,
} from "../engine/renderSettings";

const DEFAULTS: Record<string, unknown> = {
  toneMapping: DEFAULT_TONE_MAPPING,
  exposure: DEFAULT_EXPOSURE,
};

/** The manifest's `render` block for these settings, or undefined when every key is at its default, so an untouched project never carries the block. */
export function renderBlockFor(settings: RenderSettings): Record<string, unknown> | undefined {
  const { motionBlur, exactText, textBlur, ...display } = settings;
  const block: Record<string, unknown> = {
    ...display,
    ...(isDefaultMotionBlur(motionBlur) ? {} : { motionBlur }),
    ...(exactText ? { exactText } : {}),
    ...(textBlur ? { textBlur } : {}),
  };
  for (const [key, value] of Object.entries(block)) {
    if (value === undefined) delete block[key];
  }
  const isDefault = Object.entries(block).every(([key, value]) => DEFAULTS[key] === value);
  return isDefault ? undefined : block;
}
