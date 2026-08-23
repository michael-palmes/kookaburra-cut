import type { ReactNode } from "react";

/** The theme editor's line-icon set: one 20x20 stroke grid shared by the section nav, the option chips and the row labels, so no toggle or option control in this window ships text-only (design rule 10). */

export type ThemeEditorIconName =
  | "identity"
  | "colours"
  | "gradients"
  | "typography"
  | "motion"
  | "stage"
  | "lighting"
  | "effects"
  | "light"
  | "dark"
  | "tag"
  | "order"
  | "hidden"
  | "visible"
  | "category"
  | "label"
  | "chart"
  | "add"
  | "remove"
  | "linear"
  | "radial"
  | "angle"
  | "headline"
  | "body"
  | "scale"
  | "duration"
  | "ease"
  | "radius"
  | "warning"
  | "save"
  | "revert"
  | "specimen";

const paths: Record<ThemeEditorIconName, ReactNode> = {
  identity: (
    <>
      <circle cx="10" cy="7.5" r="3" />
      <path d="M4.5 16.2c1.1-2.4 3.1-3.6 5.5-3.6s4.4 1.2 5.5 3.6" />
    </>
  ),
  colours: (
    <>
      <path d="M10 3s5 5.5 5 8.5a5 5 0 01-10 0C5 8.5 10 3 10 3z" />
      <path d="M7.4 12.4c1.3 1.1 3.4 1.3 5.2.1" />
    </>
  ),
  gradients: (
    <>
      <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
      <path d="M3.5 12.5l13-6M3.5 15l13-6" opacity="0.6" />
    </>
  ),
  typography: (
    <>
      <path d="M4 5.5V4h12v1.5M10 4v12M7.5 16h5" />
    </>
  ),
  motion: (
    <>
      <path d="M3.5 14.5c3.5 0 4-9 7-9s3.5 4.5 6 4.5" />
      <circle cx="16.5" cy="10" r="1.2" />
    </>
  ),
  stage: (
    <>
      <path d="M3.5 12.5h13" />
      <path d="M5.5 12.5c0-3.4 2-5.5 4.5-5.5s4.5 2.1 4.5 5.5" />
      <path d="M3.5 12.5L2.5 16h15l-1-3.5" />
    </>
  ),
  lighting: (
    <>
      <path d="M6.5 13.5h7M7.5 16h5" />
      <path d="M6.1 9.1a4.2 4.2 0 117.8 0c-.5 1.1-1.2 1.8-2.1 2.6H8.2c-.9-.8-1.6-1.5-2.1-2.6z" />
    </>
  ),
  effects: (
    <>
      <path d="M10 3.5l1.5 3.6 3.6 1.4-3.6 1.5L10 13.6 8.5 10 4.9 8.5l3.6-1.4z" />
      <path d="M14.8 13.2l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" />
    </>
  ),
  light: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
    </>
  ),
  dark: <path d="M15.5 11.8A6.2 6.2 0 018 4.3a6.2 6.2 0 107.5 7.5z" />,
  tag: (
    <>
      <path d="M3.8 9.4V4.2h5.2l7 7-5.2 5.2-7-7z" />
      <circle cx="6.6" cy="6.9" r="1.1" />
    </>
  ),
  order: (
    <>
      <path d="M4 5.5h12M4 10h9M4 14.5h6" />
    </>
  ),
  hidden: (
    <>
      <path d="M3 10s2.9-4.5 7-4.5c1.3 0 2.5.5 3.5 1.1M17 10s-2.9 4.5-7 4.5c-1.4 0-2.6-.5-3.6-1.2" />
      <path d="M4 4l12 12" />
    </>
  ),
  visible: (
    <>
      <path d="M3 10s2.9-4.5 7-4.5S17 10 17 10s-2.9 4.5-7 4.5S3 10 3 10z" />
      <circle cx="10" cy="10" r="1.8" />
    </>
  ),
  category: (
    <>
      <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.4" />
      <rect x="11" y="3.5" width="5.5" height="5.5" rx="1.4" />
      <rect x="3.5" y="11" width="5.5" height="5.5" rx="1.4" />
      <rect x="11" y="11" width="5.5" height="5.5" rx="1.4" />
    </>
  ),
  label: (
    <>
      <rect x="3" y="6" width="14" height="8" rx="2" />
      <path d="M6 10h8" />
    </>
  ),
  chart: (
    <>
      <path d="M4 16V9M10 16V5M16 16v-4M3 16.5h14" />
    </>
  ),
  add: <path d="M10 4.5v11M4.5 10h11" />,
  remove: <path d="M4.5 10h11" />,
  linear: (
    <>
      <rect x="3.5" y="5" width="13" height="10" rx="1.8" />
      <path d="M3.5 15L16.5 5" opacity="0.7" />
    </>
  ),
  radial: (
    <>
      <circle cx="10" cy="10" r="6.3" />
      <circle cx="10" cy="10" r="3" opacity="0.7" />
    </>
  ),
  angle: (
    <>
      <path d="M4 15.5h12" />
      <path d="M4 15.5L14 5.5" />
      <path d="M9.5 15.5a5.5 5.5 0 00-1.6-3.9" />
    </>
  ),
  headline: (
    <>
      <path d="M4 15V5M10 15V5M4 10h6" />
      <path d="M13 15V8.5M13 15h3.5" />
    </>
  ),
  body: (
    <>
      <path d="M4 5.5h12M4 9h12M4 12.5h12M4 16h7" />
    </>
  ),
  scale: (
    <>
      <path d="M4 16V6.5M4 16h9" />
      <path d="M4 16L16 4" />
      <path d="M11.5 4H16v4.5" />
    </>
  ),
  duration: (
    <>
      <circle cx="10" cy="10.5" r="6" />
      <path d="M10 7v3.5l2.4 1.6M8 3h4" />
    </>
  ),
  ease: (
    <>
      <path d="M3.5 15.5C8 15.5 8.5 4.5 16.5 4.5" />
      <circle cx="3.5" cy="15.5" r="1.1" />
      <circle cx="16.5" cy="4.5" r="1.1" />
    </>
  ),
  radius: (
    <>
      <path d="M4 16V8a4 4 0 014-4h8" />
      <path d="M4 16h1.5M14.5 4H16" opacity="0.6" />
    </>
  ),
  warning: (
    <>
      <path d="M10 3.8l6.5 11.4h-13z" />
      <path d="M10 8v3.4M10 13.4v.1" />
    </>
  ),
  save: (
    <>
      <path d="M4.5 4.5h8.6L15.5 7v8.5h-11z" />
      <path d="M7 4.5v3.8h5V4.5M7 15.5v-4h6v4" />
    </>
  ),
  revert: (
    <>
      <path d="M4.8 7.4A6 6 0 1114.5 14" />
      <path d="M4.8 3.8v3.6h3.6" />
    </>
  ),
  specimen: (
    <>
      <rect x="3.5" y="4" width="13" height="12" rx="2" />
      <path d="M6.5 8h4M6.5 11h7M6.5 13.5h5" />
    </>
  ),
};

export function ThemeEditorIcon({ name, size = 17 }: { name: ThemeEditorIconName; size?: number }) {
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
