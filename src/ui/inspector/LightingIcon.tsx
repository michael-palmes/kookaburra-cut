import type { ReactNode } from "react";

export type LightingIconName =
  | "ambient"
  | "animation"
  | "brightness"
  | "colour"
  | "direction"
  | "environment"
  | "key"
  | "lights"
  | "rotation"
  | "shadow"
  | "softness"
  | "sun"
  | "warmth";

const paths: Record<LightingIconName, ReactNode> = {
  ambient: (
    <>
      <circle cx="10" cy="10" r="5.5" />
      <path d="M5.8 13.6c2.5-1.4 5.9-1.4 8.4 0M7.2 7.2c1.7-1.1 3.9-1.1 5.6 0" />
    </>
  ),
  animation: (
    <>
      <path d="M4 14.5l3.8-4 3 2.2L16 5.5" />
      <circle cx="4" cy="14.5" r="1" />
      <circle cx="16" cy="5.5" r="1" />
    </>
  ),
  brightness: (
    <>
      <circle cx="10" cy="10" r="3" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4" />
    </>
  ),
  colour: (
    <>
      <path d="M10 3s5 5.2 5 8.4a5 5 0 01-10 0C5 8.2 10 3 10 3z" />
      <path d="M7.5 12.2c1.2 1.1 3.3 1.3 5 .2" />
    </>
  ),
  direction: (
    <>
      <circle cx="10" cy="10" r="6.2" />
      <path d="M12.8 7.2l-1.7 3.9-3.9 1.7 1.7-3.9 3.9-1.7z" />
    </>
  ),
  environment: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M4.8 8h10.4M4.8 12h10.4M10 4c2.8 3.4 2.8 8.6 0 12M10 4c-2.8 3.4-2.8 8.6 0 12" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="9" r="3.2" />
      <path d="M10.2 10.8l5.3 3.7M13 12.8l1.3-1.8M14.5 13.8l1.2-1.7" />
    </>
  ),
  lights: (
    <>
      <path d="M6.5 13.5h7M7.5 16h5" />
      <path d="M6.1 9.1a4.2 4.2 0 117.8 0c-.5 1.1-1.2 1.8-2.1 2.6H8.2c-.9-.8-1.6-1.5-2.1-2.6z" />
    </>
  ),
  rotation: (
    <>
      <path d="M15.2 7.4A6 6 0 105.5 14" />
      <path d="M15.2 3.8v3.6h-3.6" />
    </>
  ),
  shadow: (
    <>
      <circle cx="8" cy="8" r="3.5" />
      <ellipse cx="11.5" cy="14.2" rx="5" ry="1.8" />
    </>
  ),
  softness: (
    <>
      <circle cx="10" cy="10" r="3" />
      <circle cx="10" cy="10" r="6" strokeDasharray="1.8 2.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
    </>
  ),
  warmth: (
    <>
      <path d="M8.2 4.2v6.2a3.3 3.3 0 103.6 0V4.2a1.8 1.8 0 00-3.6 0z" />
      <path d="M10 7v5" />
    </>
  ),
};

export function LightingIcon({ name, size = 17 }: { name: LightingIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
