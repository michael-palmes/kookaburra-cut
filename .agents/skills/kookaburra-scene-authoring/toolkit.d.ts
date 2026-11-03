// Generated from the toolkit's source by pnpm agent:catalog. Do not edit.
// Scene files import from "@kookaburra/toolkit"; `kb toolkit show <Name>` reads the same source.
declare module "@kookaburra/toolkit" {
  import type { ComponentType, ReactElement, ReactNode } from "react";
  import type { Color, DirectionalLight, Group, InstancedMesh, Light, Material, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, SkinnedMesh, Vector3 } from "three";

  /** Devices this build can render with their own model and screen contract. */
  export const AVAILABLE_DEVICE_IDS: DeviceId[];

  /** Counts from `from` to `to` over `durationMs` (from `startMs`, shaped by `ease`, in `steps` jumps when set), as a pure function of the timeline; inside an `AnimatedGroup` the group's alpha multiplies into the fill and shine-capable groups mount the band material so the sweep doesn't skip the digits, both structurally absent outside groups (standing bytes stay safe). With a `textKey` it joins the managed-text lifecycle, so it stands down under a generic takeover like every scene-owned text primitive. */
  export function AnimatedCounter(props: AnimatedCounterProps): ReactElement | null;

  export interface AnimatedCounterProps {
    from: number;
    to: number;
    /** Count-up duration, in ms (local scene time); `steps` jumps inside it, `stepsAt` replaces it. */
    durationMs: number;
    /** Formats the interpolated value for display. Defaults to a rounded integer. */
    format?: (n: number) => string;
    position?: V3;
    fontSize?: number;
    /** Where `position` sits on the number's X axis (default "center", the legacy contract). */
    anchorX?: "left" | "center" | "right";
    /** The sidecar style key this counter honours: registers the row in the Edit-text drill and applies the `textStyle.<textKey>*` overrides (Size/Color/Font/OffsetX/OffsetY/RotationDeg). */
    textKey?: string;
    /** When the count starts, in ms (scene-local; default 0). */
    startMs?: number;
    /** Scene-local ms the count LANDS on `to`, on a beat or a cut: it starts `durationMs` earlier. Wins over `startMs`; `stepsAt` ignores it. */
    hitAt?: number;
    /** An ease name shaping the count (default "linear"). With `steps` it moves when each jump falls; with `stepsAt` or `ticks` it bends how far each jump goes. */
    ease?: EaseName;
    /** Count in this many equal jumps instead of continuously, landing on `to`: a jump falls where the eased progress crosses each k/n, so the first comes after 1/n of the count (never at `startMs`), the last exactly at the end, and `ease` shifts the ones between. */
    steps?: number;
    /** "beats": one jump on every grid beat from the start of the count to its end, each with a pop, landing on `to` on the last. Counts continuously (with one log line) when the project has no grid. */
    ticks?: "beats";
    /** One jump (with a pop) at each scene-local ms, landing on `to` on the last. Wins over `ticks`, `steps` and the count window. */
    stepsAt?: readonly number[];
    /** The scale each `ticks` or `stepsAt` jump pops by (default 0.08, so 1.08 and back over 180 ms); 0 turns it off. */
    pop?: number;
    /** Where `position` sits on the number's Y axis (default "middle"). */
    anchorY?: "top" | "middle" | "bottom";
  }

  /** Animates its children as one unit through the shared text-preset sampler, the group mechanism for icon+text lockups: granularity is forced null (`scatter-scale` on a group is the whole-lockup degenerate), child presets compose (alphas multiply through `GroupAnimationContext`, transforms nest), and the pivot is deliberately the group's origin since measured-bounds pivots depend on load timing, a determinism smell. */
  export function AnimatedGroup(props: AnimatedGroupProps): ReactElement;

  export interface AnimatedGroupProps {
    /** In-animation start, in ms (local scene time). */
    from?: number;
    /** In-animation end, in ms. */
    to?: number;
    /** Scene-local ms the group LANDS (first at rest size and full opacity), on a beat or a cut: the in keeps its duration and starts the motion's measured lead earlier. Wins over `from`. */
    hitAt?: number;
    /** Out start, in ms; the out plays over the same duration as the in. */
    outAt?: number;
    /** Pins the reveal (the group is one unit) to this many ms; "authored" or absent keeps the authored window. */
    durationMs?: number | "authored";
    /** In-animation preset. Defaults to the theme's `textAnimation.in`. */
    preset?: TextPresetName;
    /** Out-animation preset; plays only when `outAt` is set. */
    outPreset?: TextPresetName;
    /** Easing for preset animations. Defaults to the theme's `motion.easings.standard`. */
    ease?: EaseName;
    /** fade-scale: starting scale, landing at 1. */
    startScale?: number;
    /** fade-scale and twist-scale: sweep the soft white shine band once across the whole lockup. */
    shine?: boolean;
    /** twist-scale: the side the card turns in from. */
    direction?: TextDirection;
    position?: V3;
    /** World units per em for offset presets (default 0.6). */
    em?: number;
    /** Group extent [width, height] the shine band sweeps, group-local units. */
    extent?: readonly [number, number];
    /** Stable managed-text key used to resolve an item-level motion exception. */
    textKey?: string;
    /** Keep this coded group reveal independent of the scene motion fields. */
    ignoreSceneMotion?: boolean;
    /** Lets managed image icons participate in blur-in and mask-reveal. */
    imageEffects?: boolean;
    children?: ReactNode;
  }

  /** SDF headline rendered through troika (via drei `<Text>`); all motion is a pure function of the timeline, never the wall clock. Three render paths chosen once per mount: LEGACY (nothing configured, the original v0 linear fillOpacity ramp byte-for-byte, must not change), BLOCK (preset without stagger, whole-block opacity/offset/blur/clip via troika props), and STAGGERED (staggerMs > 0, one mesh with a per-glyph derived material). */
  export function AnimatedHeadline(props: AnimatedHeadlineProps): ReactElement | null;

  export interface AnimatedHeadlineProps {
    text: string;
    /** Reveal start, in ms (local scene time). */
    from?: number;
    /** Reveal end, in ms (local scene time). */
    to?: number;
    /** In-animation preset. Defaults to the theme's `textAnimation.in`. */
    preset?: TextPresetName;
    /** Out-animation preset; plays only when `outAt` is set. Defaults to `textAnimation.out`. */
    outPreset?: TextPresetName;
    /** Out start, in ms; the out plays over the same duration as the in unless `outDurationMs` sets its own. */
    outAt?: number;
    /** How long the out lasts, ms (default the in's duration). */
    outDurationMs?: number;
    /** Scene-local ms the first unit LANDS (first at rest size and full opacity), on a beat or a cut: the in keeps its duration and starts the motion's measured lead earlier, `delayMs` included. Wins over `from`; the out never moves. */
    hitAt?: number;
    /** 0..1, multiplied into every fade (default 1). */
    opacity?: number;
    /** Per-char / per-word stagger granularity. Paragraph delivery is spelled through `delivery`, never here. */
    stagger?: "char" | "word";
    /** Per-unit stagger delay, ms. Defaults to the theme's `textAnimation.staggerMs`. */
    staggerMs?: number;
    /** Hold before the in starts, ms (clamped ≥ 0; the out never shifts). Defaults to `textAnimation.delayMs`. */
    delayMs?: number;
    /** Pins the whole reveal, first unit's start to last unit's settle, to this many ms for the text's unit count (stagger and unit duration scale together); "authored" or absent keeps the authored per-unit timing. */
    durationMs?: number | "authored";
    /** fade-scale: starting scale, landing at 1 (default 0.8, clamped 0.05-4). */
    startScale?: number;
    /** fade-scale: sweep the soft white shine band once during the scale-in. */
    shine?: boolean;
    /** twist-scale: the side the card turns in from (default "from-left"). */
    direction?: TextDirection;
    /** build: how far each arriving word slides in, em (default 0.3). */
    buildShiftEm?: number;
    /** all-at-once / by-paragraph / by-paragraph-group. Paragraphs split on `\n`, groups on blank lines; all-at-once forces the whole-block path. */
    delivery?: TextDelivery;
    /** Easing for preset animations. Defaults to the theme's `motion.easings.standard`. */
    ease?: EaseName;
    /** Which theme face renders the text: the headline or body font. */
    face?: "headline" | "body";
    /** Theme colour token filling the text, or a raw sRGB hex (the per-scene text-colour escape hatch; tokens stay the default). Setting this pins the fill: the sidecar can no longer override it and the Edit-text drill-in shows no swatch. Prefer `defaultColor` on sidecar-driven scenes. */
    color?: "text" | "muted" | "accent" | (string & {});
    /** The sidecar text key this headline renders (what `useSceneText` was called with): enables the app-editable fill (`textStyle.<textKey>Color` in the scene document) and registers the field's colour swatch in the inspector. */
    textKey?: string;
    /** Compatibility-only style source when the stable managed key differs from an older sidecar style key. */
    styleKey?: string;
    /** Compatibility-only motion source when the stable managed key differs from an older keyed override. */
    motionKey?: string;
    /** Fill when neither `color` nor the sidecar set one (default "text"): the token a scene wants as its design default while staying app-editable. */
    defaultColor?: "text" | "muted" | "accent" | (string & {});
    position?: V3;
    fontSize?: number;
    /** Explicit font override replacing the theme face; also how the dispatcher applies a sidecar `<textKey>Font`. */
    fontRef?: FontRef;
    /** Per-line alignment inside the measured block (visible on multi-line text only). */
    textAlign?: "left" | "center" | "right";
    /** Where `position` sits on the block's X axis (default "center", the legacy contract). */
    anchorX?: "left" | "center" | "right";
    /** Where `position` sits on the block's Y axis (default troika "middle"); "top" anchors multi-line blocks by their top edge so following content can budget below them. */
    anchorY?: "top" | "middle" | "bottom";
    /** Wrap width in world units; unset means no wrapping, `\n` is the only line break. With `fit` it is the width to fit instead, and nothing wraps. */
    maxWidth?: number;
    /** "width" shrinks the font (never grows it) so the widest line fits `maxWidth`, or the safe width when that's unset. */
    fit?: "width";
    /** A layered depth look in any checked font: a stack of the same text receding behind the face, shading dark to light. `true` takes the finished default. */
    depth?: boolean | HeadlineDepth;
    /** Line spacing as a multiple of the font size; unset means troika's own "normal" (the font's metrics), which is also how the dispatcher applies a sidecar `<textKey>LineHeight`. */
    lineHeight?: number;
    /** Scene text stands down when `managedText` is present. Embedded composition text opts out; managed renderer nodes opt back in. */
    managedTextRole?: ManagedTextRenderRole;
    /** Effective coded parent motion to retain if the inspector takes ownership of this line. */
    managedTextCodedMotion?: TextAnimationSpec;
    /** Text-look preset name (the style catalogue); resolution follows the textAnimation pattern (theme default → sidecar `textLook` → props, `textLookForce` flips the order). */
    look?: string;
    /** Look parameter overrides riding beside `look` (colours, angle, stroke, intensity, offset, curve). */
    lookParams?: Partial<TextLookSpec>;
  }

  /** The project's authored `audio.grid` in this scene's time. Every time is integer scene-local ms through the same rounding as sidecar `at` positions, so `grid.bar(13)` and a key at `"bar:13"` land on the same frame. */
  export interface BeatGrid {
    bpm: number;
    beatsPerBar: number;
    /** One beat and one bar in ms, unrounded. */
    beatMs: number;
    barMs: number;
    /** Scene-local ms of a bar (and beat, sixteenth), all 1-based. */
    bar(bar: number, beat?: number, sixteenth?: number): number;
    /** Scene-local ms of a position (`"bar:13.3"`, `"cue:drop"`, `"section:outro"`, `"bar:9-40ms"`); throws when it can't resolve. */
    at(position: string): number;
    /** Scene-local ms of a bar (and beat, sixteenth), all 1-based; the same as `bar()`. */
    at(bar: number, beat?: number, sixteenth?: number): number;
    /** Project ms to scene-local ms. */
    local(projectMs: number): number;
    /** Scene-local ms to project ms. */
    project(localMs: number): number;
    position(localMs: number): BeatPosition;
  }

  /** Where a scene-local time sits on the grid: 1-based bar, beat and sixteenth (bar 0 and below are pickups), plus how far through the beat and the bar it is (0..1). */
  export interface BeatPosition {
    bar: number;
    beat: number;
    sixteenth: number;
    beatPhase: number;
    barPhase: number;
  }

  /** Horizontal brand lockup: app icon left, small muted title over a large hero subtitle to its right, revealed as ONE unit (fade-scale + a single shine sweep). Text lives in the sidecar under `title`/`subtitle`; centring and overflow shrink come from character-count estimates so layout never waits on font measurement. */
  export function BrandLockup(props: BrandLockupProps): ReactElement | null;

  export interface BrandLockupProps {
    /** Small muted label above the hero line (usually the app name). */
    title: string;
    /** The hero line (usually the version number). */
    subtitle: string;
    /** Project-relative icon path; every project ships `assets/app-icon.png`. */
    icon?: string;
    /** Group reveal window (scene-local ms). */
    from?: number;
    to?: number;
    /** Offset added after the built-in centring (world units). */
    position?: V3;
    /** Icon width in world units; height follows the image's aspect. */
    iconWidth?: number;
    /** Title label size in world units (default 0.36); the sidecar's `titleSize` multiplier still applies on top. */
    titleSize?: number;
    /** Hero subtitle size in world units (default 0.82); the sidecar's `subtitleSize` multiplier still applies on top. */
    subtitleSize?: number;
    /** Title fill token or raw hex (default "muted"); beats the sidecar's `textStyle.titleColor`. */
    titleColor?: "text" | "muted" | "accent" | (string & {});
    /** Subtitle fill token or raw hex; beats the sidecar's `textStyle.subtitleColor`. */
    subtitleColor?: "text" | "muted" | "accent" | (string & {});
  }

  export function Chart(props?: ChartProps): ReactElement | null;

  export function Chart2D(props: Chart2DProps): ReactElement;

  export interface Chart2DProps extends ChartRendererProps {
    /** The resolved appearance; absent takes the catalogue's default preset, so the primitive still stands alone. */
    surface?: ChartStyleSurface;
    /** Appearance overrides, applied over the surface's flat facet. */
    look?: Partial<Chart2DAppearance>;
  }

  export function Chart3D(props: Chart3DProps): ReactElement;

  export interface ChartAnimationConfig {
    /** Build-in preset id. */
    preset: string;
    delivery: ChartAnimationDelivery;
    staggerMs: number;
    durationMs: number;
    from: ChartAnimationFrom;
    /** Motion blur override; absent inherits the scene's Objects switch (see engine/motionBlur.ts). */
    motionBlur?: MotionBlurOverride;
  }

  export interface ChartAxisConfig {
    value: ChartValueAxis;
    category: ChartCategoryAxis;
  }

  /** The resolved chart block: what the scene hands the renderers. */
  export interface ChartConfig {
    type: ChartType;
    dimension: ChartDimension;
    mount: ChartMount;
    /** Staged mount only. */
    placement?: DevicePlacement;
    data: ChartData;
    /** Named colour scheme id (`paletteSchemes.ts`); null takes the theme's palette, which is the pre-scheme behaviour. */
    palette: string | null;
    /** Font string ("Family" or "Family@weight") for EVERY label in the chart, replacing both theme faces; null takes the project's chart font, then the theme faces. */
    font: string | null;
    style: ChartStyle;
    axis: ChartAxisConfig;
    labels: ChartLabelConfig;
    animation: ChartAnimationConfig;
  }

  export interface ChartData {
    categories: string[];
    series: ChartSeries[];
    /** Project-relative CSV the values were imported from; informational, nothing reads it at render time. */
    source?: string;
  }

  export type ChartDimension = "2d" | "3d";

  export interface ChartLabelConfig {
    legend: ChartLegend;
    values: ChartValueLabels;
  }

  /** The renderer-complete resolution of (data, config): pure, deterministic, unit-space. Only the family for `type` is populated (`bars`, or `series`, or `pie`). */
  export interface ChartLayout {
    type: ChartType;
    orientation: ChartOrientation;
    /** Which plot axis carries values, and which carries category bands. */
    valueAxis: ChartAxisKey;
    categoryAxis: ChartAxisKey;
    stacked: boolean;
    seriesCount: number;
    categoryCount: number;
    bars: ChartBarMark[];
    series: ChartSeriesLayout[];
    pie: ChartPieLayout | null;
    value: ChartValueAxisLayout;
    category: ChartCategoryAxisLayout;
    /** Category-axis extents, normalised: one band, and one mark within it. */
    bandWidth: number;
    barWidth: number;
  }

  /** `hero` is the chart scene kind, `staged` places it among devices/text, `panel` renders it inside an overlay panel column. */
  export type ChartMount = "hero" | "staged" | "panel";

  /** Overrides applied over the sidecar block; every field is optional, so `<Chart />` is the whole authoring surface for a sidecar-driven chart. */
  export interface ChartProps {
    type?: ChartType;
    dimension?: ChartDimension;
    mount?: ChartMount;
    /** Staged mount only, `DevicePlacement` semantics. */
    placement?: DevicePlacement;
    /** Appearance overrides applied over the preset's flat facet, straight through to `Chart2D`. */
    look?: Partial<Chart2DAppearance>;
    /** Build state replacing the block's own build-in, a bare per-element lookup or a whole sampler; absent samples the sidecar's animation preset. */
    reveal?: ChartRevealSource;
    opacity?: number;
    /** Bundle the standard rig for a 3D chart (the `Device` contract): defaults true, or false under a lighting `<SceneStage>`; an explicit value wins. Inert for flat charts, which are unlit. */
    lit?: boolean;
  }

  /** What every chart renderer takes, 2D and 3D alike: the resolved block, its computed layout, one colour per series (one per CATEGORY for pie), the plot area in WORLD units, and the optional build state. */
  export interface ChartRendererProps {
    chart: ChartConfig;
    layout: ChartLayout;
    colours: string[];
    size: { width: number; height: number };
    reveal?: ChartRevealSource;
    opacity?: number;
  }

  /** Per-element build state. `grow` scales a mark from its base (0 = nothing there, 1 = final size; an overshoot preset may push it to `CHART_GROW_MAX` and a landing squash a little under 1). `alpha` multiplies its opacity. `count` is the CLAMPED, monotone counting channel a value label prints against (`value * count`), so a label never runs past the true value while `grow` overshoots. `pulse` is a 0..1 emphasis envelope (glow and scale pops), 0 at rest. `shine` is the shine-band sweep position, 0..1 with 1 = swept past; -1 = no band. `drop` translates the whole element along the VALUE axis in plot-space units (positive = displaced toward the far end), which is the one entrance a scaling channel cannot express; 0 at rest. */
  export interface ChartReveal {
    grow: number;
    alpha: number;
    count: number;
    pulse: number;
    shine: number;
    drop: number;
  }

  /** Per-element reveal lookup, called once per mark. Pie slices key on `categoryIndex`, line and area points on both. Absent means everything is fully revealed. */
  export type ChartRevealFn = (seriesIndex: number, categoryIndex: number) => ChartReveal;

  export interface ChartSeries {
    id: string;
    name: string;
    values: number[];
    /** Hex override; absent or null takes the theme palette swatch for this series index. */
    colour?: string | null;
  }

  export interface ChartStyle {
    /** Appearance preset id. */
    preset: string;
    /** 3D extrusion depth, 0..1 of the preset's range. */
    depth: number;
    /** Space between category groups, in bar widths. */
    gap: number;
    /** 0..1 of half the bar width. */
    cornerRadius: number;
    /** Presentation tilt for hero 3D charts, X/Y degrees. */
    rotation: [number, number];
    /** Pie only; > 0 makes a donut, as a fraction of the outer radius. */
    innerRadius: number;
    /** Hero-mount nudge off the fitted centre, world units X/Y. */
    offset: [number, number];
    /** Hero-mount size multiplier over the fitted scale. */
    scale: number;
  }

  export type ChartType =
    | "column"
    | "stackedColumn"
    | "bar"
    | "stackedBar"
    | "line"
    | "area"
    | "stackedArea"
    | "pie";

  /** Number presentation shared by axis labels, value labels and the counter tick-up, so a counting label settles on exactly the printed static value. */
  export interface ChartValueFormat {
    /** null is auto (trailing zeros trimmed, at most 2 places). */
    decimals: number | null;
    separator: boolean;
    prefix: string;
    suffix: string;
    /** 1.2k / 3.4M / 1.2B; always explicit, never auto-enabled. */
    compact: boolean;
  }

  /** A pointer that travels a keyed path (`sampleKeys`) and presses with a small scale at each `presses` time, firing a tap ring there. */
  export function Cursor(props: CursorProps): ReactElement;

  export interface CursorKey {
    /** Scene-local ms. */
    tMs: number;
    /** Where the tip is, world units; use the same length in every key. */
    position: [number, number] | V3;
    /** Ease of the move arriving at this key (default `inOutCubic`). */
    ease?: string;
  }

  export interface CursorProps {
    /** The path: the tip holds the first key before it and the last after it. */
    keys: CursorKey[];
    /** Scene-local ms of each click: a small press scale, and a `TapRing` unless `ring` is false. */
    presses?: number[];
    ring?: boolean;
    /** Arrow height, world units (default 0.16). */
    size?: number;
    /** Fill, a theme token hex (default the text colour). */
    colour?: string;
    /** Edge, a theme token hex (default the background colour). */
    outline?: string;
    /** Press ring colour (default the accent). */
    ringColour?: string;
    opacity?: number;
    renderOrder?: number;
  }

  /** Keeps the studio default when licensed assets exist, otherwise uses bundled Android. */
  export const DEFAULT_DEVICE_ID: DeviceId;

  /** World z of each band. Foreground sits between the base camera (z 5) and the content plane; the two rear bands spread far enough apart to read as parallax without leaving the cyclorama (wall at z -6). */
  export const DEPTH_BANDS: { readonly foreground: 1.8; readonly content: 0; readonly midground: -2.4; readonly backdrop: -5.5; };

  export const DEVICE_AVAILABILITY: Readonly<Record<DeviceId, boolean>>;

  export const DEVICE_CATALOG: Record<DeviceId, DeviceSpec>;

  export const DEVICE_IDS: DeviceId[];

  /** A dashed bracket marking a span: a long run with an end tick at each side. The draw-on grows out from the middle to both ticks. */
  export function DashedBracket(props: DashedBracketProps): ReactElement;

  export interface DashedBracketProps extends DashStyleProps {
    /** Length of the bracket's long run in world units, centred on the group origin. */
    span: number;
    /** End tick length in world units (default 0.18). */
    depth?: number;
    /** Where the bracket sits against what it marks: `top` (ticks point down, the default), `bottom` (up), `left` (right) or `right` (left). */
    side?: DashedBracketSide;
  }

  export type DashedBracketSide = "top" | "bottom" | "left" | "right";

  /** A dashed straight rule from `from` to `to`, one flat colour-exact mesh per dash, with an optional draw-on. */
  export function DashedRule(props: DashedRuleProps): ReactElement;

  export interface DashedRuleProps extends DashStyleProps {
    /** Start point in the group's plane (world units); the draw-on starts here. */
    from: [number, number];
    to: [number, number];
  }

  /** What a band offers its children: its depth and the world rect that covers the frame there for the whole of the scene's camera travel. */
  export interface DepthBand {
    name: DepthBandName;
    z: number;
    width: number;
    height: number;
  }

  export type DepthBandName = keyof typeof DEPTH_BANDS;

  export function DepthStage(props: { foreground?: ReactNode; content?: ReactNode; midground?: ReactNode; backdrop?: ReactNode; }): ReactElement;

  /** The pillar device primitive: the export preamble awaits `preloadCatalogModels` / `prepareExportClips` / `preloadProjectImages` so every frame renders synchronously after load; see docs/determinism.md and docs/decisions.md. */
  export function Device(props: DeviceProps): ReactElement;

  export interface DeviceColourSpec {
    /** Stable id scenes reference, e.g. `"natural-titanium"`. */
    id: string;
    /** Display name for pickers, e.g. `"Natural Titanium"`. */
    name: string;
    /** Material-name → override. Empty = the model's authored (default) finish. */
    overrides: Record<string, DeviceMaterialOverride>;
    /** Picker swatch dot, the colour's frame value (display-only, never rendered 3D). */
    swatch: string;
  }

  /** The device catalog: devices keyed by stable id + colour id, with build-time availability separate from document identity so a missing licensed model never rewrites a project. Real product names are a deliberate 2026-07-05 trade-dress-risk decision (see docs/decisions.md), and iphone-15-pro's model derives from a LICENSED vendor .blend (see src/assets/models/README.md) whose colour overrides are exact linear-to-sRGB baseColorFactor replacements, not approximate tints. */
  export type DeviceForm = "phone" | "laptop" | "tablet" | "foldable";

  export type DeviceId =
    | "iphone-15-pro"
    | "iphone-17-pro"
    | "iphone-duo"
    | "macbook-pro-16"
    | "ipad-pro-13"
    | "android";

  /** Media shown on the device screen. Videos ride the deterministic clip-frame pipeline. */
  export interface DeviceMediaSpec {
    /** Project-relative path, e.g. `"assets/demo.mp4"` or `"assets/screen.png"`. */
    src: string;
    kind: "video" | "image";
    /** Video only: when playback starts, in ms of scene-local time (default 0). */
    startMs?: number;
    /** Sidecar video only: musical position the start sits on; `startMs` caches its resolved value and a move that disagrees drops it. */
    at?: string;
    /** Cover-fit is the rule: fill the screen, keep the media's aspect, crop the overflow. */
    fit?: "cover";
    /** Turns the media clockwise on the screen before the fit; `"auto"` picks the turn that stands it upright on the device's current pose. */
    rotateDeg?: DeviceMediaRotation;
    /** Foldable inside display only: count `startMs` from the moment the fold opens past the switch angle, so the app carries on as the device opens. Inert without a fold that opens. */
    startOn?: "open";
    /** Video only: source ms where playback begins (a trim-in); combines with a `startMs` delay. */
    inMs?: number;
    /** Video only: source ms where playback ends, exclusive; absent plays to the end. */
    outMs?: number;
    /** Video only: playback rate, 0 < speed <= 16 (default 1); frames repeat or skip, never blend. */
    speed?: number;
    /** Video only: wrap within `[inMs, outMs)` instead of holding the last frame. */
    loop?: boolean;
    /** Video only: source ms shown before playback starts (default: the first played frame). */
    posterMs?: number;
  }

  /** Loads a bundled handset glTF and maps a static project image onto its screen mesh; the export preamble awaits `preloadDeviceModels()` / `preloadProjectImages()` so a cold export never races a still-loading asset. See docs/determinism.md. A missing screen asset degrades to no mockup; never tear down the canvas tree. */
  export function DeviceMockup(props: DeviceMockupProps): ReactElement | null;

  export interface DeviceMockupProps {
    /** Which bundled handset model to render. */
    model: DeviceModelName;
    /** Project-relative image path shown on the device screen, e.g. `"assets/screen.png"`. */
    screen: string;
    /** Base rotation in radians. */
    rotation?: V3;
    position?: V3;
    /** Multiplier on the auto-fit scale (the model auto-sizes to a sensible world height). */
    scale?: number;
    /** Optional idle spin about Y, in degrees/second, a pure function of the timeline. */
    spinDegPerSec?: number;
  }

  export type DeviceMotionPreset = "none" | "turntable" | "float" | "tilt-reveal" | "push-in";

  export interface DeviceMotionSpec {
    preset: DeviceMotionPreset;
    /** `turntable`: idle spin about Y, degrees/second (default 18). */
    degPerSec?: number;
    /** `float`: vertical bob amplitude in world units (default 0.12). */
    amplitude?: number;
    /** `float`: bob frequency in cycles/second (default 0.4). */
    hz?: number;
    /** `tilt-reveal` / `push-in`: intro length in ms (defaults 1000 / 1200). */
    durationMs?: number;
  }

  export interface DevicePlacement {
    position?: V3;
    /** Base rotation in DEGREES (scene documents are authored in degrees). */
    rotationDeg?: V3;
    /** Multiplier on the auto-fit scale. */
    scale?: number;
    /** Rest the fitted base on the staged floor (its y replaces `position[1]`); inert when the scene stages no floor backdrop, so the authored position stands. */
    ground?: boolean;
    /** Stamped by `resolveDeviceLayout`, never authored or persisted: the block's authoritative pose. `Device` prefers it over the scalar fields, so scene TSX that post-processes placements (the templates' portrait scale multipliers, frozen at scaffold time) cannot drift a laid-out scene. Post-process only block-less scenes, or delete this field first. */
    resolvedLayout?: { position: V3; rotationDeg: V3; scale: number };
  }

  export interface DeviceProps {
    /** Scene-document id: sidecar devices carry it (it is what the inspector and the gizmo select on), hand-authored ones do not. */
    id?: string;
    /** Catalog id, e.g. `"iphone-15-pro"`. */
    model: DeviceId;
    /** Colour id from the catalog (default: the model's default colour). */
    colour?: string;
    media?: DeviceMediaSpec;
    /** Foldables only: the outside display's media (`media` is the inside one). */
    coverMedia?: DeviceMediaSpec;
    placement?: DevicePlacement;
    motion?: DeviceMotionSpec;
    /** Presentation shadow: defaults to `"soft"` and remains independent from real `<SceneStage>` map shadows; an explicit value wins. */
    shadow?: DeviceShadowMode;
    /** Bundle the lit set (rig + one-shot environment); defaults true, or false under a lighting `<SceneStage>` since the stage lights the scene; an explicit value wins. */
    lit?: boolean;
    /** Laptop lid opening in degrees (0 closed, default the model's authored angle); ignored by devices with no hinge. */
    lidDeg?: number;
    /** Foldable hinge angle in degrees (0 closed, 180 open flat, default open); ignored by devices that do not fold. */
    foldDeg?: number;
    /** Foldables only: light both displays at every angle instead of handing power over as it opens. */
    bothScreensOn?: boolean;
    foldTransition?: DeviceFoldTransitionSpec;
    /** Motion blur override; absent inherits the scene's Objects switch. */
    motionBlur?: MotionBlurOverride;
    /** Content riding the device's pose in its fitted frame; `DeviceScreenAnchor` pins it to the screen. */
    children?: ReactNode;
  }

  export interface DeviceScreen extends DeviceScreenContextValue {
    rect: DeviceScreenRect;
    /** Foldables only: the outside display. */
    coverRect?: DeviceScreenRect;
    /** A screen point in the device's fitted frame (placement scale 1), at this frame's hinge pose. */
    local: (u: number, v: number, lift?: number, display?: DeviceScreenDisplay) => V3;
  }

  /** Pins its children to a point on the parent `Device`'s screen, in the screen's own plane (x right, y up, +z out of the glass, fitted units scaled with the device), so they follow float, rotation, intro, scale and a laptop's lid. */
  export function DeviceScreenAnchor(props: DeviceScreenAnchorProps): ReactElement | null;

  export interface DeviceScreenAnchorProps {
    /** 0 at the display's left edge to 1 at its right. */
    u: number;
    /** 0 at the display's top edge to 1 at its bottom (media pixel order). */
    v: number;
    /** Off the glass along the display's normal, in fitted units (default `SCREEN_LIFT`). */
    lift?: number;
    /** A foldable's display (default `"main"`, the inside one). */
    display?: DeviceScreenDisplay;
    children?: ReactNode;
  }

  /** A foldable's inside (`"main"`) or outside (`"cover"`) display; every other device has only `"main"`. */
  export type DeviceScreenDisplay = "main" | "cover";

  /** The hinge pose a point is read at; absent angles take the device's defaults. */
  export interface DeviceScreenHinge {
    display?: DeviceScreenDisplay;
    lidDeg?: number;
    foldDeg?: number;
  }

  /** A device's resolved world pose (static: no motion preset or device track). */
  export interface DeviceScreenPose extends DeviceScreenHinge {
    /** The device group's world position, grounding applied (`resolveDeviceWorldAnchor`). */
    position: V3;
    rotationDeg?: V3;
    /** Placement scale on top of the auto-fit (default 1). */
    scale?: number;
  }

  /** Where a display's media sits, measured off the glb (`screenGeometry.ts`) in the frame `Device` renders in at placement scale 1 (recentred and fitted). UV (0, 0) is the top-left corner, u runs right and v down. */
  export interface DeviceScreenRect {
    width: number;
    height: number;
    centre: [number, number];
    /** The display plane's depth; it faces +Z at the measured pose. */
    z: number;
    /** The largest of the display's four corner radii. */
    cornerRadius: number;
    /** The hinge pose a riding display was measured at (a laptop's lid; a foldable's fold, the cover closed and the inside open flat, auto-centre included). */
    frame?: { lidDeg?: number; foldDeg?: number };
  }

  /** The presentation modes' parameter sets. */
  export type DeviceShadowMode =
    | "soft"
    | "long"
    | "sun"
    | "studio"
    | "overhead"
    | "drop"
    | "backlight"
    | "feather"
    | "window"
    | "wetfloor"
    | "none";

  export interface DeviceSpec {
    /** Stable id scenes reference, e.g. `"iphone-15-pro"`. */
    id: DeviceId;
    /** Display name for pickers, e.g. `"iPhone 15 Pro"`. */
    name: string;
    form: DeviceForm;
    /** Bundled glb URL (`?url` import). */
    glbUrl: string;
    /** The primary display; on a foldable, the inside one. */
    screen: DeviceScreenSpec;
    /** Foldables only: the outside display, lit when the device is closed. */
    coverScreen?: DeviceScreenSpec;
    colours: DeviceColourSpec[];
    defaultColour: string;
    /** Colour id → bundled picker-card PNG (`pnpm assets:device-previews`). */
    previews: Record<string, string>;
    /** Auto-fit override; laptops fit by width since their bbox height is lid-angle-dependent. */
    fit?: DeviceFitSpec;
    /** Fitted world-space body width at placement scale 1: a static constant, never the runtime bbox, so `resolveDeviceLayout` stays deterministic for the model this build can render. */
    layoutWidth: number;
    /** Fitted world-space body height at placement scale 1: the renderer and camera bindings share this instead of depending on whichever glb is installed. */
    fittedHeight: number;
    /** Cast-shadow silhouette; see `DeviceShadowSpec`. */
    shadow: DeviceShadowSpec;
    /** Hinge for lid-angle control: the glb node (three.js-sanitised name) whose local X rotation opens the lid, the authored open angle, the default pose when the doc sets none, and the measured hinge point (fitted frame) the lid turns about. */
    lid?: { node: string; openDeg: number; defaultDeg: number; pivot?: V3 };
    fold?: DeviceFoldSpec;
  }

  /** Every valid ease name (stable order: linear, jump, then in/out/inOut per family). */
  export const EASE_NAMES: readonly EaseName[];

  export type EaseName = "linear" | "jump" | `${"in" | "out" | "inOut"}${EaseFamily}`;

  /** Per-call curve options; absent fields keep the table curves exactly. */
  export interface EaseOptions {
    /** Back-family overshoot (Penner's `s`, default 1.70158); inOutBack scales it by 1.525. Other eases ignore it. */
    overshoot?: number;
  }

  /** Extruded 3D text: real depth + bevels via FontLoader/TextGeometry, unlike the flat troika SDF of `AnimatedHeadline`; geometry is a pure function of props + the bundled typeface (parsed synchronously from JSON, see `fonts.ts`), and the reveal (rise + tilt settle) is a pure function of `useTimeline()`, never the wall clock. It animates transforms only, no transparency, so mid-reveal frames never show internal faces. With a `textKey` it joins the managed-text lifecycle, so it stands down under a generic takeover like every scene-owned text primitive. */
  export function ExtrudedText(props: ExtrudedTextProps): ReactElement | null;

  export interface ExtrudedTextProps {
    text: string;
    /** Reveal start, in ms (local scene time). */
    from?: number;
    /** Reveal end, in ms (local scene time). */
    to?: number;
    position?: V3;
    /** Base rotation in radians (the reveal tilt settles onto `rotation[0]`). */
    rotation?: V3;
    fontSize?: number;
    /** Extrusion depth in world units. Defaults to `fontSize * 0.25`. */
    depth?: number;
    /** Bevelled edges (on by default; bevels are what sell the extrusion under light). */
    bevel?: boolean;
    /** Theme colour token for the material. */
    tone?: "text" | "accent" | "muted";
    /** Bundle a self-contained light rig (DeviceMockup pattern). Turn off when the scene lights itself or stacks several lit primitives (rigs add up). */
    lit?: boolean;
    /** The sidecar style key this text honours: registers the row in the Edit-text drill and applies the `textStyle.<textKey>*` overrides (Size/Color/OffsetX/OffsetY/RotationDeg). */
    textKey?: string;
  }

  export const FALLBACK_DEVICE_ID: DeviceId;

  export interface FormatInfo {
    /** Output pixel width. */
    width: number;
    /** Output pixel height. */
    height: number;
    /** width / height. */
    aspect: number;
    /** "wide", "square" or "tall", from `aspect`; branch layouts on this so 1:1 gets its own answer. */
    shape: FormatShape;
    /** Visible world rectangle at the content plane; lay out against `frame.width/height`. */
    frame: { width: number; height: number };
    /** Safe-area insets in WORLD units from each edge (position content inside these). */
    safe: { top: number; right: number; bottom: number; left: number };
  }

  /** How a frame reads for layout, from `FormatInfo.aspect`: "wide" at 1.2 and up (16:9, 3:2, 5:4), "tall" at 0.85 and below (9:16, 2:3, 4:5, phone), "square" between (1:1). */
  export type FormatShape = "wide" | "square" | "tall";

  /** A frame-filling blend between two colours, linear or radial. Mount inside a `ScreenLayer`. */
  export function Gradient(props: GradientProps): ReactElement;

  export interface GradientProps extends ScreenFillProps {
    /** Start colour: a theme token or hex. */
    from: Colour;
    /** End colour: a theme token or hex. */
    to: Colour;
    /** "linear" (default) runs along `angleDeg`; "radial" runs from `centre` outward. */
    kind?: "linear" | "radial";
    /** Direction `from` runs toward `to`, degrees clockwise from up (default 180, top to bottom). */
    angleDeg?: number;
    /** Radial centre, frame fractions from the bottom left (default [0.5, 0.5]). */
    centre?: readonly [number, number];
    /** Where along the run the blend starts, 0..1 (default 0). */
    start?: number;
    /** Where along the run the blend ends, 0..1 (default 1). */
    end?: number;
  }

  export interface GroupAnimationState {
    /** The group's sampled alpha this frame; children multiply it into their opacity. */
    alpha: number;
    /** This frame's shine band in group space; null = off/parked. */
    band: GroupShineBand | null;
    /** MOUNT-STABLE: whether this group can ever shine; children use it once per mount to decide whether to route through a shine-capable material variant. */
    shineCapable: boolean;
    /** MOUNT-STABLE: managed image children need the blur/mask material variant. */
    imageEffectsCapable?: boolean;
    /** This frame's managed-image blur radius in world units. */
    imageBlurWorld?: number;
    /** This frame's horizontal managed-image reveal window. */
    imageSweep?: readonly [number, number];
  }

  /** A flat, unblurred offset shadow (the hard-shadow look). Offsets and radius are fractions of the card's short edge. */
  export interface HardShadowSpec {
    /** x right, y up (default [0.06, -0.06]). */
    offset?: [number, number];
    /** A theme token hex (default the theme text colour). */
    colour?: string;
    /** 0..1 (default 1); multiplies with the card's own fade. */
    opacity?: number;
    /** Corner radius, for assets with rounded corners (default 0). */
    radius?: number;
  }

  /** The depth stack. Every field is optional. */
  export interface HeadlineDepth {
    /** How far the stack reaches behind the face, em (default 0.12). */
    em?: number;
    /** The direction it recedes, degrees counter-clockwise from +x (default -45, down and right). */
    angleDeg?: number;
    /** How many layers, 1 to 32 (default 12); more is smoother and costs a typeset and a draw each. */
    layers?: number;
    /** The deepest layer's colour, a theme token or hex (default the face colour, mostly darkened). */
    dark?: "text" | "muted" | "accent" | (string & {});
    /** The nearest layer's colour, a theme token or hex (default the face colour, a little darkened). */
    light?: "text" | "muted" | "accent" | (string & {});
  }

  /** Product/hero glTF object on a lit set, the generic sibling of `DeviceMockup`: loads a bundled model by name, recentres + auto-fits it, and offers idle spin + float driven by `useTimeline()`; the export preamble awaits `preloadHeroModels()` so a cold export never captures a still-loading hero. See docs/determinism.md. */
  export function HeroObject(props: HeroObjectProps): ReactElement;

  export interface HeroObjectProps {
    /** Which bundled hero model to render. */
    model: HeroModelName;
    position?: V3;
    /** Base rotation in radians (idle spin adds to `rotation[1]`). */
    rotation?: V3;
    /** Multiplier on the auto-fit scale (models auto-size to a sensible world height). */
    scale?: number;
    /** Idle spin about Y, in degrees/second, a pure function of the timeline. */
    spinDegPerSec?: number;
    /** Gentle vertical bob, in world units (0 disables). Pure function of the timeline. */
    floatAmplitude?: number;
    /** Bob frequency, in cycles/second. */
    floatHz?: number;
    /** Bundle the lit set (rig + one-shot environment); defaults true, or false under a lighting `<SceneStage>` since the stage lights the scene; an explicit value wins. */
    lit?: boolean;
  }

  /** A flat image plane for icons, logos and stills: renders UNLIT with `toneMapped: false` so the asset's pixels land exactly (the device-screen/backdrop precedent), respecting PNG alpha so rounded/irregular shapes come from the asset itself; the suspense texture load is settled by the export preamble before frame 0. */
  export function ImageCard(props: ImageCardProps): ReactElement | null;

  export interface ImageCardProps {
    /** Project-relative asset path (e.g. `assets/app-icon.png`). */
    src: string;
    position?: V3;
    /** World-unit width; height follows the image's aspect ratio. */
    width?: number;
    /** Optional world-unit height cap; both dimensions shrink together to contain the image. */
    maxHeight?: number;
    /** Optional linear fade-in window, ms (local scene time). Absent = always opaque. */
    from?: number;
    to?: number;
    /** 0..1 (default 1); multiplies with the fades. */
    opacity?: number;
    /** Start of a linear fade-out, ms (local scene time). Absent never fades out. */
    outAt?: number;
    /** How long the fade-out lasts, ms (default the fade-in window, else 300). */
    outDurationMs?: number;
    /** One colour for a mark: a theme token or hex replaces every pixel's colour, keeping the asset's alpha. */
    tint?: "text" | "muted" | "accent" | (string & {});
    /** A hard offset shadow behind the card; absent draws none. */
    shadow?: HardShadowSpec;
  }

  /** The scene document's layered-screenshot stack at its resolved pose (rest pose, or the sampled animation when the scene's animated track is the layered screenshot). Registers the scene as a consumer so the host-side fallback stands down. In-flight builder drafts merge here in React behind the store's export guard, so the export path only ever sees the sidecar. */
  export function LayeredScreenshot(props?: LayeredScreenshotProps): ReactElement | null;

  export interface LayeredScreenshotProps {
    /** Optional specialised title, rendered in a reserved band above the stack. */
    title?: string;
  }

  /** The toolkit's standard three-point-ish light rig: ambient fill + key + rim, matching the constants the lit primitives (`ExtrudedText`, `Ribbon`) bundle; scenes stacking several lit primitives should mount ONE `<LightRig />` and pass `lit={false}` to each, since rigs add up. Static lights only, nothing here reads the clock. */
  export function LightRig(): ReactElement;

  /** Inspector-owned deterministic safe-area text stack. It renders only for a present managed block. */
  export function ManagedTextStack(props: ManagedTextStackProps): ReactElement | null;

  export interface ManagedTextStackProps {
    region?: ManagedTextRegion;
  }

  export interface MeasureTextOptions {
    /** A theme `FontRef` or a font string ("Family" or "Family@weight"), resolved like every text primitive's face. */
    font: FontRef | string;
    fontSize: number;
    /** Extra advance after each glyph, in em (troika's `letterSpacing`). */
    letterSpacing?: number;
    /** Line advance as a multiple of the font size; absent is the face's own "normal". */
    lineHeight?: number;
  }

  /** A measured block, plus the size that makes it fit a width. */
  export interface MeasuredText extends TextMetrics {
    /** The `fontSize` to pass (at most the one you measured with) so the block fits `maxWidth`, sidecar Size override included. */
    fitFontSize(maxWidth: number): number;
  }

  /** Scales motion blur from its subtree's own motion: 0 keeps it sharp, 1 is the scene's shutter, 2 doubles the trail. Camera blur is unaffected. */
  export function MotionBlur(props: { amount: number; children: ReactNode }): ReactElement;

  /** One key: a scene-local time, the ease of the segment ARRIVING at it, and any values. */
  export type MotionKey = { tMs: number; ease?: string; [prop: string]: unknown };

  export interface ObjectLicence {
    /** Licence name, e.g. "CC0", "Royalty-free (purchased)". */
    name: string;
    holder?: string;
    url?: string;
    /** False = the binary must stay out of the repo (the licensed phone-glb precedent). */
    redistributable?: boolean;
  }

  export interface ObjectManifest {
    version: number;
    /** Stable id; workspace objects are re-stamped `ws:<slug>` from their folder on read. */
    id: string;
    name: string;
    /** The glb path relative to the object's folder (workspace) or the bundled asset key. */
    glb: string;
    /** Optional picker thumbnail beside the manifest. */
    thumbnail?: string;
    /** World-unit height the primitive auto-fits the model to (the Device TARGET_WORLD_HEIGHT pattern); absent = the consumer's default. */
    fitHeight?: number;
    licence?: ObjectLicence;
    tags?: string[];
  }

  /** Instanced particle scatter: every particle's base position/size/phase is drawn from `createSeededRandom(seed)` (never `Math.random`), and per-frame drift/twinkle are pure functions of `useTimeline()` so the field is byte-identical run-to-run; the RNG draw order below is part of that contract, reordering it re-scatters every committed project. */
  export function ParticleField(props: ParticleFieldProps): ReactElement;

  export interface ParticleFieldProps {
    /** Instance count. */
    count?: number;
    /** RNG seed; same seed, same field, every run (the determinism contract). */
    seed?: number;
    /** Half-extents of the scatter box, in world units. */
    bounds?: V3;
    /** Base particle radius, in world units. */
    size?: number;
    /** Upward drift in world-units/second; particles wrap inside the bounds. 0 = static. */
    drift?: number;
    /** Scale-pulse amplitude as a fraction of `size` (0 disables). */
    twinkle?: number;
    /** Theme colour token (unlit material, pops under bloom). */
    tone?: "text" | "accent" | "muted";
    /** Glow: a target luminance (above a bloom threshold over 1) reached by raising only the tone's full channels, unlit with tone mapping off so it still lands exactly on the token (see `glowColour`). Absent renders as before. */
    glow?: number;
    position?: V3;
  }

  /** A RoundedRect whose radius is half the shorter side. */
  export function Pill(props: PillProps): ReactElement;

  export interface PillProps {
    /** World-unit width. */
    width: number;
    /** World-unit height. */
    height: number;
    /** Fill colour (a theme token hex); defaults to the theme accent. */
    color?: string;
    opacity?: number;
    /** Border ring width in world units, drawn just inside the edge; 0 or absent draws none. */
    strokeWidth?: number;
    /** Border colour; defaults to the theme text colour. */
    strokeColor?: string;
    position?: V3;
    /** Radians. */
    rotation?: V3;
    scale?: number | V3;
    renderOrder?: number;
  }

  /** A library object placed directly in TSX: an id and where it sits. */
  export interface PlacedObjectProps {
    /** A bundled id or `ws:<slug>`, as in `kb catalog objects`; an unknown id renders nothing. */
    objectId: string;
    /** World position (default the origin). */
    position?: V3;
    /** Euler rotation, degrees (default none). */
    rotationDeg?: V3;
    /** Multiplies the object's fitted size (default 1). */
    scale?: number;
    /** Sit the object on the stage floor; its y is then ignored (default false). */
    ground?: boolean;
  }

  /** The manifest's `shared` block: author constants (palette, timings) every scene can read. */
  export type ProjectShared = { readonly [key: string]: ProjectSharedValue };

  /** A chat-style prompt bar: a rounded bar whose text types in one keystroke at a time (the typewriter preset's pace, revealed by a clip rect so the line scrolls like a real input once it outgrows the bar), a caret that blinks on the timeline once typing is idle, and a procedural send button. Theme tokens only; a pure function of the clock. */
  export function PromptBar(props: PromptBarProps): ReactElement;

  export interface PromptBarProps {
    /** The prompt, typed in one keystroke at a time (emphasis markup is stripped and drawn plain). */
    text: string;
    /** Sidecar style key: `textStyle.<key>Color`, `Font` and `Size` apply. */
    textKey?: string;
    /** Typing starts, ms (scene-local; default 0). */
    from?: number;
    /** Typing ends, ms (default `from` + 45 ms per keystroke). */
    to?: number;
    position?: V3;
    /** Bar width, world units (default 0.62 × the frame width). */
    width?: number;
    /** Bar height, world units (default 0.62). */
    height?: number;
    /** Text size (default 0.4 × the height). */
    fontSize?: number;
    /** Which theme face types the prompt (default "body"). */
    face?: "headline" | "body";
    /** Draw the send button (default true). */
    send?: boolean;
    /** Draw the caret (default true). */
    caret?: boolean;
  }

  /** One pulse's shape in ms: rise over `attackMs` (default 0, a snap), hold for `holdMs` (default 0), fall over `releaseMs`; `ease` (default `"outQuad"`) shapes both ramps. */
  export interface PulseOptions {
    attackMs?: number;
    holdMs?: number;
    releaseMs: number;
    ease?: EaseName | ((t: number) => number);
  }

  /** The chart block with every default baked and the data track resolved: what the renderers and the editor read. `data.categories` and every `series.values` row are the same length, so a sampled matrix is always rectangular. */
  export interface ResolvedChart extends ChartConfig {
    track: ResolvedChartTrack;
  }

  /** A picker/renderer-ready object: the manifest plus resolved asset URLs. */
  export interface ResolvedObjectAsset {
    manifest: ObjectManifest;
    glbUrl: string;
    thumbnailUrl?: string;
  }

  /** A tube swept along a seeded control curve, growing along the clock: control points are drawn from `createSeededRandom(seed)` (never `Math.random`) with x ordered left to right so the sweep reads as a stroke, and the RNG call order is part of the determinism contract; geometry is built once, growth only animates `drawRange` (no per-frame reallocation) as a pure function of `useTimeline()`, written during commit. */
  export function Ribbon(props: RibbonProps): ReactElement;

  export interface RibbonProps {
    /** RNG seed for the control curve; same seed, same sweep, every run. */
    seed?: number;
    /** Control-point count along the sweep (left → right). */
    points?: number;
    /** Half-extents of the control-point scatter, in world units. */
    bounds?: V3;
    /** Tube radius, in world units. */
    radius?: number;
    /** Grow start, in ms (local scene time). */
    from?: number;
    /** Grow end, in ms (local scene time). */
    to?: number;
    /** Theme colour token. */
    tone?: "text" | "accent" | "muted";
    /** Bundle the standard light rig (see `LightRig`); turn off when the scene lights itself. */
    lit?: boolean;
    /** Glow: a target luminance (above a bloom threshold over 1) reached by raising only the tone's full channels, drawn as an unlit emitter with tone mapping off so it still lands exactly on the token (see `glowColour`). Absent renders as before. */
    glow?: number;
    position?: V3;
    rotation?: V3;
  }

  /** A camera-locked room: a frame-filling colour behind all content plus an optional flood. Both meshes stay mounted, so a room changing never mounts or compiles anything mid-run. */
  export function Room(props: RoomProps): ReactElement;

  /** A camera-locked circle of colour growing from a point in the frame (a 256-gon over the room, under all content). For scenes composing their own flood; the sidecar `room` block draws its own. */
  export function RoomFlood(props: RoomFloodProps): ReactElement;

  export interface RoomFloodProps {
    /** The incoming room colour (hex, e.g. a theme token). */
    colour: string;
    /** Where the flood starts, in frame fractions: [0, 0] top-left to [1, 1] bottom-right; default the centre. */
    origin?: readonly [number, number];
    /** 0..1 of the radius that covers the whole frame; ease it yourself (e.g. `ramp`). */
    radius: number;
  }

  export interface RoomFloodSample {
    /** The incoming room. */
    colour: string;
    origin: [number, number];
    /** Linear 0..1 through the flood. */
    progress: number;
    /** Eased fraction of the frame-covering radius. */
    radius: number;
  }

  export interface RoomProps {
    /** The room colour filling the frame behind all content (hex); null shows the scene's own background. */
    colour: string | null;
    /** A flood growing over the room. */
    flood?: RoomFloodProps | null;
  }

  export interface RoomSample {
    /** The room on screen (what a flood spreads over); null before the first key, where the scene's own background shows. */
    colour: string | null;
    /** The key the colour belongs to; -1 before the first key. */
    key: number;
    flood: RoomFloodSample | null;
    /** The room's lighting pose; empty before the first key. */
    pose: LightingPose;
  }

  /** An unlit, antialiased rounded rectangle with an optional border ring; colour-exact like ImageCard, and size, radius and colours animate without rebuilding geometry. */
  export function RoundedRect(props: RoundedRectProps): ReactElement;

  export interface RoundedRectProps extends PillProps {
    /** Corner radius in world units, capped at half the shorter side. */
    radius?: number;
  }

  /** How far anchored content sits off the display along its normal, in fitted units, so it never z-fights the screen. */
  export const SCREEN_LIFT: 0.002;

  export interface SampleKeysOptions extends EaseOptions {
    /** Ease for segments whose arriving key names none (default `linear`). */
    ease?: string;
  }

  /** The scene camera's pose this frame, as the render applies it. */
  export interface SceneCamera {
    position: V3;
    lookAt: V3;
    /** Vertical field of view, degrees. */
    fov: number;
    /** Bank about the view axis, degrees; absent when level. */
    rollDeg?: number;
  }

  /** `Device`-spreadable props (the sidecar device entry, with `model` narrowed). */
  export interface SceneDeviceProps extends Omit<DeviceProps, "model"> {
    id: string;
    model: DeviceId;
  }

  export interface SceneDoc {
    version: number;
    /** Human name shown by pickers (scenes have no display name otherwise). */
    name?: string;
    duration?: SceneDocDuration;
    /** Legacy and embedded copy keyed for `useSceneText`; managed items own scene copy when present. */
    text?: Record<string, string>;
    /** Layout for the scene's text block; consumed by TitleBlock (inert when a scene positions text by hand, the `backdrop` precedent). */
    textLayout?: { align?: SceneTextAlign };
    /** Per-text-element overrides keyed `<textKey><Suffix>`: `Color` (raw hex fill, the one narrow exception to "colours stay tokens"), `Font` ("Family" or "Family@weight"), `Size` (multiplier of the element's default, 1 = unchanged), `OffsetX`/`OffsetY` (world-unit nudges from the scene's layout), `LineHeight` (line spacing as a multiple of the font size, clamped 0.8..2; absent means troika's own "normal") `RotationDeg` (clockwise tilt in degrees about the block's anchor; absent or 0 is upright) and `Emphasis` (`*word*` emphasis: "<colour>" or "<colour>@<weight>", a token or hex and a CSS weight; absent is the accent one weight step bolder); consumed by text primitives given a matching `textKey`, inert otherwise. */
    textStyle?: Record<string, string | number>;
    /** Header icon for a plain (non-overlay) scene's text: an emoji or an `assets/` image path, drawn above the headline by `TextFallback`/`TitleBlock`. Overlay scenes carry their icon on `frame.icon` instead; both scale by `textStyle.iconSize`. */
    headerIcon?: string;
    /** Inspector-owned ordered text. Absence preserves the authored renderer; present-empty intentionally renders no scene text. */
    managedText?: SceneManagedTextBlock;
    devices?: SceneDocDeviceSpec[];
    /** The one media family (stills and videos). Authored here; a document written before the merge reads its `images` + `videoWindow` forward into this array at parse (see the note above `bridgeSceneMedia`). */
    media?: SceneDocMediaSpec[];
    /** LEGACY, read-only: pre-merge still images. Kept so an untouched old sidecar writes back unchanged; every reader goes through `resolveSceneDocMedia`, and the first media edit promotes the document to `media`. */
    images?: SceneDocImageSpec[];
    /** The live multi-device layout block; see `SceneDocDeviceLayout`. */
    deviceLayout?: SceneDocDeviceLayout;
    /** Opt-in device animation: one track for the scene, each key carrying a pose per device id (the lighting-track shape). Absent means every device renders exactly as it does without it. */
    deviceTrack?: { keys: SceneDocDeviceKey[]; segments: SceneDocDeviceSegment[] };
    /** Staged 3D objects from the object library, rendered by `ObjectsFallback` on any scene. */
    objects?: SceneDocObjectSpec[];
    camera?: {
      keys: SceneDocCameraKey[];
      segments: SceneDocCameraSegment[];
      presentLoop?: SceneDocCameraPresentLoop;
    };
    /** Which camera block drives this scene; absent = "orbit" (null-for-legacy). Switching never deletes the other block's keys, and "rig" with no rig keys falls through to orbit. */
    cameraMode?: "orbit" | "rig";
    /** The free-flight camera track (see `sceneRig.ts`); read only under `cameraMode: "rig"`. */
    cameraRig?: {
      keys: SceneDocRigKey[];
      segments: SceneDocRigSegment[];
      presentLoop?: SceneDocCameraPresentLoop;
    };
    /** Camera kicks added at render on whichever pose drives the scene, in either mode (see `engine/cameraKicks.ts`); never expanded into keys. */
    cameraKicks?: SceneDocCameraKick[];
    /** Theme override for this scene: a theme id that swaps the whole theme (colours, typography, lighting, backdrop, effects base); absent falls back to the project's theme, and unknown ids degrade rather than crash. */
    themeId?: string;
    /** Staging override: replaces the theme's backdrop for this scene. */
    backdrop?: ThemeBackdrop;
    /** Fixed-background override: replaces the theme's camera-locked, frame-filling background for this scene (whole-value replacement, like `backdrop`); `{type:"none"}` cancels the theme's layer. */
    background?: ThemeBackground;
    /** Text-animation override: a whole spec replacing the theme's `textAnimation` for this scene (the backdrop pattern, what the picker writes); explicit per-primitive TSX props still win unless `textAnimationForce`. */
    textAnimation?: TextAnimationSpec;
    /** Flips the resolution order for this scene (the panel's Override): text primitives ignore their own TSX animation props and follow the sidecar/theme spec instead (timing props like `from`/`to`/`outAt` still apply); written when the user overrides coded motion, absent means the normal prop-wins order. */
    textAnimationForce?: boolean;
    /** Per-managed-item whole-spec motion exceptions, keyed by the item's stable key. */
    textAnimationOverrides?: Record<string, TextAnimationSpec>;
    /** Text-look override: a whole spec replacing the theme's `textLook` for this scene (the textAnimation pattern, what the picker writes); explicit per-primitive TSX props still win unless `textLookForce`. */
    textLook?: TextLookSpec;
    /** Flips the resolution order for this scene (the panel's Override): text primitives ignore their own TSX look props and follow the sidecar/theme spec instead; absent means the normal prop-wins order. */
    textLookForce?: boolean;
    /** Per-managed-item whole-spec look exceptions, keyed by the item's stable key. */
    textLookOverrides?: Record<string, TextLookSpec>;
    /** Partial lighting override: each present field fully replaces the layer below's (see `mergeLighting`); the long-shadow look is typically a per-scene low-elevation `sun` + `shadow` override rather than a whole new theme. Deep validation lives in `sceneLighting.ts`. */
    lighting?: LightingSpec;
    /** Overlay override: merges over the manifest's deck-wide `frame` for this scene (see `mergeFrameSpec`); `cutout` may be omitted to inherit the deck's shape, and `{enabled:false}` opts the scene out entirely. */
    frame?: FrameOverrideSpec;
    /** The layered-screenshot composition (one per scene; layers carry the multiplicity). Deep graph validation lives in `sceneLayeredScreenshot.ts`. */
    layeredScreenshot?: SceneDocLayeredScreenshot;
    /** LEGACY, read-only: the pre-merge video-window composition (one per scene), now a video `media` entry with a `window` block. Deep validation lives in `sceneVideoWindow.ts`. */
    videoWindow?: SceneDocVideoWindow;
    /** The before/after comparison block: side B's overrides plus the shared mask and divider track; side A is this doc itself. Deep normalisation lives in `sceneCompare.ts`. */
    compare?: SceneDocCompare;
    /** The chart block (one per scene): data, appearance, axes, labels and the keyframed data track. Defaults and sampling live in `sceneChart.ts`. */
    chart?: SceneDocChart;
    /** The terminal block (one per scene): screen-locked panel content, rendering its baked snapshot everywhere. Defaults and layout live in `sceneTerminal.ts`. */
    terminal?: SceneDocTerminal;
    /** The Website block (one per scene): a consent-gated native page while paused or presenting, with a captured PNG as deterministic render truth. */
    website?: SceneDocWebsite;
    /** Which animated track drives this scene; absent = "camera" (null-for-legacy). Switching never deletes the other tracks' keys. */
    animatedTrack?: "camera" | "layeredScreenshot" | "compare" | "chart" | "lighting";
    /** Stills export settings (see engine/stills.ts); absent = included with one automatic still. */
    stills?: SceneDocStills;
    /** Motion blur override: each present field replaces the project's `render.motionBlur` (see engine/motionBlur.ts); absent inherits. */
    motionBlur?: SceneDocMotionBlur;
    /** The room track: the backdrop colour cutting or flooding mid-scene with the staged lights following (see engine/sceneRoom.ts); absent renders exactly as before. */
    room?: SceneDocRoom;
    /** Tap pulses on the clock, in world space or on a sidecar device's screen (see engine/sceneTaps.ts); absent renders exactly as before. */
    taps?: SceneDocTap[];
    /** A frame split into tiles with a staggered reveal, drawn by `SplitField` or the host fallback (see engine/sceneMosaic.ts); absent renders exactly as before. */
    mosaic?: SceneDocMosaic;
  }

  /** One device entry, deliberately shaped as `Device` props plus a stable id. */
  export interface SceneDocDeviceSpec {
    id: string;
    /** Catalog id, e.g. `"iphone-15-pro"` (unknown or unavailable ids render as Android). */
    model: string;
    colour?: string;
    media?: DeviceMediaSpec;
    /** Foldables only: the outside display's media (`media` is the inside one). */
    coverMedia?: DeviceMediaSpec;
    placement?: DevicePlacement;
    motion?: DeviceMotionSpec;
    shadow?: DeviceShadowMode;
    /** Laptop lid opening in degrees (0 closed, default the model's authored angle); ignored by devices with no hinge. */
    lidDeg?: number;
    /** Foldables only: the hinge angle in degrees (0 closed, 180 open flat, default open). */
    foldDeg?: number;
    /** Foldables only: light both displays at every angle, instead of handing power from the outside one to the inside one as it opens. */
    bothScreensOn?: boolean;
    /** Foldables only: how the displays hand over as it folds. */
    foldTransition?: DeviceFoldTransitionSpec;
    /** Motion blur override; absent inherits the scene's Objects switch (see engine/motionBlur.ts). */
    motionBlur?: MotionBlurOverride;
  }

  export type SceneDocDuration =
    | { mode: "manual" }
    | {
        mode: "follow-media";
        sourceDeviceId?: string;
        /** `media` follows the entry `sourceMediaId` names; `videoWindow` is the legacy spelling for whichever entry serves as the window. */
        source?: "device" | "videoWindow" | "media";
        sourceMediaId?: string;
      };

  /** One staged 3D object, deliberately shaped like the device entry: a stable scene-local id plus a library reference and the shared placement block. */
  export interface SceneDocObjectSpec {
    id: string;
    /** Object library id: a bundled key or `ws:<slug>` (unknown ids degrade to nothing rendered). */
    objectId: string;
    placement?: DevicePlacement;
  }

  /** A registered scene: a default-exported `defineScene(...)` result. */
  export interface SceneModule {
    id: string;
    durationMs: number;
    Scene: ComponentType;
    /** Set by `loadProject`: the key the compiling realm holds this module under (`engine/sceneModules`). */
    key?: string;
  }

  /** Everything a scene can read. Available via hooks (`useTimeline`/`useFormat`/`useTheme`). */
  export interface SceneProps {
    time: SceneTime;
    format: FormatInfo;
    theme: Theme;
  }

  export function SceneStage(props: { children?: ReactNode; /** Stage floor height for a floor backdrop (world y; default −1.5). */ floorY?: number; }): ReactElement;

  /** Troika's textAlign values, 1:1 (never localise these; UI labels may). */
  export type SceneTextAlign = "left" | "center" | "right";

  /** Time exposed to a scene, all derived purely from the global clock. */
  export interface SceneTime {
    /** Milliseconds since this scene's start. */
    localMs: number;
    /** Milliseconds since the project start. */
    globalMs: number;
    /** Project progress in [0, 1]. */
    progress: number;
  }

  /** What every fill shares: an opacity and keys over any of its numbers (`tMs` is scene-local). */
  export interface ScreenFillProps {
    /** 0..1 (default 1). */
    opacity?: number;
    /** Keyframes over `opacity` and the fill's numeric props; a key's `ease` shapes the segment arriving at it. */
    keys?: readonly MotionKey[];
  }

  /** A camera-locked layer laid out in frame units: (0, 0) is the centre and `useFormat().frame` the full size, whatever the scene camera does, and nothing in the 3D pass can hide it (no depth test). Replaces a hand-built pose in front of `useSceneCamera()`. For flat primitives (text, images, shapes, `Vignette`, `Scrim`, `Gradient`): a 3D model needs its depth test, and its materials are shared with any world copy. Both orders draw inside the compositor's own passes, so preview, Present and export agree. */
  export function ScreenLayer(props: ScreenLayerProps): ReactElement;

  export interface ScreenLayerProps {
    /** "front" (default) draws over the finished frame, past depth of field; "back" draws over the background and under everything 3D, and its pixels go through the scene's effects and transitions like the backdrop. */
    order?: "front" | "back";
    children?: ReactNode;
  }

  /** Clear to a colour, linear or radial, for text to sit on. Mount inside a `ScreenLayer`. */
  export function Scrim(props: ScrimProps): ReactElement;

  export interface ScrimProps extends ScreenFillProps {
    /** The colour it deepens to: a theme token or hex (default "background"). */
    to?: Colour;
    /** "linear" (default) deepens along `angleDeg`; "radial" deepens from `centre` outward. */
    kind?: "linear" | "radial";
    /** Direction it deepens, degrees clockwise from up (default 180, solid at the bottom). */
    angleDeg?: number;
    /** Radial centre, frame fractions from the bottom left (default [0.5, 0.5]). */
    centre?: readonly [number, number];
    /** Where along the run it starts to show, 0..1 (default 0). */
    start?: number;
    /** Where along the run it goes solid, 0..1 (default 1). */
    end?: number;
  }

  /** A generator of floats in [0, 1), advancing on each call. */
  export type SeededRandom = () => number;

  /** One morph keyframe. Fields are per-property optional (see engine/keyframes.ts). */
  export interface SharedKeyframe {
    tMs: number;
    position?: [number, number, number];
    /** Euler XYZ, radians. */
    rotation?: [number, number, number];
    /** Uniform scale. */
    scale?: number;
    opacity?: number;
  }

  /** A fully-resolved morph transform for one frame. */
  export interface SharedTransform {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: number;
    opacity: number;
  }

  /** A frame split into tiles (project images, videos or theme colours) with a staggered reveal; the grid reflows per aspect unless `columns` fixes it. Without `tiles` it draws the sidecar `mosaic` block, and mounting it stands the host fallback down. */
  export function SplitField(props: SplitFieldProps): ReactElement | null;

  export interface SplitFieldProps {
    /** The tiles, in reading order; absent draws the sidecar `mosaic` block. */
    tiles?: SplitFieldTile[];
    /** Fixed column count; absent picks the most square grid for the aspect, so the field reflows. */
    columns?: number;
    /** Gap between tiles as a fraction of the field's short side (default 0.02). */
    gap?: number;
    reveal?: SceneDocMosaicReveal;
    /** Field size in world units (default the whole frame at the field's depth). */
    width?: number;
    height?: number;
    /** Default [0, 0, -0.05], just behind content at z = 0. */
    position?: V3;
  }

  export type SplitFieldTile = SceneDocMosaicTile;

  /** One staged library object, from a sidecar `spec` or an `objectId` placed in TSX. `readObjectAsset` suspends until the manifest + URLs land (unknown ids degrade to nothing), then `LoadedObject` suspends on the glb through the objects' own gltf cache (both pre-warmed by the export preamble and the option-preview capture). */
  export function StagedObject(props: StagedObjectProps): ReactElement;

  export type StagedObjectProps = { spec: SceneDocObjectSpec } | PlacedObjectProps;

  /** Stagger granularities: words split on whitespace, chars are non-whitespace characters; paragraph granularities (spelled through `delivery`, never the public `stagger` prop) split on `\n` / blank lines and walk Y-key unit boundaries. */
  export type StaggerGranularity = "char" | "word" | "paragraph" | "paragraph-group";

  /** Stamps its children in at `at`: the `stampScale` pop (its defaults are contract) about the group origin, with an optional small rotation settle. */
  export function Stamp(props: StampProps): ReactElement;

  export interface StampProps extends StampScaleOptions {
    /** Scene-local ms the stamp starts (default 0); hidden (at `from` scale) before it. */
    at?: number;
    /** Scene-local ms the stamp LANDS (first reaches full size), on a beat or a cut; the stamp starts its measured lead earlier. Wins over `at`. */
    hitAt?: number;
    /** Optional settle: starts this many degrees off (about Z) and swings back to 0 with a small overshoot over the stamp. */
    rotateDeg?: number;
    position?: V3;
    /** Radians; the settle adds to Z. */
    rotation?: V3;
    /** Base scale the stamp multiplies. */
    scale?: number;
    children?: ReactNode;
  }

  export interface StampScaleOptions {
    /** Scale before the stamp starts. */
    from?: number;
    /** Overshoot scale reached at `inMs`. */
    peak?: number;
    /** `from` to `peak`, outCubic. */
    inMs?: number;
    /** `peak` back to 1, inOutSine. */
    settleMs?: number;
  }

  /** Text-animation presets, the library behind `theme.textAnimation` and `AnimatedHeadline`'s `preset`/`ease`/`stagger` props: everything here is PURE math over the local scene clock so preview and the deterministic export loop agree byte-for-byte, and easing goes through the golden-tested `engine/ease` table, never an animation runtime. IMPORTANT (the null-for-legacy contract): when nothing is configured, `resolveTextAnimation` returns null and AnimatedHeadline runs its original v0 linear-ramp code verbatim, so committed projects on legacy themes must not change by a byte. */
  export const TEXT_PRESET_NAMES: readonly ["none", "fade", "fade-up", "blur-in", "slide", "mask-reveal", "fade-scale", "twist-scale", "scatter-scale", "tracking", "slam", "dolly", "chromatic", "line-stretch", "highlight-wipe", "rise-mask", "word-cycle", "ribbon", "stand-up", "spring-pop", "spotlight", "underline-draw", "orbit", "weight-build", "develop", "flip-cascade", "converge", "glint-wipe", "vapor", "stamp", "build", "typewriter"];

  /** A tap pulse: an analytic ring (and centre dot) popping in, pulsing once and fading on the video editor's tap curve, facing +z. Hidden outside its 550 ms window. */
  export function TapRing(props: TapRingProps): ReactElement;

  export interface TapRingProps {
    /** Scene-local ms the pulse starts; it runs the video editor's 550 ms tap curve. */
    at: number;
    /** Outer ring radius at rest scale, world units (default 0.12). */
    radius?: number;
    /** A theme token hex (default the accent). */
    colour?: string;
    /** Draw the centre dot (default true). */
    dot?: boolean;
    position?: V3;
    renderOrder?: number;
  }

  /** A typeset block in world units: `ascent` runs from the block top to the first baseline and `descent` from the last baseline to the block bottom, so one line has `ascent + descent === height`. */
  export interface TextMetrics {
    width: number;
    height: number;
    ascent: number;
    descent: number;
    lines: number;
  }

  /** The AnimatedHeadline props that shape the measured block; pass the same values the headline gets. */
  export interface TextMetricsOptions {
    fontSize?: number;
    face?: "headline" | "body";
    fontRef?: FontRef;
    lineHeight?: number;
    letterSpacing?: number;
    styleKey?: string;
  }

  export type TextPresetName = (typeof TEXT_PRESET_NAMES)[number] | typeof STATIC_TEXT_PRESET;

  export interface Theme {
    /** Stable id; what `project.json.themeId` matches (`kookaburra-*` bundled, `ws:<slug>` user). */
    id: string;
    /** Display name for pickers. */
    name: string;
    mode?: ThemeMode;
    colors: {
      background: string;
      text: string;
      accent: string;
      muted: string;
    };
    gradients?: Record<string, GradientSpec>;
    /** Chart series swatches (sRGB hexes, six in the bundled themes), taken in order and wrapped when a chart has more series. Optional and additive: a theme without it derives its ramp from `accent` instead (toolkit/chart/palette.ts), and parses exactly as before. */
    chartColors?: string[];
    typography: {
      headline: FontRef;
      body: FontRef;
      /** Modular scale ratio between type steps. */
      scale: number;
      /** One face for ALL chart text, replacing both of the above there. Injected by the project's `typography.chart` override (`engine/project.ts`), never parsed from theme.json; absent means charts take headline/body as before. */
      chart?: FontRef;
    };
    motion: {
      /** Milliseconds. */
      durations: { fast: number; base: number; slow: number };
      /** anime.js / d3-ease easing names. */
      easings: { standard: string; emphasized: string };
    };
    textAnimation?: TextAnimationSpec;
    textLook?: TextLookSpec;
    card?: ThemeCard;
    /** v9 shape in memory (the v8 `key` alias normalises to `sun` on read); theme JSON files stay v8. */
    lighting?: LightingSpec;
    environment?: ThemeEnvironment;
    backdrop?: ThemeBackdrop;
    background?: ThemeBackground;
    /** Project-wide postprocessing defaults; optional and absent by default. A theme without `effects` renders through the original composer-free path, preserving the v0-v2 byte-identical export. Per-scene overrides layer on top via `resolveEffectParams`. */
    effects?: EffectsConfig;
  }

  /** Title + optional subtitle with theme-scale sizing and safe-area alignment: the standard top-of-scene text block. Alignment resolves prop → sidecar `textLayout.align` → centre, so the inspector can steer scenes that don't hard-code it. */
  export function TitleBlock(props: TitleBlockProps): ReactElement | null;

  export interface TitleBlockProps {
    title: string;
    /** Empty or absent recentres the title (the natural single-line format). */
    subtitle?: string;
    /** Beats the sidecar's `textLayout.align`; the block anchors against the safe area. */
    align?: SceneTextAlign;
    /** Title reveal window (scene-local ms); the subtitle rides 350ms behind. */
    from?: number;
    to?: number;
    /** Title size in world units (portrait 0.34 / landscape 0.56); the subtitle derives via `theme.typography.scale`. */
    fontSize?: number;
    /** Offset added after alignment (world units). */
    position?: V3;
    /** Wrap width in world units for both lines; unset means no wrapping. */
    maxWidth?: number;
    /** Title fill: a token or raw hex; beats the sidecar's `textStyle.titleColor`. */
    titleColor?: "text" | "muted" | "accent" | (string & {});
    /** Subtitle fill token or raw hex (default "muted"); beats the sidecar's `textStyle.subtitleColor`. */
    subtitleColor?: "text" | "muted" | "accent" | (string & {});
    /** Subtitle reveal delay behind the title, ms (default 350). */
    subtitleDelayMs?: number;
    /** Register the title/subtitle text keys (default true). Legacy host fallbacks keep this off. */
    register?: boolean;
    /** Render registration role. Host fallbacks use managed so they do not count as authored consumers. */
    managedTextRole?: ManagedTextRenderRole;
    /** Header icon drawn above the title: an emoji/glyph or a project asset path. Defaults to the sidecar's `headerIcon`, so a scaffolded scene's own `TitleBlock` shows it without wiring; overlay scenes carry it on `frame.icon` instead. */
    icon?: string;
  }

  /** A 3D vector, used for positions / rotations / scales. */
  export type V3 = [number, number, number];

  /** Embedded video clip: the ffmpeg sidecar pre-extracts the source to a CFR frame sequence, and frame selection is a pure function of the timeline (never `HTMLVideoElement` seeking) so preview and export pick the identical frame; the sampling/binding core lives in `engine/clipTexture.ts` (shared with the Device screen), and this primitive is the plane-mesh consumer, sized via `fit`. See docs/determinism.md. */
  export function VideoClip(props: VideoClipProps): ReactElement;

  export interface VideoClipProps {
    /** Project-relative source path, e.g. `"assets/clip.mp4"`. Extracted to frames on demand. */
    src: string;
    /** When the clip starts, in ms (local scene time). */
    startMs: number;
    /** `contain` fits the whole clip in the frame (letterbox); `cover` fills + crops. */
    fit?: "cover" | "contain";
    position?: V3;
    scale?: number;
  }

  /** The scene document's windowed media: a screen recording (or a still) presented as a floating rounded window with a drop shadow, over whatever the scene stages behind it; sits in world space so the per-scene camera moves around it with real parallax. Registers the scene as the window family's consumer so the host-side fallback stands down. */
  export function VideoWindow(_props?: VideoWindowProps): ReactElement;

  export interface VideoWindowProps {
    /** Reserved: the primitive is sidecar-driven; props may later override the doc. */
    _reserved?: never;
  }

  /** Darkened edges, clear centre. Mount inside a `ScreenLayer`. */
  export function Vignette(props: VignetteProps): ReactElement;

  export interface VignetteProps extends ScreenFillProps {
    /** The edge colour: a theme token or hex (default black). */
    colour?: Colour;
    /** How far in the clear centre reaches, 0..1 (default 0.45). */
    start?: number;
    /** How far out it reaches full strength, 0..1 (default 1). */
    end?: number;
  }

  /** Procedural line grid with a travelling wave: the lattice is built once (pure function of size/divisions), and per-frame the Y displacement is recomputed on the CPU as a pure function of `useTimeline()` (no RNG, no shader time uniform) during commit, so the export loop's canvas-commit barrier sees it before capture. */
  export function WireGrid(props: WireGridProps): ReactElement;

  export interface WireGridProps {
    /** Grid extent (a size × size square in the local XZ plane), in world units. */
    size?: number;
    /** Cells per side. */
    divisions?: number;
    /** Wave height, in world units. 0 = flat static grid. */
    amplitude?: number;
    /** Wave length, in world units. */
    wavelength?: number;
    /** Wave travel speed, in cycles/second, a pure function of the timeline. */
    speed?: number;
    /** Theme colour token. */
    tone?: "text" | "accent" | "muted";
    /** Line opacity (lines don't bloom hard; keep them a quiet backdrop). */
    opacity?: number;
    /** Glow: a target luminance (above a bloom threshold over 1) reached by raising only the tone's full channels, unlit with tone mapping off so it still lands exactly on the token (see `glowColour`). Absent renders as before. */
    glow?: number;
    position?: V3;
    /** Base rotation in radians; lay it flat as a floor (default) or tilt it as a backdrop. */
    rotation?: V3;
  }

  /** Clamps to [0, 1]; NaN reads as 0. */
  export function clamp01(x: number): number;

  /** Create a mulberry32 generator from an integer seed (fractional seeds are truncated). */
  export function createSeededRandom(seed: number): SeededRandom;

  /** `fg` at opacity `a` over a room colour, as the opaque hex a CSS overlay would show (the `liftColour` display-domain blend), so text and panels over a room stay exact. */
  export function cssOpacity(fg: string, room: string, a: number): string;

  /** Every scene file must `export default defineScene({...})`; an identity wrapper today, kept as the seam for future validation/registration. */
  export function defineScene(cfg: SceneModule): SceneModule;

  /** Resolve a colour spec, degrading to the model's default on unknown ids. */
  export function deviceColour(spec: DeviceSpec, colourId: string | undefined): DeviceColourSpec;

  /** A point on a display, `lift` off the glass, in the device's local fitted frame (placement scale 1). */
  export function deviceScreenLocal(model: string, u: number, v: number, lift?: number, hinge?: DeviceScreenHinge): V3;

  /** A point on a display in world space, for a device standing at `pose`. */
  export function deviceScreenPoint(model: string, u: number, v: number, pose: DeviceScreenPose, lift?: number): V3;

  /** The display rect a model renders with here. A device without a cover display answers `"cover"` with its one screen, which is where the Android fallback shows a foldable's cover media. */
  export function deviceScreenRect(model: string, display?: DeviceScreenDisplay): DeviceScreenRect;

  /** Evaluates the named ease at progress `t`, clamped to [0, 1]; unknown names fall back to `DEFAULT_EASE` (a scene document edited by hand must degrade, not crash). */
  export function ease(name: string, t: number, opts?: EaseOptions): number;

  /** The named curve as a function of raw progress (no clamping; `ease` and `ramp` clamp); unknown names fall back to `DEFAULT_EASE`. Without `overshoot` the table function itself is returned. */
  export function easeFn(name: string, opts?: EaseOptions): EaseFn;

  /** Group fade over a time range. Apply the returned opacity to a `<group>` (or a material); a pure function of the timeline, safe for deterministic export. */
  export function fade(t: SceneTime, range: [number, number]): { opacity: number };

  /** The size that fits a block measured at `fontSize` inside `maxWidth`: never above `fontSize` itself, and `fontSize` untouched when there is nothing to fit. */
  export function fitFontSize(metrics: TextMetrics, fontSize: number, maxWidth: number): number;

  /** The visible frame's world size at depth `z` under the base camera: `format.frame` scaled by the frustum's growth from the content plane (exactly `format.frame` at z = 0, zero at or behind the camera). Scenes place backdrops behind their text with it. */
  export function frameAtDepth(format: FormatInfo, z: number): { width: number; height: number };

  /** `hex` brightened in linear light to luminance `glow` by raising only its full (255) channels: past a bloom threshold above 1 it glows, and once clamped (tone mapping off, or `linear`) it lands exactly on `hex`. A colour with no full channel scales whole, which is not exact; a `glow` at or under its own luminance returns it unchanged. */
  export function glowColour(hex: string, glow: number): Color;

  export function isDeviceAvailable(id: string): id is DeviceId;

  export function isDeviceId(id: string): id is DeviceId;

  export function isEaseName(name: unknown): name is EaseName;

  export function isTextPresetName(name: string): name is TextPresetName;

  export const lerp: (a: number, b: number, t: number) => number;

  /** Blends `from` toward `to` by `amount` in DISPLAY (sRGB) space, returning a hex string. Perceptually even and symmetric between light and dark themes (the overlay panel's surface-lift maths, shared so scenes can derive secondary surfaces from theme tokens). Pure and deterministic. */
  export function liftColour(from: string, to: string, amount: number): string;

  /** Metrics for one string; null until its face has been parsed. */
  export function measureText(text: string, opts: MeasureTextOptions): TextMetrics | null;

  /** Media pixel coordinates (top-left origin) to screen UV under the display's cover fit; pixels cropped off the screen land outside 0..1. */
  export function mediaPixelToScreenUv(model: string, pixel: [number, number], media: { width: number; height: number }, display?: DeviceScreenDisplay): [number, number];

  /** A level 0..1 that fires at each of `times` (scene-local ms, e.g. `useBeatGrid()` bars or `useCues()` values) and falls back to exactly 0 between them; where pulses overlap the strongest wins. `time` is `useTimeline()` or scene-local ms. A pure function of time, so scale, glow or opacity driven by it exports deterministically. Object motion blur shifts `useTimeline()`, so a pulse blurs with its scene: give it an attack of at least one frame (17 ms) so the rise smears rather than ghosting. */
  export function pulse(time: SceneTime | number, times: number | readonly number[], opts: PulseOptions): number;

  /** Eased progress of `localMs` through [startMs, endMs] (the time is clamped, a Back ease may still overshoot); a zero or negative span steps from 0 to 1 at `startMs`. */
  export function ramp(localMs: number, startMs: number, endMs: number, easeName?: string, opts?: EaseOptions): number;

  /** Preserves known ids in documents while rendering unknown or unavailable models as Android. */
  export function resolveAvailableDeviceId(id: string): DeviceId;

  export function resolveAvailableDeviceSpec(id: string): DeviceSpec;

  export function resolveDeviceLayout(devices: ReadonlyArray<LayoutDeviceLike>, layout: SceneDocDeviceLayout, format: FormatInfo): DevicePlacement[];

  /** Samples keyed values at `localMs`: holds the first key before it and the last after it; each segment eases by its arriving key's `ease`. Numbers and equal-length number arrays interpolate, anything else holds the earlier key's value. A property missing from a key interpolates across the keys that set it. */
  export function sampleKeys<K extends MotionKey>(keys: readonly K[], localMs: number, opts?: SampleKeysOptions): SampledKeys<K>;

  /** Samples the morph track at a global time: linear interpolation between the surrounding keys that define each property, clamped outside the keyed range. Pure: same (track, t) → same transform, so preview and export agree by construction. */
  export function sampleSharedTransform(track: SharedKeyframe[], globalMs: number): SharedTransform;

  /** Screen UV to media pixel coordinates (top-left origin), the inverse of `mediaPixelToScreenUv`. */
  export function screenUvToMediaPixel(model: string, uv: [number, number], media: { width: number; height: number }, display?: DeviceScreenDisplay): [number, number];

  /** Group slide over a time range. Returns a normalised `offset` (1 → 0) to drive a position on the given axis. Pure function of the timeline; export-safe. */
  export function slide(t: SceneTime, range: [number, number], _axis: "x" | "y"): { offset: number };

  /** A "stamped in" pop: returns the scale for ms since the stamp started (`from` before 0, 1 once settled). */
  export function stampScale(props?: StampScaleOptions): (msSinceStart: number) => number;

  /** Bar-to-ms that never needs a null check on the hook: `at(bar, beat?, sixteenth?)` is scene-local ms, or null with one log line when the project has no `audio.grid` (`at(13) ?? 4000` keeps the scene's own timing). */
  export function useBeatAt(): (bar: number, beat?: number, sixteenth?: number) => number | null;

  /** The beat grid in scene-local time, or null when the project has no `audio.grid` (the scene then falls back to its own timing). */
  export function useBeatGrid(): BeatGrid | null;

  /** The world rectangle the scene camera sees on the plane at depth `z` this frame (its bounding box when the camera is tilted or rolled); zero-sized when the camera looks past the plane. */
  export function useCameraFrame(z?: number): PlaneFrame;

  /** The project's `audio.cues` as scene-local ms by id; `{}` when it has none, and a cue that can't resolve is left out. */
  export function useCues(): Readonly<Record<string, number>>;

  /** The band a component is mounted in, or null outside a DepthStage (mount-anywhere, the SceneStage precedent). */
  export function useDepthBand(): DepthBand | null;

  /** Inside a `Device`: the screen it renders this frame, else null. */
  export function useDeviceScreen(): DeviceScreen | null;

  /** Reactive format info for the currently selected export aspect. Inside a scene rendering through an overlay cutout, `<SceneHost>` supplies a cutout-scoped override (the cutout as its own frame); everywhere else this is null and it falls back to the export format, byte-identical to before overlays. Mirrors the context-first/store-fallback shape of `useTheme()`. */
  export function useFormat(): FormatInfo;

  /** The enclosing group's animation state, or null outside groups; the hook custom primitives use to participate (multiply `alpha` into your own opacity CPU-side). */
  export function useGroupAnimation(): GroupAnimationState | null;

  export function useProjectShared(path?: string, fallback?: unknown): unknown;

  /** The scene's normalised rig track, or null when it has no rig. Derived from the scene doc already in context, so preview and export resolve it identically by construction rather than by a plumbing rule. */
  export function useRigTrack(): SceneRigTrack | null;

  /** The scene's room at the frame instant (its colour, any flood in progress and the room's lighting pose), or null when the scene has no sidecar `room`. */
  export function useRoom(): RoomSample | null;

  /** The scene camera's current pose: the scene's free-flight rig or orbit track at this scene time, else the project camera track, else the base camera. */
  export function useSceneCamera(): SceneCamera;

  /** The scene document's chart block, fully resolved (defaults baked, data track sorted), or null when absent; registers the scene as a consumer so a host-mounted `ChartFallback` stands down (the useSceneMedia pattern). */
  export function useSceneChart(): ResolvedChart | null;

  /** The scene document's devices array as `Device`-ready props; unknown models pass through since `Device` itself degrades (console error + fallback geometry) rather than crashing the tree. A `deviceLayout` block resolves to per-aspect placements HERE, so every consuming scene (any kind, any scaffold vintage) honours it without template changes; templates that resolve the block themselves recompute the identical values (the resolver is pure and ignores input placements beyond `ground`). */
  export function useSceneDevices(): SceneDeviceProps[];

  /** The mounted scene's document, or null when it has none. */
  export function useSceneDoc(): SceneDoc | null;

  /** The scene document's layeredScreenshot block, deep-validated, or null when absent; registers the scene as a consumer so `LayeredScreenshotFallback` stands down (the useSceneDevices pattern). */
  export function useSceneLayeredScreenshot(): NormalizedLayeredScreenshot | null;

  /** The scene document's objects array; registers the scene as a consumer so `ObjectsFallback` stands down (the useSceneDevices pattern). */
  export function useSceneObjects(): SceneDocObjectSpec[];

  /** True inside an actively-lighting `<SceneStage>`; the staged primitives' bundled lit sets (inline rig + one-shot `<Environment>`) stand down by default, though an explicit `lit` prop still wins. */
  export function useSceneStaged(): boolean;

  /** Resolves code-owned or embedded copy, plus the matching item while a managed scaffold retains its template layout. */
  export function useSceneText(key: string, fallback?: string, managedTextRole?: ManagedTextRenderRole): string;

  /** The world-size block an `AnimatedHeadline` with this `textKey`, text and options typesets (sidecar Font, Size and LineHeight overrides included), or null until its face has loaded and it has measured real ink: never a 0-wide first measure, so a scene can divide by `width` once it has one. Captures wait for it, so exported frames always see the measured layout. */
  export function useTextMetrics(key: string | undefined, text: string, opts?: TextMetricsOptions): MeasuredText | null;

  /** The active theme: inside `<SceneHost>` it's the scene's resolved theme (project theme unless the sidecar overrides `themeId`); elsewhere it falls back to the editor store's theme, since r3f's reconciler doesn't bridge context outside the `<Canvas>` boundary. */
  export function useTheme(): Theme;

  /** Reactive scene time for the active scrub position. `localMs` is relative to the enclosing scene's start (supplied by `<SceneHost>` via `SceneContext`); with no scene context it falls back to project time so a lone scene anchored at t=0 keeps `localMs === globalMs` (the v0 contract). `progress` stays project-global per the `SceneTime` type; authors derive scene-local progress from `localMs / scene.durationMs`. Inside a motion blur sample the time moves by the scene's shutter offset times `scale` (default: the `MotionBlurContext`); 0 never moves and never re-renders for a sample. */
  export function useTimeline(scale?: number): SceneTime;

  /** Bloom / glow params (see engine/effects.ts). `intensity` 0 = no bloom. */
  interface BloomParams {
    intensity: number;
    luminanceThreshold: number;
    luminanceSmoothing: number;
  }

  type CaretInfo = { textRenderInfo?: { caretPositions?: Float32Array } };

  /** The flat look, everything a fraction of the plot's SHORT edge so a chart reads the same in every aspect. The appearance-preset phase overrides these field by field. */
  interface Chart2DAppearance {
    /** Tick and category label size. */
    labelFraction: number;
    /** Value label size, relative to a tick label. */
    valueScale: number;
    /** Axis name size, relative to a tick label. */
    axisNameScale: number;
    /** Legend label size, relative to a tick label. */
    legendScale: number;
    /** Gap between the plot edge and its furniture, relative to a tick label. */
    gapScale: number;
    /** Line stroke thickness. */
    strokeFraction: number;
    /** Gridline thickness. */
    gridFraction: number;
    gridOpacity: number;
    /** Dashed gridline dash and gap lengths. */
    dashFraction: number;
    dashGapFraction: number;
    /** Area fill opacity under its stroke. */
    areaOpacity: number;
    /** Draw the value curve over an area fill. */
    areaStroke: boolean;
    /** Dots at line data points. */
    points: boolean;
    pointFraction: number;
    /** Angular gap between pie slices, radians. */
    pieGap: number;
    /** Pie outer radius as a fraction of half the plot's short edge. */
    pieRadius: number;
  }

  interface Chart3DProps extends ChartRendererProps {
    /** The resolved appearance; absent takes the catalogue's default preset, so the primitive still stands alone. */
    surface?: ChartStyleSurface;
  }

  type ChartAnimationDelivery = "all" | "series" | "cascade";

  type ChartAnimationFrom = "start" | "end" | "centre" | "edges" | "shuffle";

  /** How an area fill is painted: flat at `areaOpacity`, or a vertical ramp built from `chartGradientRamp`. */
  type ChartAreaGradient = "none" | "vertical";

  type ChartAxisKey = "x" | "y";

  /** One rectangular mark (column, bar or stack segment), already orientation-resolved: `x`/`width` run right, `y`/`height` run up, whatever the chart type. */
  interface ChartBarMark {
    seriesIndex: number;
    categoryIndex: number;
    /** Left edge in plot space. */
    x: number;
    /** Bottom edge in plot space. */
    y: number;
    width: number;
    height: number;
    /** The datum behind the mark (after stacked clamping). */
    value: number;
    /** Plot-space coordinate along the value axis the mark grows FROM: the edge that stays put while it builds. */
    base: number;
    /** Data-space value the segment stacks on top of; 0 when unstacked. */
    stackBase: number;
    /** Where the value label sits, resolved from `labels.values.location`, the orientation and the sign; renderers nudge it outward by their own padding. */
    labelAnchor: ChartPoint;
  }

  interface ChartCategoryAxis {
    name: string | null;
    labels: boolean;
  }

  interface ChartCategoryAxisLayout {
    bands: ChartCategoryBand[];
    name: string | null;
    labels: boolean;
  }

  interface ChartCategoryBand {
    index: number;
    label: string;
    /** All 0..1 along the category axis; band 0 starts at 0 (left for columns, bottom for bars). */
    start: number;
    centre: number;
    end: number;
  }

  /** Which theme face chart numerals and labels take. */
  type ChartFontEmphasis = "body" | "headline";

  type ChartGridlineStyle = "hair" | "dashed" | "none";

  interface ChartGridlines {
    visible: boolean;
    style: ChartGridlineStyle;
  }

  interface ChartLegend {
    visible: boolean;
    position: ChartLegendPosition;
  }

  /** Legend swatches as plain dots, or as filled chips (the FrameChip pill treatment). */
  type ChartLegendChrome = "plain" | "chips";

  type ChartLegendPosition = "top" | "bottom" | "trailing";

  /** A vertex on a line or area: one per category at its band centre, plus the vertices the axis trim inserts where a segment crosses a bound. */
  interface ChartLinePoint extends ChartPoint {
    /** The category whose datum and build channels this vertex rides; an inserted crossing takes the left end of the segment it split. */
    categoryIndex: number;
    value: number;
    /** True on a category point, false on an inserted crossing, which carries no datum of its own: no dot and no value label ride it. */
    datum: boolean;
    /** False where the true curve has left the plot band and only the clamped edge is drawn: the stroke breaks here. Always true when the trim is off. */
    inside: boolean;
  }

  /** Which way the marks grow: columns and lines run vertically, bars horizontally. Resolved from the type, never re-derived downstream. */
  type ChartOrientation = "vertical" | "horizontal";

  interface ChartPieLayout {
    slices: ChartPieSlice[];
    /** Fractions of the outer radius; the renderer owns the pie's size on screen. */
    innerRadius: number;
    outerRadius: number;
    total: number;
  }

  interface ChartPieSlice {
    seriesIndex: number;
    categoryIndex: number;
    /** Radians clockwise from 12 o'clock (the d3-arc convention). */
    startAngle: number;
    endAngle: number;
    midAngle: number;
    /** The datum, negatives clamped to 0. */
    value: number;
    /** Share of the total, 0..1; 0 for every slice when the total is 0. */
    fraction: number;
  }

  /** A point in the 0..1 plot rect (x right, y up). */
  interface ChartPoint {
    x: number;
    y: number;
  }

  /** One build's two lookups: `at` per element, `series` per series. A fresh object (and fresh closures) per frame, which is what the instanced writers key their dep arrays on. */
  interface ChartRevealSampler {
    at: ChartRevealFn;
    series: ChartSeriesRevealFn;
  }

  /** What every renderer accepts for `reveal`: the per-element lookup alone (a scene's own override) or a whole sampler. `revealSource.ts` reads either shape, so a renderer never branches on which. */
  type ChartRevealSource = ChartRevealFn | ChartRevealSampler;

  /** One line/area series, index-paired across all three arrays: the value curve (already trimmed into the plot band), the boundary each vertex grows OUT of (never trimmed, so an entrance still rides in from off-plot), and the boundary an area fills TO (clamped, so a fill never spills past the axis). The `datum` and `inside` flags on `baseline` mirror the curve's. */
  interface ChartSeriesLayout {
    seriesIndex: number;
    points: ChartLinePoint[];
    baseline: ChartLinePoint[];
    fillBaseline: ChartPoint[];
  }

  /** Per-series build state. `draw` is left-to-right draw-on progress over the series polyline, and doubles as the wipe clip edge along the category axis (1 = fully drawn). `headX` is the plot-space x of the leading head, for its glow; -1 when no head is travelling. `alpha` is the series-level opacity a stroke or fill takes as one unit. */
  interface ChartSeriesReveal {
    draw: number;
    headX: number;
    alpha: number;
  }

  type ChartSeriesRevealFn = (seriesIndex: number) => ChartSeriesReveal;

  /** The resolved appearance BOTH renderers consume: one flat facet, one lit facet, and the treatments that cross both. `resolveChartStyle` is its only maker, and nothing downstream of it reads `style.preset`. */
  interface ChartStyleSurface {
    /** The preset actually applied (`boardroom` after a degrade). */
    id: string;
    twod: ChartStyleSurface2D;
    threed: ChartStyleSurface3D;
    /** Gridline presence, 0..2: multiplies `twod.gridOpacity` flat and the wall-grid lift in 3D; 0 suppresses gridlines the block asked for. */
    gridStyleWeight: number;
    legendChrome: ChartLegendChrome;
    /** Multiplies `twod.pieGap`, which both dimensions cut their arcs with. */
    pieGapScale: number;
    /** Multiplies the authored `style.cornerRadius`; resolve caps it so the product never passes 1. */
    cornerRadiusScale: number;
    fontEmphasis: ChartFontEmphasis;
    /** OKLCH lightness step per series index, away from the background (`chartSeriesTint`); 0 leaves the palette as resolved. */
    seriesLightnessStep: number;
  }

  /** The flat facet of an appearance preset: every `Chart2DAppearance` fraction the 2D metrics resolve, plus the treatments only a preset asks for. A superset, so `chart2dMetrics` takes it as is. */
  interface ChartStyleSurface2D extends Chart2DAppearance {
    /** Value labels sit in a filled pill rather than floating over the mark. */
    labelPill: boolean;
    /** 0..1: how far tick and category labels lift from the muted token toward the text token (0 = muted, the flat default). */
    tickWeight: number;
    /** Draw a rule along the category axis at the value baseline. */
    axisLine: boolean;
    areaGradient: ChartAreaGradient;
    /** Multiplies every stroke THICKNESS the metrics resolve (line stroke, gridline, point radius, axis line); the per-element fractions stay comparable across presets. */
    strokeWidthScale: number;
  }

  /** The lit facet: `MeshStandardMaterial` params plus the physical extras a gloss or glass preset needs (the renderer builds a `MeshPhysicalMaterial` only when `clearcoat` or `transmission` is non-zero) and the 3D furniture flags. */
  interface ChartStyleSurface3D {
    roughness: number;
    metalness: number;
    /** 0 = no clearcoat. */
    clearcoat: number;
    clearcoatRoughness: number;
    /** 0 = opaque; above 0 makes frosted glass with `thickness` and `ior`. */
    transmission: number;
    /** Refraction thickness in world units at the default depth; `resolveChartStyle` scales it by the authored `style.depth`. */
    thickness: number;
    ior: number;
    /** 0..1 emissive rim along the mark's edges: the neon look, in-material, never post-processing bloom. */
    emissiveEdge: number;
    /** Multiplies the extrusion bevel on pie slices and ribbon edges; bar boxes take `cornerRadiusScale` instead. */
    bevelScale: number;
    /** Draw the back-wall gridlines. */
    wallGrid: boolean;
    /** Let the chart lay its own floor and catch a shadow when the stage has none. */
    floorShadow: boolean;
    /** Stack segments take the matte finish `chartStackSurface` returns, so a tall stack is not a column of highlights. */
    interiorFlatStacks: boolean;
  }

  /** A value-axis tick. Labels are NOT formatted here: callers run `value` through the chart formatter so axis labels, value labels and counters all agree. */
  interface ChartTick {
    value: number;
    /** 0..1 along the value axis. */
    position: number;
  }

  interface ChartValueAxis {
    /** null hides the axis name. */
    name: string | null;
    /** null is auto (nice scale over the data). */
    min: number | null;
    max: number | null;
    /** Cut lines and areas AT the bound they cross instead of letting them run outside the plot. On by default and inert until a bound is actually exceeded, which takes a manual scale or the scale a keyframed track pins (its upper envelope, so a negative dip or an overshooting segment ease can still leave it). Bars clamp regardless. */
    trim: boolean;
    /** Divisions of the value axis: exact when both bounds are manual, a tick-density target when either is auto. */
    steps: number;
    format: ChartValueFormat;
    gridlines: ChartGridlines;
    labels: boolean;
  }

  interface ChartValueAxisLayout {
    min: number;
    max: number;
    ticks: ChartTick[];
    /** Tick positions to draw a line at; empty when gridlines are off. */
    gridlines: number[];
    gridlineStyle: ChartGridlineStyle;
    /** Position of value 0; outside 0..1 when the domain excludes zero. */
    zero: number;
    name: string | null;
    labels: boolean;
  }

  /** The chip behind every value label. Its PRESENCE forces a chip on whatever the appearance preset says, and each field overrides the derived pill; null (absent) leaves the preset's own pill maths untouched. Flat charts only: 3D value labels billboard and their chips cannot ride that transform yet. */
  interface ChartValueLabelBackground {
    /** Theme token or hex; null takes the derived pill colour. */
    colour: string | null;
    opacity: number;
    /** Corner radius as a fraction of the chip height, capped at the capsule 0.5. */
    radius: number;
  }

  /** Where a value label sits relative to its mark, along the value axis: outside the growing end, centred in the mark, or at the base. */
  type ChartValueLabelLocation = "above" | "inside" | "below";

  interface ChartValueLabels {
    visible: boolean;
    location: ChartValueLabelLocation;
    format: ChartValueFormat;
    countUp: boolean;
    /** Vertical nudge in VALUE FONT SIZES, positive lifting: uniform across chart sizes and both dimensions. 0 places labels exactly where they always sat. */
    offsetY: number;
    background: ChartValueLabelBackground | null;
  }

  /** A full data snapshot for keyframed data (the Magic Chart model): same series and category counts as the block's own data, values only. */
  interface ChartValuesPose {
    values: number[][];
  }

  type Colour = "background" | "text" | "muted" | "accent" | (string & {});

  /** Multi-device layout presets, resolved to per-aspect placements in `toolkit/device/layout.ts`. */
  const DEVICE_LAYOUT_PRESETS: readonly ["row", "toe-in", "arc", "cascade", "hero", "depth-pair"];

  interface DashStyleProps {
    /** Line weight in world units (default 0.02). */
    thickness?: number;
    /** Dash length in world units (default 0.12); each run starts and ends on a dash, so dashes stretch slightly to fit. */
    dash?: number;
    /** Gap between dashes in world units (default 0.08). */
    gap?: number;
    /** A theme token hex (default the theme muted colour). */
    color?: string;
    opacity?: number;
    /** Draw-on, 0..1 (default 1, fully drawn). */
    progress?: number;
    /** Round dash ends. */
    round?: boolean;
    position?: V3;
    /** Radians. */
    rotation?: V3;
    renderOrder?: number;
  }

  /** How auto-fit normalises the model into the scene (Device.tsx's Box3 fit). */
  interface DeviceFitSpec {
    /** World-space extent the fit normalises; default "height" (the phone behaviour). */
    axis?: "height" | "width";
    /** World units the chosen axis fits to; default TARGET_WORLD_HEIGHT (2.6). */
    target?: number;
  }

  /** A foldable's hinge. The glb carries a clip keyed ONE FRAME PER DEGREE (time = foldDeg / degPerSecond; 0 closed), with the camera half baked static so closed and open both face glTF +Z. Built by scripts/blender-duo-prepare.py. */
  interface DeviceFoldSpec {
    clip: string;
    degPerSecond: number;
    /** The flat-open angle, and the pose when the doc sets none. */
    openDeg: number;
    defaultDeg: number;
    /** x sign of the static camera half when open, seen from +Z. */
    anchorSide: -1 | 1;
    /** Fitted distance from the hinge to a half's free edge. */
    halfWidth: number;
    /** Which edge of the cover display's own media sits on the hinge. */
    coverHingeEdge: "left" | "right";
  }

  /** Options a scene may set on a foldable; all optional, all clamped at resolve time. */
  interface DeviceFoldTransitionSpec {
    /** The hinge angle where power hands over from the outside display to the inside one. */
    switchDeg?: number;
    /** The blur handover (default on): the interface blurs and dims off the outside display and clears across the inside one as it opens. Off leaves the plain brightness handover. */
    enabled?: boolean;
    /** 0 to 1, scaling the whole effect (default 1); 0 is the plain handover. */
    intensity?: number;
    /** 0 to 1 multipliers on the blur radius and the dimming depth alone (default 1). */
    blur?: number;
    darken?: number;
  }

  type DeviceLayoutPreset = (typeof DEVICE_LAYOUT_PRESETS)[number];

  /** Named-material overrides a colour variant applies to the cloned model. */
  interface DeviceMaterialOverride {
    /** sRGB hex for `material.color` (the baseColorFactor slot); replaces the colour exactly when there's no baseColorTexture, else multiplies it. On a metal (metalness 1) this is the reflectance, so it also sets how bright the surface reads. */
    color?: string;
    /** Overrides the material's roughness (0 mirror, 1 fully diffuse); higher softens specular flashes off the lighting rig. */
    roughness?: number;
    /** Overrides the material's metalness (0 dielectric, 1 metal). */
    metalness?: number;
  }

  /** A screen's media rotation as authored: clockwise degrees, or `"auto"` to match the device's pose. */
  type DeviceMediaRotation = 0 | 90 | 180 | 270 | "auto";

  /** Toolkit-shipped device models: `DeviceMockup`'s `model` prop is a NAME (not a path), so geometry ships with the toolkit and is bundled via Vite's `?url` (fingerprinted, survives the packaged build); regenerate the glb with `pnpm assets:phone`. */
  type DeviceModelName = "phone-generic";

  /** Turns a finished device gizmo drag into exactly what the Position drill's sliders would write, so a laid-out scene keeps editing its `deviceLayout` delta and a block-less one keeps editing raw placement, while a keyframed scene shapes the key nearest the playhead. One rule for every branch: `committed = authored + (dragged - rendered)`, positions and rotations adding, scale multiplying. Differencing against the RENDERED pose (what the gizmo started from) is what survives everything the render does on top: DevicesFallback's portrait scale factor, templates' frozen multipliers, the layout resolver's own composition and the ground clamp. */
  interface DevicePose {
    position: V3;
    rotationDeg: V3;
    scale: number;
  }

  /** What a `Device` hands its children: the model it renders and this frame's hinge angles. */
  interface DeviceScreenContextValue {
    model: DeviceId;
    /** What this build renders (Android when `model` is unavailable); anchors use its screen. */
    renderModel: DeviceId;
    lidDeg?: number;
    foldDeg?: number;
  }

  /** One display: the screen mesh's material name + the display's width/height. */
  interface DeviceScreenSpec {
    material: string;
    aspect: number;
    rect: DeviceScreenRect;
  }

  /** The device's cast-shadow silhouette, in the fitted local frame `layoutWidth` and `fittedHeight` describe (recentred, placement scale 1). A handset is one upright rounded rect of exactly those extents; a laptop adds a flat base and a hinged lid, so an open lid casts its own shadow. Measured once per model like `fittedHeight` and never read from the runtime bbox, so a build without the licensed glbs casts the same shadow as one with them. Maths and the projector: `shadowProjector.ts`. */
  interface DeviceShadowSpec {
    /** Body thickness: front to back for an upright handset, top to bottom for a laptop base. */
    thickness: number;
    /** Silhouette corner radius. */
    radius: number;
    /** Laptop only: the base slab's depth (hinge to front edge) and its centre. */
    base?: { depth: number; y: number; z: number };
    /** Laptop only: the lid slab, hinged at (0, hingeY, hingeZ) and opening by the device's lid angle. */
    lid?: { length: number; thickness: number; hingeY: number; hingeZ: number };
    /** Foldable only: two upright panels of `thickness` each; `hingeZ` is their shared inner-face plane, where the vertical hinge runs. */
    fold?: { hingeZ: number };
  }

  /** The blur families a scene can pick (track-level, first authored key wins). Depth and split read scene depth through the CoC; the rest are screen-space. */
  type DofMode = "depth" | "tilt" | "soft" | "radial" | "directional" | "split";

  /** The easing families exposed to the UI/scene documents (each as in / out / inOut). */
  const EASE_FAMILIES: readonly ["Sine", "Quad", "Cubic", "Quart", "Quint", "Expo", "Circ", "Back"];

  type EaseFamily = (typeof EASE_FAMILIES)[number];

  /** Maps eased progress `t ∈ [0, 1]` → eased value (0 → 0, 1 → 1; `jump` excepted at t < 1). */
  type EaseFn = (t: number) => number;

  /** A key's effective dof after clamping and carry-forward (a normalise-time product, stored on the normalized pose). */
  interface EffectiveDof {
    blur: number;
    range: number;
    /** Manual focus distance, or null for autofocus. */
    focus: number | null;
    band: number;
    offset: number;
    angleDeg: number;
    glow: number;
    centerX: number;
    centerY: number;
    squeeze: number;
    focusB: number;
  }

  /** The postprocessing stack: every field is a plain number/string set on the CPU, never time-derived, so effect frames stay a pure function of the timeline. Omitting a key omits that effect. A theme with NO `effects` keeps the byte-identical (composer-free) render path. See docs/determinism.md. */
  interface EffectsConfig {
    bloom?: BloomParams;
    vignette?: VignetteParams;
    lut?: LutParams;
    grain?: GrainParams;
  }

  /** One quad's fully resolved frame state; every field is in the parent Text's local space (offsets already × fontSize). */
  interface EmojiQuadState {
    key: string;
    /** Caret-centre position in layout space. */
    x: number;
    y: number;
    alpha: number;
    scale: number;
    dx: number;
    dy: number;
    dz: number;
    /** Twist: rotation about the Y axis at `rotYPivotX` (the stagger unit's centre). */
    rotYRad: number;
    rotYPivotX: number;
    /** Scatter: roll about the quad's own centre. */
    rotZRad: number;
    /** Mask-reveal coverage multiplier, 0..1. */
    coverage: number;
    /** Motion-pack v2 parity, all optional so legacy state builders stay untouched: X-axis card tip at `rotXPivotY` (the unit's centre Y; 0 when unrotated) and anisotropic scale composed with `scale`. */
    rotXRad?: number;
    rotXPivotY?: number;
    scaleX?: number;
    scaleY?: number;
  }

  /** Environment reflections for the lighting block: same shape as `ThemeEnvironment` plus the explicit `"none"` source ("no reflections", distinct from absent = inherit the layer below). Lighting only; never a visible background. */
  interface EnvironmentSpec {
    /** `"kookaburra:<slug>"` | `"kookaburra:softbox"` | a project-relative `.hdr`/`.exr` path | `"none"`. */
    source: string;
    intensity: number;
    rotationDeg: number;
  }

  interface FaceLine {
    lineHeight: number;
    baseline: number;
  }

  /** Bare emissive forms plus the housed practicals (v9 · PR 10: the same emissive-core-plus-paired-light anatomy wrapped in simple procedural housing geometry; no licensed assets). */
  type FixtureForm =
    | "tube"
    | "panel"
    | "ring"
    | "strip"
    | "bulb"
    | "neon-sign"
    | "tube-stand"
    | "ring-light"
    | "led-strip";

  /** Repeat expansion for a fixture: `count` instances spaced along `axis`, optionally mirrored across `mirrorAxis`; `jitter` (0..1) varies per instance, seeded from the fixture id (engine/rng.ts, never Math.random). */
  interface FixtureRepeat {
    /** 1..FIXTURE_MAX_COUNT. */
    count: number;
    spacing: number;
    axis: "x" | "y" | "z";
    /** Duplicate the whole run mirrored across this axis. */
    mirrorAxis?: "x" | "y" | "z";
    /** 0..1 per-instance variation, seeded from the fixture id. */
    jitter?: number;
  }

  /** An emissive light fixture: visible geometry (`emissive` above 1.0 crosses the bloom threshold) plus a paired real light (`lightIntensity: 0` = purely decorative). */
  interface FixtureSpec {
    id: string;
    form: FixtureForm;
    name?: string;
    enabled?: boolean;
    /** Default "world". */
    space?: LightSpace;
    /** Visible geometry, world units. tube: [length, diameter]. panel: [w, h]. ring: [outerDiameter, thickness]. strip: [length, width]. bulb: [diameter, -]. */
    size: [number, number];
    kelvin?: number;
    colorToken?: string;
    color?: string;
    /** Emissive multiplier. Above 1.0 to cross the bloom threshold. */
    emissive: number;
    /** The paired real light. 0 means purely decorative geometry. */
    lightIntensity: number;
    /** Also bake this fixture into the scene environment for crisp reflections on glossy surfaces. World-space static poses only. */
    envMirror?: boolean;
    /** neon-sign only: the tube's built-in path (default "line"). */
    shape?: NeonShape;
    placement: Placement;
    rotationDeg?: [number, number, number];
    repeat?: FixtureRepeat;
  }

  /** A resolved font reference. `family` resolves through the bundled registry first, then workspace-pinned system fonts (`~/Kookaburra Cut/fonts/`, auto-pinned on first reference), else falls back to Inter with a warning. Weights snap to the nearest available static face. */
  interface FontRef {
    family: string;
    weight: number;
  }

  /** Where a hosted chart sits in the panel column: in the band under the text, or in place of it (the panel then draws no editorial content at all). */
  type FrameChartPosition = "below" | "replace";

  /** The panel's chart slot: presence and layout only. The chart DEFINITION stays in the scene document's `chart` block (with `mount: "panel"`), so one chart is authored, edited and animated the same way wherever it lands. */
  interface FrameChartSlot {
    /** `false` switches an inherited deck slot off for this scene (the `FrameSpec.enabled` idiom). */
    enabled?: boolean;
    /** Band the chart takes off the column, as a fraction of its height (clamped 0.1..1); defaults to 0.55 under text, the whole column when it replaces it. */
    height?: number;
    position?: FrameChartPosition;
  }

  interface FrameChipSpec {
    label: string;
    /** Theme token id ("accent", "muted", "text", "background") or a hex override. */
    colour?: string;
    /** Emoji, or a project-relative asset path. */
    icon?: string;
  }

  interface FrameCutoutSpec {
    shape: FrameShape;
    /** Corner radius as a fraction of the cutout's shorter edge, `rounded-rect` only. */
    radius?: number;
    /** Fraction of the frame's split axis the cutout column/row occupies. */
    size?: number;
    side?: FrameSide;
    /** Margin between cutout and frame edge, as a fraction of the shorter frame edge. */
    inset?: number;
  }

  /** Which theme face a text decoration types in. */
  type FrameDecorationFace = "headline" | "body";

  /** "above" draws over the cutout (the deliberate breakout); "below" tucks behind it. */
  type FrameDecorationLayer = "above" | "below";

  type FrameDecorationShape = "none" | "circle";

  /** One positioned mark on the panel: an image or a line of text, EXACTLY one of `src`/`text`. Decoration text lives here rather than in the document's `text` map because it is positioned art, not body copy, and several decorations each need their own string. */
  interface FrameDecorationSpec {
    id: string;
    /** Project-relative asset path; the image decoration. */
    src?: string;
    /** The text decoration's line (troika, theme fonts); `\n` is the only break. */
    text?: string;
    /** Text fill: a theme token id ("accent", "muted", "text", "background") or a hex override. Text decorations only. */
    colour?: string;
    /** Theme face for a text decoration; default "headline". */
    face?: FrameDecorationFace;
    /** Explicit font ("Family" or "Family@weight") replacing the face for a text decoration. */
    font?: string;
    /** Line spacing as a multiple of the font size (0.8..2); absent means the font's normal. Text decorations only. */
    lineHeight?: number;
    /** Centre in frame-relative coords, -1..1 on both axes. */
    position: [number, number];
    /** An image's width, or a text decoration's font size, as a fraction of the frame width. */
    size: number;
    /** Clockwise rotation in degrees about the decoration's centre; absent (or 0) is upright. */
    rotationDeg?: number;
    /** Images only: `circle` crops the plane to a disc. */
    shape?: FrameDecorationShape;
    layer?: FrameDecorationLayer;
    /** Stable order inside the layer band, materialised when inherited images become first-class. */
    stackOrder?: number;
  }

  /** A scene sidecar's override of the deck frame. `cutout` is optional here (unlike `FrameSpec`) so a scene can restyle just the colour or chip without restating the shape; when present it replaces the deck's outright. */
  interface FrameOverrideSpec extends Omit<FrameSpec, "cutout"> {
    cutout?: FrameCutoutSpec;
  }

  /** The panel fill, beyond the flat colour a plain string still means: a baked gradient, a cover-fit project image, or nothing at all (`transparent` paints no surface: with `shape: "none"` the scene fills the frame behind the overlay's content, and behind a shaped cutout the panel region takes the scene's backdrop colour). Mirrors the stage's `ThemeBackground` vocabulary for the types it shares. */
  type FramePanelBackground =
    | { type: "transparent" }
    /** Theme token id, or a hex override (the string form, spelled out). */
    | { type: "color"; color: string }
    /** `gradient` names a THEME gradient; `spec` carries an inline self-contained one (the picker's write-through). `spec` wins when both are present. */
    | { type: "gradient"; gradient?: string; spec?: GradientSpec }
    /** Project-relative asset path, cover-cropped to the frame. */
    | { type: "image"; src: string };

  /** `"none"` removes the cutout entirely: the panel owns the whole frame and `side`/`size`/`inset`/`radius` are no-ops. */
  type FrameShape = "rect" | "rounded-rect" | "squircle" | "circle" | "capsule" | "none";

  /** Which end of the split axis the cutout sits on; the axis itself follows the aspect, so one config serves every format. */
  type FrameSide = "start" | "end";

  interface FrameSpec {
    enabled?: boolean;
    cutout: FrameCutoutSpec;
    /** The panel fill: a theme token id, a hex override, or a `FramePanelBackground` object. Absent takes the neutral panel the theme suits. */
    background?: string | FramePanelBackground;
    /** Emoji or asset path, drawn above the title. Empty explicitly hides a deck-inherited icon. */
    icon?: string;
    chip?: FrameChipSpec;
    /** Hosts the scene's panel-mounted chart in the column; absent means the panel is text only. */
    chart?: FrameChartSlot;
    decorations?: FrameDecorationSpec[];
    textAlign?: SceneTextAlign;
    /** Overlay claims the scene's title/subtitle/bullets and suppresses the in-world headline. */
    claimsSceneText?: boolean;
  }

  /** Structured, renderable gradient (schema v2; CSS strings are gone). `type: "radial"` runs centre to corners (`angleDeg` ignored); `space: "oklch"` selects perceptual stop interpolation. Absent `space` is the per-channel sRGB byte path, byte-frozen by the standing baselines. */
  interface GradientSpec {
    type: "linear" | "radial";
    angleDeg: number;
    /** Ordered [sRGB hex, position 0..1] pairs. */
    stops: [string, number][];
    space?: "oklch";
  }

  /** Film-grain params. `intensity` 0 = no grain. Seeded from the frame only (see grainSeed). */
  interface GrainParams {
    intensity: number;
  }

  /** A shine band along `SHINE_AXIS`, in the space of whoever holds it. */
  interface GroupShineBand {
    centerS: number;
    invHalfWidthS: number;
  }

  /** Toolkit-shipped hero models: like `device/models.ts`, the `HeroObject` `model` prop is a NAME not a path, so geometry ships with the toolkit and names stay asset-agnostic (the glb behind a name can swap without touching projects); `handset` currently points at the same bundled glb as DeviceMockup, so the trademark caveat in src/assets/models/README.md applies. */
  type HeroModelName = "handset";

  type KeysOfUnion<T> = T extends unknown ? keyof T : never;

  /** Where a chained item hangs off its neighbour; the layer's one root item has attach: null. */
  interface LayeredScreenshotAttach {
    /** Another item's id within the same layer. */
    to: string;
    side: LayeredScreenshotAttachSide;
  }

  type LayeredScreenshotAttachSide = "left" | "right" | "top" | "bottom";

  type LayeredScreenshotItem = LayeredScreenshotScreenItem | LayeredScreenshotTextItem;

  interface LayeredScreenshotItemBase {
    id: string;
    attach: LayeredScreenshotAttach | null;
    /** World-unit gap to the attached neighbour; falls back to the layer's gap, then the tuned default. */
    gap?: number;
  }

  interface LayeredScreenshotKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    pose: LayeredScreenshotPose;
  }

  interface LayeredScreenshotLayer {
    id: string;
    name?: string;
    visible: boolean;
    items: LayeredScreenshotItem[];
    /** This layer's default chain gap, world units. */
    gap?: number;
    /** This layer's default card treatment. */
    flat?: boolean;
    /** Stack order offset within the spread; builder-authored. */
    z: number;
  }

  interface LayeredScreenshotPlacement {
    /** Frame-relative offset, with positive Y upwards. */
    position: [number, number];
    size: number;
    rotationDeg: number;
  }

  /** The rest pose: exactly what a non-animated scene renders, and the builder's saved view. */
  interface LayeredScreenshotPose {
    /** 0 = flattest legal stack, 1 = fully expanded; mapped through a tuned Z step so layers never clip. */
    spread: number;
    azimuthDeg: number;
    elevationDeg: number;
    /** Multiplier, 1 = the auto-fit default. */
    zoom: number;
    /** World-unit offset of the stack's centre. */
    pan: [number, number];
  }

  interface LayeredScreenshotScreenItem extends LayeredScreenshotItemBase {
    kind: "screen";
    /** Project-relative asset path. */
    src: string;
    media: "image" | "video";
    /** Video only, scene-local ms. */
    startMs?: number;
    /** Card treatment override for this one item; default follows the layer's flat. */
    flat?: boolean;
  }

  interface LayeredScreenshotSegment {
    from: string;
    to: string;
    /** An `engine/ease.ts` name or `"jump"`. */
    ease: string;
  }

  /** The string itself lives in doc.text["ls-<id>"] via useSceneText, so textStyle overrides apply for free. */
  interface LayeredScreenshotTextItem extends LayeredScreenshotItemBase {
    kind: "text";
    /** Wrap width in world units (screens size from their media aspect; text needs an explicit box). */
    width?: number;
  }

  /** A validated, sorted LS animation track (keys ascending; segments ordered, non-overlapping). */
  interface LayeredScreenshotTrack {
    keys: LayeredScreenshotKey[];
    segments: LayeredScreenshotTrackSegment[];
    /** Slideshow holds only (the camera's presentLoop semantics); preview and export never read it. */
    presentLoop?: SceneDocCameraPresentLoop;
  }

  /** A normalized animation segment: key ids resolved to the shared key objects. */
  interface LayeredScreenshotTrackSegment {
    from: LayeredScreenshotKey;
    to: LayeredScreenshotKey;
    /** An engine/ease.ts name (`ease()` degrades unknown names at sample time). */
    ease: string;
  }

  interface LayoutDeviceLike {
    id: string;
    model: string;
    placement?: DevicePlacement;
  }

  interface LightBase {
    id: string;
    name?: string;
    /** Default true. */
    enabled?: boolean;
    /** Default "world". */
    space?: LightSpace;
    intensity: number;
    /** 1000..20000. Wins over `colorToken` and `color` when present. */
    kelvin?: number;
    /** Theme colour token name, used when `kelvin` is absent. */
    colorToken?: string;
    color?: string;
    /** Default false. Rejected at parse for point (cube-map cost) and area (three.js cannot). */
    castShadow?: boolean;
    placement: Placement;
    /** Aim point in the light's own space. Default [0,0,0]. Ignored by point lights. */
    target?: [number, number, number];
  }

  /** Where a light's transform is resolved: fixed in the scene, riding the camera, or orbiting the camera's target. Camera/subject spaces resolve per render target at the compositor seam (transition frames use different cameras for A and B). */
  type LightSpace = "world" | "camera" | "subject";

  /** One free light. `angleDeg` is the FULL cone in degrees (three's `angle` is radian half-angle); `distance`/`decay` default to three's own defaults (0 and 2). */
  type LightSpec =
    | (LightBase & { type: "directional" })
    | (LightBase & { type: "point"; distance?: number; decay?: number })
    | (LightBase & {
        type: "spot";
        angleDeg: number;
        penumbra: number;
        distance?: number;
        decay?: number;
      })
    | (LightBase & { type: "area"; width: number; height: number });

  /** Provenance for the Matching lighting toggle, so turning it off removes only its own unedited writes. */
  interface LightingCompanion {
    /** The scene3d look and preset whose block was written. */
    look: string;
    preset: string;
    /** Each field as written; `lights` and `fixtures` hold only the entries the toggle added. */
    wrote: LightingCompanionFields;
    /** The scene layer's own values the write replaced; an absent field was inherited. */
    prior: Omit<LightingCompanionFields, "lights" | "fixtures">;
  }

  /** The static rig fields a 3D background preset can carry as its matching lighting. */
  type LightingCompanionFields = Pick<
    LightingSpec,
    "environment" | "sun" | "ambient" | "ambientColor" | "lights" | "fixtures" | "shadow"
  >;

  interface LightingKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    /** Musical position this key sits on; `tMs` caches its resolved value and a move that disagrees drops it. */
    at?: string;
    pose: LightingPose;
  }

  /** One sparse keyframe pose over the WHOLE rig (one track per scene, the camera precedent): absent fields leave the base value alone, so a key that only sets `sun.intensity` touches nothing else. Colours interpolate through Kelvin when both endpoints define it (a Kelvin ramp reads as a light warming; an RGB lerp between blackbody colours goes muddy). */
  interface LightingPose {
    ambient?: number;
    /** Hex; only a room writes it (lighting keys never carry colours). */
    ambientColor?: string;
    environmentIntensity?: number;
    environmentRotationDeg?: number;
    sun?: {
      azimuthDeg?: number;
      elevationDeg?: number;
      intensity?: number;
      kelvin?: number;
      /** Hex; only a room writes it, and it wins over kelvin. */
      color?: string;
    };
    /** By light id. Camera/subject placements resolve per render target at the compositor seam. */
    lights?: Record<
      string,
      { intensity?: number; kelvin?: number; placement?: Placement; color?: string }
    >;
    /** By fixture id. */
    fixtures?: Record<string, { emissive?: number; lightIntensity?: number; placement?: Placement }>;
  }

  interface LightingSegment {
    from: string;
    to: string;
    /** An engine/ease.ts name. */
    ease: string;
  }

  /** v9 lighting. Absent at every layer resolves to the v8 path verbatim. `key` is accepted as an alias for `sun` on read and normalised to `sun` in memory; nothing rewrites theme files. */
  interface LightingSpec {
    environment?: EnvironmentSpec;
    sun?: SunSpec;
    ambient?: number;
    /** Ambient-light tint; absent remains white. */
    ambientColor?: string;
    /** Legacy v8 fills, kept so existing themes parse unchanged. New work uses `lights`. */
    fills?: ThemeLightSpec[];
    lights?: LightSpec[];
    fixtures?: FixtureSpec[];
    shadow?: ThemeShadowSpec;
    /** Bundled preset id last applied by the picker. The renderer never reads it. */
    preset?: string;
    /** False mutes the scene track without deleting keys or segments. */
    animationEnabled?: boolean;
    /** The scene's lighting keyframe track (SCENE-DOC layer only; themes and project defaults never animate). Raw here like the camera's sidecar block; deep validation lives in `normalizeLightingTrack`. */
    keys?: LightingKey[];
    segments?: LightingSegment[];
    /** SCENE-DOC layer only: what the 3D background's Matching lighting toggle wrote here. The renderer never reads it. */
    companion?: LightingCompanion;
  }

  interface Line {
    width: number;
    lineHeight: number;
    baseline: number;
    glyphs: { x: number; width: number; space: boolean; face: FaceLine }[];
  }

  /** Colour-grade params: `url` is a project-relative `.cube` 3D LUT (e.g. "assets/grade.cube"), resolved by loadProject to a project asset key. `intensity` 0 = no grade, 1 = full grade (drives blend opacity). All LUTs in one project must share one LUT_3D_SIZE (see preloadEffectLuts). */
  interface LutParams {
    url: string;
    intensity: number;
  }

  const MANAGED_TEXT_ITEM_TYPES: readonly ["title", "subtitle", "bullets", "icon"];

  const MANAGED_TEXT_MARKERS: readonly ["dot", "dash", "tick", "number", "none"];

  interface ManagedTextRegion {
    left: number;
    top: number;
    bottom: number;
    width: number;
    align?: "left" | "center" | "right";
  }

  type ManagedTextRenderRole = "scene" | "embedded" | "managed";

  type MosaicRevealOrder = "rows" | "columns" | "centre";

  /** A per-item override. Absent inherits the scene; `enabled: false` pins the item at the frame instant; `amount` scales how far its own time travels inside the shutter. */
  interface MotionBlurOverride {
    enabled: boolean;
    amount?: number;
  }

  /** Neon-sign tube paths (free-form paths are out of scope by design). */
  type NeonShape = "line" | "circle" | "rect";

  /** A validated composition: layers whose attach graphs are rooted and acyclic, plus the optional normalized track. */
  interface NormalizedLayeredScreenshot {
    layers: LayeredScreenshotLayer[];
    pose: LayeredScreenshotPose;
    placement?: LayeredScreenshotPlacement;
    track: LayeredScreenshotTrack | null;
  }

  /** Per-particle constants derived once from the seed. */
  interface Particle {
    base: Vector3;
    sizeMul: number;
    phase: number;
    speedMul: number;
  }

  /** Dual placement, losslessly convertible (engine/orbit.ts); `mode` records whichever the user last edited. Orbit placement uses the light's own distance, never the legacy LIGHT_RADIUS. */
  type Placement =
    | { mode: "orbit"; azimuthDeg: number; elevationDeg: number; distance: number }
    | { mode: "point"; position: [number, number, number] };

  /** The world rectangle a camera sees on one plane: the bounding box of the frustum hits. */
  interface PlaneFrame {
    width: number;
    height: number;
    center: [number, number, number];
  }

  type ProjectSharedValue =
    | null
    | boolean
    | number
    | string
    | readonly ProjectSharedValue[]
    | { readonly [key: string]: ProjectSharedValue };

  /** One resolved data key: values normalised to the block's series x category shape. */
  interface ResolvedChartKey {
    /** Scene-local time, ms. */
    tMs: number;
    values: number[][];
  }

  /** One resolved morph: both endpoint matrices inline (the compare-segment shape), eased across the span. */
  interface ResolvedChartSegment {
    fromTMs: number;
    fromValues: number[][];
    toTMs: number;
    toValues: number[][];
    ease: string;
  }

  /** Keys sorted by time, segments resolved (bad references dropped); both empty for a static chart. */
  interface ResolvedChartTrack {
    keys: readonly ResolvedChartKey[];
    segments: readonly ResolvedChartSegment[];
  }

  /** A fully resolved animation: what to play, how to ease it, and how to stagger it. */
  interface ResolvedTextAnimation {
    preset: TextPresetName;
    outPreset: TextPresetName;
    /** An `engine/ease` name; unknown names degrade inside `ease()` itself. */
    ease: string;
    staggerMs: number;
    /** null = whole-block (no stagger). */
    granularity: StaggerGranularity | null;
    /** Hold before the in starts, ms; present only when > 0 (0 and absent are identical). The out never shifts. */
    delayMs?: number;
    /** Absent keeps the primitive's authored `from` → `to` window. */
    durationMs?: number;
    /** Absent keeps the selected preset's tuned travel distance. */
    distance?: number;
    params: TextPresetParams;
  }

  /** Rooms: a scene's backdrop colour changing mid-scene by a cut or a flood spreading from a point, with the staged lights following. The sidecar `room` block parses shallowly (raw keys survive so a write never drops data), this module validates it with warnings at load and silently at build, and every sample is a pure function of scene-local time. A project with no `room` anywhere builds null tracks and never reaches any of it. See docs/determinism.md ("Rooms"). */
  type RoomTransition = "cut" | "flood";

  const SCENE_IMAGE_MOTION_PRESETS: readonly ["none", "turntable", "float", "tilt-reveal", "push-in"];

  /** The union of both legacy preset lists: `turntable` stays the stage-host image look, `drift` comes from the window family; a sampler decides what a preset means for its kind. */
  const SCENE_MEDIA_MOTION_PRESETS: readonly ["none", "turntable", "float", "tilt-reveal", "push-in", "drift"];

  /** Inspector “None”: fully static, distinct from legacy `none`'s plain linear reveal. */
  const STATIC_TEXT_PRESET: "static";

  /** The sampled values: every key property except `tMs` and `ease`. */
  type SampledKeys<K> = {
    [P in Exclude<KeysOfUnion<K>, "tMs" | "ease">]: K extends { [Q in P]?: infer V }
      ? Exclude<V, undefined>
      : never;
  };

  interface SceneDocCameraKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    /** Musical position this key sits on; `tMs` caches its resolved value and a move that disagrees drops it. */
    at?: string;
    pose: SceneDocCameraPose;
    /** Marks this key as a stills export page (see engine/stills.ts). */
    still?: true;
  }

  /** A camera kick: an attack, hold, release push added on top of whichever pose drives the scene (rig, orbit, project or base), a pure function of time. */
  interface SceneDocCameraKick {
    id?: string;
    /** Scene-local start of the kick. */
    at: SceneDocTimePosition;
    /** Magnification at the peak (1.04 is 4% in), applied in tan space. */
    zoom?: number;
    /** Camera-space shift at the peak (+x right, +y up, +z back), moving the look point too. */
    offset?: [number, number, number];
    rollDeg?: number;
    /** Default 0 (a snap). */
    attackMs?: number;
    /** Default 0. */
    holdMs?: number;
    releaseMs: number;
    /** An `engine/ease.ts` name; default `"outQuad"`. */
    ease?: string;
  }

  /** Orbit pose for the per-scene camera track. */
  interface SceneDocCameraPose {
    target: [number, number, number];
    azimuthDeg: number;
    elevationDeg: number;
    distance: number;
    /** Depth of field; absent inherits the last keyed value along the track (see engine/dof.ts). */
    dof?: SceneDocDof;
    /** Motion blur shutter angle from this key on; absent inherits the scene's (see engine/shutter.ts). */
    shutterDeg?: number;
  }

  /** Present-slideshow hold looping for the camera track: once the authored keys finish during a hold, smooth eases back to the first key over blendMs then replays, jump restarts each cycle. Never read by preview or export sampling. */
  interface SceneDocCameraPresentLoop {
    mode: "smooth" | "jump";
    /** Smooth return-leg length in ms (the present window defaults it when absent). */
    blendMs?: number;
  }

  interface SceneDocCameraSegment {
    from: string;
    to: string;
    /** An `engine/ease.ts` name (anime.js v4 style) or `"jump"`. */
    ease: string;
    /** Focus-channel ease override; absent means the segment's own `ease`. */
    easeDof?: string;
  }

  /** The chart block: one chart per scene, mounted as the scene's hero, staged among devices (`placement`) or inside an overlay panel. Absence is PRESERVED here (a missing field means "unauthored"); defaults, clamps and the resolved track live in `sceneChart.ts`. `track` keyframes the data: `data.series[].values` is the pose before the first key. */
  interface SceneDocChart {
    type: ChartType;
    dimension?: ChartDimension;
    mount?: ChartMount;
    /** Staged mount only. */
    placement?: DevicePlacement;
    data: SceneDocChartData;
    /** Named colour scheme id; absent takes the theme's chart palette. */
    palette?: string;
    /** Font string ("Family" or "Family@weight") for every label in the chart; absent takes the project's chart font, then the theme faces. */
    font?: string;
    style?: Partial<ChartStyle>;
    axis?: { value?: SceneDocChartValueAxis; category?: Partial<ChartCategoryAxis> };
    labels?: { legend?: Partial<ChartLegend>; values?: SceneDocChartValueLabels };
    animation?: Partial<ChartAnimationConfig>;
    track?: { keys: SceneDocChartKey[]; segments: SceneDocChartSegment[] };
  }

  interface SceneDocChartData {
    categories: string[];
    series: SceneDocChartSeries[];
    /** Project-relative CSV the values were imported from; informational, nothing reads it at render or export time. */
    source?: string;
  }

  /** One data keyframe: a FULL value snapshot (the Magic Chart model), `[series][category]`, the same shape as `data`. Structure changes (adding a series or category) are edits to `data`, never keyframable. */
  interface SceneDocChartKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    pose: ChartValuesPose;
  }

  interface SceneDocChartSegment {
    from: string;
    to: string;
    /** An `engine/ease.ts` name (unknown names degrade at sample time). */
    ease: string;
  }

  /** One data series: `values` is one number per category (short rows read as 0), `colour` overrides the theme palette swatch for this series index. */
  interface SceneDocChartSeries {
    id: string;
    name?: string;
    values: number[];
    colour?: string;
  }

  /** The value axis as authored: every field optional, `sceneChart.ts` fills the defaults. */
  interface SceneDocChartValueAxis
    extends Omit<Partial<ChartValueAxis>, "format" | "gridlines"> {
    format?: Partial<ChartValueFormat>;
    gridlines?: Partial<ChartGridlines>;
  }

  interface SceneDocChartValueLabels
    extends Omit<Partial<ChartValueLabels>, "format" | "background"> {
    format?: Partial<ChartValueFormat>;
    /** PRESENT (even bare) forces a chip behind every value label; absent leaves the appearance preset's own pill maths. */
    background?: Partial<ChartValueLabelBackground>;
  }

  /** The comparison block. `mask.type`: `linear` (a straight divider, `angleDeg` is the LINE's angle, 90 = vertical), `circle` (the after inside a growing circle at `center`), `radial` (the after sweeps around `center`), `blend` (the after fades over the before). `softness` feathers the edge; `value` is the static divider position when no track keys exist (default 0.5). `mask.angleDeg` is the STATIC angle: a track key carrying its own `pose.angleDeg` overrides it and rides the track. */
  interface SceneDocCompare {
    b?: SceneDocCompareSide;
    mask?: {
      type: "linear" | "circle" | "radial" | "blend";
      angleDeg?: number;
      softness?: number;
      center?: [number, number];
    };
    value?: number;
    track?: { keys: SceneDocCompareKey[]; segments: SceneDocCompareSegment[] };
    chrome?: SceneDocCompareChrome;
  }

  /** The exported chrome: a divider line along the mask edge, a grip riding a linear divider, label chips per half, per-side tints. `line.colour` and both tints are each a THEME TOKEN NAME (background | text | accent | muted) resolved against the scene's theme at plan build, or a `#rrggbb` hex used as authored. Absent sub-blocks are off, and `grip: true` is the legacy chevrons handle at size 1. */
  interface SceneDocCompareChrome {
    line?: { width?: number; colour?: string; softness?: number };
    grip?: boolean | SceneDocCompareGrip;
    chips?: boolean;
    tint?: { a?: string; b?: string; amount?: number };
  }

  /** The narrow device appearance surface side B may override. Device identity, pose and motion remain shared. */
  interface SceneDocCompareDeviceAppearance {
    colour?: string;
    shadow?: DeviceShadowMode;
  }

  /** The grip as authored: `size` is a multiplier on the reference radius, `style` picks the handle. */
  interface SceneDocCompareGrip {
    size?: number;
    style?: SceneDocCompareGripStyle;
  }

  /** The grip handle's look, dispatched in the compare shader; `chevrons` is the default and the legacy `grip: true` shape. */
  type SceneDocCompareGripStyle = "chevrons" | "dot" | "bar" | "arrows";

  /** One divider key on the shared KeyedTrack model: the mask value (0..1) at a scene-local time, and optionally the divider angle from that key on (absent means `mask.angleDeg`). Eased interpolation happens inside segments; outside them the latest key holds (the camera-track semantics). */
  interface SceneDocCompareKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    /** Musical position this key sits on; `tMs` caches its resolved value and a move that disagrees drops it. */
    at?: string;
    pose: { value: number; angleDeg?: number };
  }

  interface SceneDocCompareSegment {
    from: string;
    to: string;
    /** An `engine/ease.ts` name (unknown names degrade at sample time). */
    ease: string;
  }

  /** Side B ("after") of a comparison: every field optional, absent means same as side A (the base doc). Device-keyed maps override screen media or appearance; the other fields replace the doc's own values for side B only. */
  interface SceneDocCompareSide {
    media?: Record<string, DeviceMediaSpec>;
    /** The same override for a foldable's outside display. */
    coverMedia?: Record<string, DeviceMediaSpec>;
    deviceAppearance?: Record<string, SceneDocCompareDeviceAppearance>;
    themeId?: string;
    background?: ThemeBackground;
    backdrop?: ThemeBackdrop;
    lighting?: LightingSpec;
  }

  /** One device-track key: a time plus the poses it moves, by device id. A device absent from `pose` holds its resting pose through that key. */
  interface SceneDocDeviceKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    /** Musical position this key sits on; `tMs` caches its resolved value and a move that disagrees drops it. */
    at?: string;
    pose: Record<string, SceneDocDevicePose>;
  }

  /** The live device layout: preset + gap derive per-aspect placements, each device's delta applies on top. While present, the devices' own `placement` position/rotation/scale are ignored (`ground` still applies), so removing the block reverts to whatever was authored before it existed. */
  interface SceneDocDeviceLayout {
    preset: DeviceLayoutPreset;
    /** Edge-to-edge spacing in world units, authored for 16:9; narrower aspects compress the whole layout proportionally. */
    gap?: number;
    devices?: Record<string, SceneDocDeviceLayoutDelta>;
  }

  /** Per-device customisation on top of the preset base: offsets and rotations add (world units and degrees), scale multiplies. */
  interface SceneDocDeviceLayoutDelta {
    offset?: [number, number, number];
    rotationDeg?: [number, number, number];
    scale?: number;
  }

  /** One device's pose at a key: a DELTA on whatever the scene already resolves for it (the layout block, or its own placement), so the motion presets keep layering on top and deleting the track reverts exactly. Offsets and rotations add, scale multiplies, and the hinge angles (`lidDeg`, `foldDeg`) and screen powers are the absolutes (an angle has no meaningful delta). Every field is optional and an absent one holds the device's resting value, the lighting-pose rule. */
  interface SceneDocDevicePose {
    offset?: [number, number, number];
    rotationDeg?: [number, number, number];
    scale?: number;
    /** Laptops only: the lid opening this key holds, in degrees. */
    lidDeg?: number;
    /** Foldables only: the hinge angle this key holds, in degrees. */
    foldDeg?: number;
    /** The main display's power, 0 black to 1 lit (a foldable's inside one); rests lit. It dims on top of a foldable's own handover. */
    screenPower?: number;
    /** Foldables only: the outside display's power, 0 black to 1 lit; rests lit. */
    coverPower?: number;
  }

  interface SceneDocDeviceSegment {
    from: string;
    to: string;
    /** An `engine/ease.ts` name (unknown names degrade at sample time). */
    ease: string;
  }

  /** Sidecar `dof` value on a camera key's pose. Every field optional: an absent field inherits the last authored value along the track; a key with no `dof` at all changes nothing. */
  interface SceneDocDof {
    /** Which blur family the scene uses; track-level, first authored key wins. */
    mode?: DofMode;
    /** Blur strength 0..1; 0 contributes nothing (and a track that never exceeds 0 stays off the composer). */
    blur?: number;
    /** Depth/split modes: full-sharp band around the focus plane, world units. */
    range?: number;
    /** Depth/split modes: manual focus distance in world units; "auto" (or never authored) follows the pose's aim distance. */
    focus?: number | "auto";
    /** Tilt mode: screen-fraction height of the sharp band, 0..1. */
    band?: number;
    /** Tilt and split modes: band/divider offset from screen centre, -1..1. */
    offset?: number;
    /** Tilt, directional and split modes: band/smear/divider rotation in degrees. */
    angleDeg?: number;
    /** Soft mode: highlight halation lift, 0..1. */
    glow?: number;
    /** Radial mode: streak centre offset from screen centre, -1..1 each axis. */
    centerX?: number;
    centerY?: number;
    /** Depth/split modes: anamorphic oval squeeze of the bokeh discs, 1 (round) to 2. */
    squeeze?: number;
    /** Split mode: the second focus distance in world units (always manual). */
    focusB?: number;
  }

  interface SceneDocImageSpec {
    id: string;
    /** Project-relative still image under `assets/`. */
    src: string;
    host: SceneImageHost;
    /** Both placements remain authored when the active host changes. */
    stage: SceneImageStagePlacement;
    overlay: SceneImageOverlayPlacement;
    /** Shared by both hosts; absent preserves the static legacy path. */
    motion?: SceneImageMotionSpec;
    /** Absent is off. */
    castShadow?: boolean;
  }

  interface SceneDocLayeredScreenshot {
    layers: LayeredScreenshotLayer[];
    pose: LayeredScreenshotPose;
    placement?: Partial<LayeredScreenshotPlacement>;
    animation?: {
      keys: LayeredScreenshotKey[];
      segments: LayeredScreenshotSegment[];
      /** Slideshow holds only, the camera's presentLoop semantics; preview and export never loop. */
      presentLoop?: SceneDocCameraPresentLoop;
    };
    /** Motion blur override; absent inherits the scene's Objects switch (see engine/motionBlur.ts). */
    motionBlur?: MotionBlurOverride;
  }

  /** One media entry: the image family's id, source, host and twin placements, plus the kind and the two optional blocks the video window contributed. */
  interface SceneDocMediaSpec {
    id: string;
    kind: SceneMediaKind;
    /** Project-relative source under `assets/`. */
    src: string;
    host: SceneMediaHost;
    /** Both placements remain authored when the active host changes. */
    stage: SceneImageStagePlacement;
    overlay: SceneImageOverlayPlacement;
    /** Shared by both hosts; absent preserves the static legacy path. */
    motion?: SceneMediaMotionSpec;
    /** Absent is off. */
    castShadow?: boolean;
    /** Absent is a bare plane, no corners, crop, border or shadow. */
    window?: SceneMediaWindow;
    /** `video` kind only. */
    video?: SceneMediaVideoSpec;
    /** Motion blur override; absent inherits the scene's Objects switch (see engine/motionBlur.ts). */
    motionBlur?: MotionBlurOverride;
  }

  /** Sidecar `mosaic` block: tiles fill the frame in reading order on a grid that reflows per aspect (or a fixed `columns`); a short last row stretches to fill. Defaults live in sceneMosaic.ts. */
  interface SceneDocMosaic {
    tiles: SceneDocMosaicTile[];
    columns?: number;
    /** Gap between tiles as a fraction of the frame's short side. */
    gap?: number;
    reveal?: SceneDocMosaicReveal;
  }

  /** Tile reveal timing: the tile ranked `n` lands over `durationMs` from `at + n * staggerMs`. */
  interface SceneDocMosaicReveal {
    at?: number;
    staggerMs?: number;
    durationMs?: number;
    order?: MosaicRevealOrder;
    /** An engine/ease.ts name. */
    ease?: string;
  }

  /** One mosaic tile: a project image or video, or a flat colour when it has no `src`. */
  interface SceneDocMosaicTile {
    /** Project image (png, jpg, jpeg, webp) or video (mp4, mov, m4v, webm) under `assets/`. */
    src?: string;
    /** Video only: scene-local ms playback starts (default 0). */
    startMs?: number;
    /** Video only: wrap instead of holding the last frame. */
    loop?: boolean;
    /** Hex or a theme colour token; a colour tile's fill (default muted). */
    colour?: string;
  }

  /** The scene layer: each present field replaces the project's. */
  interface SceneDocMotionBlur {
    enabled?: boolean;
    shutterDeg?: number;
    camera?: boolean;
    objects?: boolean;
  }

  /** How a rig key points the camera: at a fixed world point, along the path, or at a bound object. `at` is the baked look point on EVERY mode, so a degenerate tangent or a deleted binding still renders a shot instead of swinging to the origin. */
  type SceneDocRigAim =
    | { mode: "point"; at: [number, number, number] }
    | { mode: "tangent"; at: [number, number, number] }
    | { mode: "object"; id: string; at: [number, number, number] };

  interface SceneDocRigKey {
    id: string;
    /** Scene-local time, ms. */
    tMs: number;
    /** Musical position this key sits on; `tMs` caches its resolved value and a move that disagrees drops it. */
    at?: string;
    pose: SceneDocRigPose;
    /** First key only: start from the previous scene's final pose (resolved at load). */
    continueFromPrevious?: boolean;
    /** Marks this key as a stills export page (see engine/stills.ts). */
    still?: true;
  }

  /** A free camera pose: a position and an aim, not leashed to an orbit target. */
  interface SceneDocRigPose {
    position: [number, number, number];
    aim: SceneDocRigAim;
    /** Absent inherits the project-level track's fov; clamped 15..90 at normalise time. */
    fov?: number;
    /** Bank around the view axis; absent or zero applies no roll at all. */
    rollDeg?: number;
    /** Depth of field; absent inherits the last keyed value along the track (see engine/dof.ts). */
    dof?: SceneDocDof;
    /** Motion blur shutter angle, eased under the Lens channel; absent inherits the scene's (see engine/shutter.ts). */
    shutterDeg?: number;
  }

  interface SceneDocRigSegment {
    from: string;
    to: string;
    /** An `engine/ease.ts` name (anime.js v4 style) or `"jump"`. */
    ease: string;
    /** ABSENT means smooth: rig paths curve out of the box, `false` is a deliberate straight dolly. */
    smooth?: boolean;
    /** Per-channel ease overrides; absent means the segment's own `ease` (position covers position, rotation covers aim and roll, lens covers fov, dof covers focus and blur). */
    easePosition?: string;
    easeRotation?: string;
    easeLens?: string;
    easeDof?: string;
  }

  /** Sidecar `room` block: keys pass through raw (the lighting keys precedent); `sceneRoom.ts` validates them. */
  interface SceneDocRoom {
    keys: SceneDocRoomKey[];
  }

  interface SceneDocRoomKey {
    /** Scene-local ms or a musical position, resolved at build (see `resolveRoomAt`). */
    at: SceneDocTimePosition;
    /** Hex or a theme colour token of the room's palette; absent takes the `themeId` theme's background, else the previous room. */
    colour?: string;
    /** Reads this theme's colours and lights; it never swaps the scene's theme. */
    themeId?: string;
    lighting?: SceneDocRoomLighting;
    /** Absent = cut. */
    transition?: RoomTransition;
    /** Where a flood starts, in frame fractions: [0, 0] top-left to [1, 1] bottom-right; absent = the centre. */
    origin?: [number, number];
    /** Flood length; absent = 800. */
    durationMs?: number;
    /** An engine/ease.ts name shaping the flood's radius and light lerp. */
    ease?: string;
  }

  /** A room key's light entry: intensity and a colour (kelvin, then token, then hex). */
  interface SceneDocRoomLightEntry {
    intensity?: number;
    color?: string;
    colorToken?: string;
    kelvin?: number;
  }

  /** A room key's own lighting, layered over what its `themeId` brings. */
  interface SceneDocRoomLighting {
    sun?: SceneDocRoomLightEntry;
    ambient?: number;
    /** Hex or a theme colour token. */
    ambientColor?: string;
    /** By light id. */
    lights?: Record<string, SceneDocRoomLightEntry>;
  }

  /** Sidecar `stills` block; absent means included with one automatic still. */
  interface SceneDocStills {
    /** true leaves the scene out of every stills export (no pages, no bookmark). */
    exclude?: true;
    /** Fixed scene-local still times: integer ms, ascending, unique. */
    marksMs?: number[];
  }

  /** One tap: a ring pulse on the tap highlight curve, starting at `at`. Placed by `position` (world space) or by `screenUv` on the sidecar device `device`. */
  interface SceneDocTap {
    /** Scene-local ms the pulse starts. */
    at: number;
    /** World-space centre; the ring faces +z. */
    position?: [number, number, number];
    /** A point on the device's screen: u right, v down, 0..1 from the top-left (media pixel order). */
    screenUv?: [number, number];
    /** The sidecar device id `screenUv` is on. */
    device?: string;
    /** Hex or a theme colour token (background | text | accent | muted); absent is the accent. */
    colour?: string;
    /** Multiplier on the default ring size. */
    size?: number;
  }

  /** The sidecar `terminal` block as authored. Defaults are NOT applied here: `resolveSceneTerminal` owns them, so absence stays legible. */
  interface SceneDocTerminal {
    /** Terminal colour-scheme preset id; unknown ids render as `match-theme`. */
    theme?: string;
    chrome?: { style?: SceneTerminalChromeStyle; title?: string };
    cols?: number;
    rows?: number;
    /** Logical cell font size in px: raster density, never panel geometry. */
    fontPx?: number;
    /** What the terminal shows, as text with optional ANSI colours: the authoring source of `snapshot`. */
    transcript?: string;
    /** Frame-relative centre, -1..1 on both axes (the decoration convention). */
    position?: [number, number];
    /** Window width as a fraction of the frame width. */
    size?: number;
    snapshot?: SceneDocTerminalSnapshot;
  }

  interface SceneDocTerminalSnapshot {
    /** Viewport rows as styled runs; short or missing rows read as blank cells. */
    grid: SceneTerminalRun[][];
    cursor?: SceneTerminalCursor;
    /** Baked raster under `assets/` (grid pixels only, chrome renders live): the export truth. */
    src?: string;
    /** The transcript this grid was laid out from; absent on a grid captured from a live session. */
    transcript?: string;
  }

  /** A time in a sidecar: scene-local ms, or a musical position (`"bar:13.3"`, `"cue:drop"`) resolved at load by `engine/musicTime.ts`. */
  type SceneDocTimePosition = number | string;

  /** A macOS screen recording presented as a floating window (rounded corners + hairline edge) with an analytic drop shadow, floating over whatever the scene stages behind it; one per scene, sidecar-only (references a project asset, like video fills). Deep validation lives in `sceneVideoWindow.ts`. */
  interface SceneDocVideoWindow {
    /** Project-relative video, e.g. `"assets/screencast.mp4"`; `aspect` (width/height, recorded at pick time) sizes the window before the clip's intrinsics arrive. */
    media: { src: string; startMs?: number; loop?: boolean; aspect?: number };
    radius: VideoWindowRadius;
    /** Raw macOS window recording: crop the capture margins (baked shadow and background) and, under the `macos` radius preset, round at the capture's true pixel radius. Auto-detected at pick time from the poster's black margins. */
    recording?: boolean;
    border?: VideoWindowBorder;
    shadow?: VideoWindowShadow;
    motion?: VideoWindowMotion;
    /** Window size as a fraction of the frame's shorter axis (default 0.72, clamped 0.1..1). */
    scale?: number;
    /** Window placement as fractions of the frame (x right, y up, clamped -1..1); [0, 0] is centred, the motion preset rides on top. */
    offset?: [number, number];
  }

  interface SceneDocWebsite {
    url?: string;
    requestedOrigins?: string[];
    viewport?: SceneDocWebsiteViewport;
    frame?: SceneDocWebsiteFrame;
    position?: [number, number];
    size?: number;
    capture?: SceneDocWebsiteCapture;
  }

  interface SceneDocWebsiteCapture {
    src?: string;
    width?: number;
    height?: number;
    source?: SceneWebsiteCaptureSource;
    sourceOrigin?: string;
    fingerprint?: string;
  }

  interface SceneDocWebsiteFrame {
    appearance?: SceneWebsiteAppearance;
    cornerRadius?: number;
    shadow?: SceneWebsiteShadow;
  }

  interface SceneDocWebsiteViewport {
    preset?: SceneWebsiteViewportPreset;
    orientation?: SceneWebsiteOrientation;
    width?: number;
    height?: number;
    zoom?: number;
  }

  type SceneImageHost = "stage" | "overlay";

  type SceneImageMotionPreset = (typeof SCENE_IMAGE_MOTION_PRESETS)[number];

  /** One shared preset follows the image when its active host changes. */
  interface SceneImageMotionSpec extends SceneMotionFields {
    preset: SceneImageMotionPreset;
  }

  interface SceneImageOverlayPlacement {
    /** Frame-relative centre, matching overlay decoration coordinates. */
    position: [number, number];
    /** Width as a fraction of the frame width. */
    size: number;
    /** Clockwise screen rotation. */
    rotationDeg: number;
    shape: "none" | "circle";
    layer: "below" | "above";
    /** Optional stable ordering metadata used when inherited decorations are materialised. */
    stackOrder?: number;
  }

  interface SceneImageStagePlacement {
    position: [number, number, number];
    /** World-unit width. */
    size: number;
    rotationDeg: [number, number, number];
  }

  /** Presence, including an empty `items` array, transfers scene-text ownership to the inspector. */
  interface SceneManagedTextBlock {
    /** Keeps a scaffold's specialised TSX composition while its items remain inspector-owned. */
    layout?: "template";
    /** Optional Content-level grouping. Absence resolves every item into one implicit group. */
    groups?: SceneManagedTextGroup[];
    items: SceneManagedTextItem[];
  }

  /** One atomic Text row in Content. Copy leaves stay flat and globally keyed. */
  interface SceneManagedTextGroup {
    key: string;
    itemKeys: string[];
    align?: SceneTextAlign;
  }

  /** One inspector-owned text item. Fields stay dormant when `type` changes, so switching back is lossless. */
  interface SceneManagedTextItem {
    key: string;
    type: SceneManagedTextItemType;
    text?: string;
    points?: SceneManagedTextPoint[];
    icon?: string;
    marker?: SceneManagedTextMarker;
    /** Extra vertical gap between bullet points, in world units. */
    pointGap?: number;
    /** Hanging-indent distance between a bullet marker and its copy, in world units. */
    indent?: number;
  }

  type SceneManagedTextItemType = (typeof MANAGED_TEXT_ITEM_TYPES)[number];

  type SceneManagedTextMarker = (typeof MANAGED_TEXT_MARKERS)[number];

  interface SceneManagedTextPoint {
    key: string;
    text: string;
  }

  /** Media adds a third host to the image family's two: `window` floats an entry in the scene's own world space (the video window's home), placed by the OVERLAY numbers so no third placement block is needed. Video-only for now, so a still asking for it degrades to `overlay` at parse. */
  type SceneMediaHost = SceneImageHost | "window";

  type SceneMediaKind = "image" | "video";

  type SceneMediaMotionPreset = (typeof SCENE_MEDIA_MOTION_PRESETS)[number];

  interface SceneMediaMotionSpec extends SceneMotionFields {
    preset: SceneMediaMotionPreset;
  }

  /** Playback fields for a `video` entry; `aspect` (width/height, recorded at pick time) sizes the entry before the clip's intrinsics arrive. */
  interface SceneMediaVideoSpec {
    startMs?: number;
    /** Musical position the start sits on; `startMs` caches its resolved scene-local value and a move that disagrees drops it. */
    at?: string;
    loop?: boolean;
    aspect?: number;
  }

  /** Optional window chrome, available to both kinds: rounded corners, the macOS window-recording crop, an edge stroke and an analytic drop shadow. Absent renders the plain plane. Defaults and clamps live in `sceneVideoWindow.ts`. */
  interface SceneMediaWindow {
    radius: VideoWindowRadius;
    recording?: boolean;
    border?: VideoWindowBorder;
    shadow?: VideoWindowShadow;
  }

  /** The tuning shared by every motion preset, whichever content family carries it. */
  interface SceneMotionFields {
    /** `turntable`: rotation rate in degrees per second. */
    degPerSec?: number;
    /** `float` / `drift`: Stage world units (degrees for `drift`) before the Overlay host adaptation. */
    amplitude?: number;
    /** `float` / `drift`: cycles per second. */
    hz?: number;
    /** `tilt-reveal` / `push-in`: intro length in ms. */
    durationMs?: number;
  }

  /** A normalized segment: key ids resolved to the SHARED key objects, `smooth` resolved, and the spline's shaping neighbours pinned. */
  interface SceneRigSegment {
    from: SceneDocRigKey;
    to: SceneDocRigKey;
    /** An `engine/ease.ts` name (`ease()` degrades unknown names at sample time). */
    ease: string;
    /** Resolved from the sidecar's optional flag: absent means smooth. */
    smooth: boolean;
    /** Position of the key before `from`, REFLECTED through `from` at the path's start (see `reflect`). */
    before: V3;
    /** Position of the key after `to`, reflected through `to` at the path's end. */
    after: V3;
    easePosition?: string;
    easeRotation?: string;
    easeLens?: string;
    easeDof?: string;
  }

  /** A validated, sorted rig track (keys ascending; segments ordered, non-overlapping). */
  interface SceneRigTrack {
    keys: SceneDocRigKey[];
    segments: SceneRigSegment[];
    /** Track-level dof summary; null/absent when no key authors a dof block. */
    dof?: TrackDof | null;
    /** Per-key EFFECTIVE dof after carry-forward, keyed by key id (normalise-time product). */
    dofByKey?: Map<string, EffectiveDof | null>;
  }

  /** Stage state for the mounted scene: non-null inside a `<SceneStage>` whose theme (merged with the sidecar's staging overrides) actively lights the scene; created inside the canvas subtree (bridges within the r3f reconciler, the SceneContext rule). */
  interface SceneStageState {
    /** True when the stage casts real shadow maps; staged primitives participate while their presentation shadows remain independent. */
    mapShadows: boolean;
    /** World y of the staged floor plane when the resolved backdrop is a floor, else null (nothing to ground on). */
    floorY: number | null;
  }

  type SceneTerminalChromeStyle = "mac" | "bare";

  /** A run colour: an ANSI palette index (0-255) or a `#rrggbb` hex; null/absent means the theme's default fg/bg. */
  type SceneTerminalColour = number | string;

  interface SceneTerminalCursor {
    col: number;
    row: number;
    /** Absent is visible. */
    visible?: boolean;
  }

  /** One styled run of a snapshot row: text, then optional fg, bg and a flag bitfield. */
  type SceneTerminalRun = [
    text: string,
    fg?: SceneTerminalColour | null,
    bg?: SceneTerminalColour | null,
    flags?: number,
  ];

  type SceneWebsiteAppearance = "match-theme" | "light" | "dark";

  type SceneWebsiteCaptureSource = "snapshot" | "image";

  type SceneWebsiteOrientation = "landscape" | "portrait";

  type SceneWebsiteShadow = "none" | "soft" | "strong";

  /** Website scene content: field-level parsing, secure URL normalisation, capture freshness and shared frame geometry. The live native view and deterministic WebGL poster both consume this pure contract. */
  type SceneWebsiteViewportPreset = "desktop" | "tablet" | "mobile" | "custom";

  /** The device pose the silhouette is built from: everything the inner animated group applies, so a float lifts the shadow off the floor and a turntable spin narrows it. */
  interface ShadowPose {
    /** Placement scale times the model's auto-fit is NOT included: slabs are authored in fitted units and scaled by `scale` alone. */
    scale: number;
    /** Radians, applied X then Y then Z, matching the inner group's rotation order. */
    rotation: V3;
    /** Local-space offset of the animated group (the float lift). */
    offset: V3;
    /** The intro presets' uniform scale on top of `scale`. */
    introScale: number;
    /** Lid opening in degrees; ignored by devices with no hinge. */
    lidDeg: number;
    /** Fold angle in degrees (0 closed, 180 open flat); ignored by devices that do not fold. */
    foldDeg?: number;
  }

  /** The promoted key light. `azimuthDeg`/`elevationDeg`/`intensity`/`color` are byte-compatible with `ThemeLightSpec`, so a v8 `key` block parses straight in. */
  interface SunSpec {
    azimuthDeg: number;
    elevationDeg: number;
    intensity: number;
    /** 1000..20000. Wins over `colorToken` and `color` when present. */
    kelvin?: number;
    /** Theme colour token name, resolved against the active theme at render time. */
    colorToken?: string;
    /** sRGB hex. Kept for v8 compatibility. */
    color?: string;
    /** Apparent angular diameter in degrees. Real sun is 0.53. Drives shadow softness. */
    angularDeg?: number;
    /** Default true. */
    castShadow?: boolean;
    /** Default true. False keeps the entry for keyframing without lighting anything. */
    enabled?: boolean;
  }

  /** The animation window: `from`→`to` plays the in preset (a resolved delayMs holds the pre-entry state that long after `from`, then the in plays over the same `to − from` duration); `outAt` (optional) starts the out and never shifts. */
  interface TextAnimTiming {
    anim: ResolvedTextAnimation;
    from: number;
    to: number;
    /** Out start, ms; the out plays over the same duration as the in unless `outDurationMs` sets its own. Absent = no out. */
    outAt?: number;
    /** How long the out lasts, ms; absent plays it over the in's duration. */
    outDurationMs?: number;
  }

  /** Named text in/out animation presets, overridable per primitive and per scene via the sidecar's `textAnimation` (whole-spec, the backdrop pattern). Later params are additive optionals themeing the motion pack. */
  interface TextAnimationSpec {
    in: string;
    out: string;
    staggerMs: number;
    /** `staggerMs: 0` means exactly 0; absent, a 0 under a granularity falls back to that granularity's default delay. */
    staggerExact?: true;
    /** Stagger granularity when staggerMs > 0 (default "word"). */
    stagger?: "char" | "word";
    /** Hold before the in starts, ms (clamped to ≥ 0 at resolve; the out never shifts). */
    delayMs?: number;
    /** fade-scale: starting scale, landing at 1 (clamped 0.05-4 at resolve; default 0.8). */
    startScale?: number;
    /** fade-scale: sweep the soft white shine band once during the scale-in. */
    shine?: boolean;
    /** twist-scale: which side the card turns in from (default "from-left"). */
    direction?: "from-left" | "from-right";
    /** all-at-once forces the block path; paragraphs split on `\n`, groups on blank lines. */
    delivery?: "all-at-once" | "by-paragraph" | "by-paragraph-group";
    /** Optional in/out window length. Absent keeps each primitive's authored timing. */
    durationMs?: number;
    /** Optional preset travel distance in em. Absent keeps each preset's tuned distance. */
    distance?: number;
    /** build: how far each arriving word slides in, em (default 0.3; the line itself always re-centres). */
    buildShiftEm?: number;
    /** An engine/ease.ts name. Absent keeps the theme's standard easing. */
    ease?: string;
    /** Motion blur override; absent inherits the scene's Objects switch (see engine/motionBlur.ts). */
    motionBlur?: MotionBlurOverride;
  }

  /** The two paragraph-capable delivery spellings. */
  type TextDelivery = "all-at-once" | "by-paragraph" | "by-paragraph-group";

  type TextDirection = "from-left" | "from-right";

  /** Named text style presets (the "text look" catalogue), overridable per primitive and per scene via the sidecar's `textLook` (whole-spec, the textAnimation pattern). Params are per-look optionals, clamped and defaulted at resolve (toolkit/text/looks.ts). */
  interface TextLookSpec {
    /** "none" or a TEXT_LOOK_NAMES entry; unknown names coerce at resolve, never at parse. */
    preset: string;
    /** Primary look colour, hex. Absent falls back to the theme accent at render. */
    colorA?: string;
    /** Gradient stop B, hex. Absent renders a darkened colorA. */
    colorB?: string;
    /** Gradient axis in degrees (default 90, vertical). */
    angleDeg?: number;
    /** Outline stroke width in em (default 0.035). */
    strokeEm?: number;
    /** Outline: hide the fill, stroke only (default true). */
    hollow?: boolean;
    /** Neon glow / glass strength scalar 0..1 (default 0.6). */
    intensity?: number;
    /** Offset-print under-layer displacement in em (default 0.06). */
    offsetEm?: number;
    /** Offset-print direction in degrees clockwise from up (absent keeps the classic down-right, 135); the distance stays the default diagonal's. */
    offsetDir?: number;
    /** Offset-print under-layer opacity 0..1 (absent is fully opaque). */
    offsetOpacity?: number;
    /** Arc: total bend in degrees, positive arcs upward (default 60). */
    curveDeg?: number;
  }

  /** Per-preset params, always present, fully defaulted at resolve. */
  interface TextPresetParams {
    /** fade-scale: the starting scale, landing at 1 (0.8 grows in; 1.15 settles down). */
    startScale: number;
    /** twist-scale: an explicitly authored starting scale; absent preserves the tuned legacy 0.92. */
    twistStartScale?: number;
    /** fade-scale and twist-scale: sweep the soft white shine band once, during the scale-in only. */
    shine: boolean;
    /** twist-scale and orbit (the sweep sign): +1 = from-left, −1 = from-right. */
    twistDir: 1 | -1;
    /** build: an explicitly authored word slide, em; absent keeps BUILD_SHIFT_EM. */
    buildShiftEm?: number;
  }

  /** Default staging. Scenes can override via their sidecar; `none` = flat colour. */
  type ThemeBackdrop =
    | { type: "none" }
    | { type: "floor"; color: string; filletRadius?: number }
    /** `gradient` names a THEME gradient; `spec` carries an inline self-contained gradient (the unified Background editor's write-through). One must be present; `spec` wins when both are. */
    | { type: "gradient"; gradient?: string; spec?: GradientSpec }
    | { type: "image"; src: string; fit?: "cover" | "contain" };

  /** Camera-locked, frame-filling background, drawn behind ALL world content and COMPOSABLE with `backdrop` (a fixed image can sit behind a shadowed cyclorama). Vocabulary: `colors.background` clears the frame, `background` is a camera-locked fill over that clear and behind world content, `backdrop` is world-space staging. Image/gradient fills cover-crop, centred, one asset serves every aspect. `parallax` (0..0.5, default 0 = hard-locked) drifts the fill at that fraction of the content's screen motion; `image.src` is `kookaburra:<name>` (bundled) or a project-relative path. */
  type ThemeBackground =
    | { type: "none" }
    | { type: "color"; color: string; parallax?: number }
    /** `gradient` names a THEME gradient; `spec` (the picker) carries an inline self-contained gradient, theme-independent presets/customs. One must be present; `spec` wins when both are. */
    | { type: "gradient"; gradient?: string; spec?: GradientSpec; parallax?: number }
    | { type: "image"; src: string; parallax?: number }
    /** A looping video fill riding the clip frame pipeline. SCENE-DOC ONLY (decision 5: themes are workspace-shared and can't reference project assets; the theme parser drops it). Absent `loop` = true; `loop: false` holds the last frame. Absent `fit` = `fill` (cover-crop to fill the frame); `fit` letterboxes the whole video with bars in the theme background colour. */
    | { type: "video"; src: string; parallax?: number; loop?: boolean; fit?: "fill" | "fit" }
    /** A world-space animated 3D background (SCENE3D_BACKGROUNDS): real geometry mounted in the scene, so it parallaxes with camera rigs, staged outside the content volume with a keep-out clearance and distance fades. `backing` nests any camera-locked 2D background behind the geometry (another scene3d is rejected by the parser). Theme-safe (no asset references). */
    | {
        type: "scene3d";
        look: string;
        colors?: string[];
        /** Live Theme preset: derive geometry colours from the active theme at resolve time (scene3d/Scene3dBackdrop.tsx); while set, explicit `colors` are ignored. */
        themeColors?: boolean;
        speed?: number;
        params?: Record<string, number>;
        backing?: ThemeBackground;
        /** Bundled preset id last applied by the picker; the renderer never reads it, only the inspector's Reset and tile highlight do. */
        preset?: string;
      }
    /** An animated GLSL fill (the vendored paper-design pack): `shader` names a SHADER_BACKGROUNDS id, `colors` are hexes filling the effect's slots, `speed` multiplies the ABSOLUTE project clock (continuous across scene cuts), `params` are the effect's own numeric knobs. Theme-safe (no asset references). */
    | {
        type: "shader";
        shader: string;
        colors?: string[];
        /** Live Theme preset: derive slot colours from the active theme's tokens at resolve time (shaders/themePreset.ts); while set, explicit `colors` are ignored and the fill follows theme switches. */
        themeColors?: boolean;
        speed?: number;
        scale?: number;
        params?: Record<string, number>;
        parallax?: number;
        /** Bundled preset id last applied by the picker; the renderer never reads it, only the inspector's Reset and tile highlight do. */
        preset?: string;
      };

  /** Card surfaces (layered-screenshot screens): corner radius as a fraction of the card's short edge, clamped 0..0.5 at parse. Absent themes take the toolkit's tuned constant. */
  interface ThemeCard {
    radius: number;
  }

  /** Environment reflections (IBL), the v8 theme block: `source` is a bundled HDRI id (`kookaburra:<name>`) or the Lightformer preset id (`kookaburra:softbox`). Project-relative `.hdr`/`.exr` sources and the explicit `"none"` live on the v9 `LightingSpec.environment` (same shape, wider vocabulary). Preloaded before frame 0 via `preloadEnvironments`. */
  interface ThemeEnvironment {
    source: string;
    intensity: number;
    rotationDeg: number;
  }

  /** One directional light, aimed at the origin from an orbit direction (the pose idiom). */
  interface ThemeLightSpec {
    azimuthDeg: number;
    elevationDeg: number;
    intensity: number;
    /** sRGB hex; defaults to white. */
    color?: string;
  }

  type ThemeMode = "light" | "dark";

  /** Shadow-map tokens: fixed values are an EXPORT CONTRACT (the GSAA σ²/κ precedent). Shadows render only when a scene stages a floor/backdrop (hybrid decision); the devices' own analytic presentation shadows remain the default everywhere else. */
  interface ThemeShadowSpec {
    technique: "map" | "none";
    /** False disables real cast shadows and catchers while retaining the configured style. */
    enabled?: boolean;
    /** False keeps floor catching but disables vertical backdrop catching. */
    catchBackdrop?: boolean;
    /** 0..1 penumbra scale (drives the light's shadow radius). */
    softness: number;
    /** 0..1 darkening of the shadow catcher. */
    opacity: number;
    mapSize: number;
    bias: number;
    /** Shadow tint on the catcher (sRGB hex; default black). Light themes want a hair of colour, pure black shadows read synthetic on white floors. */
    color?: string;
  }

  /** Track-level summary decided once at normalise time. */
  interface TrackDof {
    mode: DofMode;
    /** True when any key's effective blur exceeds 0: what routes the scene through the composer. */
    active: boolean;
  }

  /** The window's edge stroke. `width` is a fraction of the short edge, `opacity` 0..1; `enabled: false` turns it off. */
  interface VideoWindowBorder {
    enabled: boolean;
    color: string;
    width: number;
    opacity: number;
  }

  /** Canned gentle motion for the window itself (pure functions of scene-local time); the per-scene camera track composes on top. */
  interface VideoWindowMotion {
    preset: VideoWindowMotionPreset;
    /** `float`: world-unit bob amplitude (default 0.12). `drift`: sway in degrees (default 4). */
    amplitude?: number;
    /** `float`/`drift`: cycles per second (defaults 0.3 / 0.1). */
    hz?: number;
    /** `tilt-reveal`/`push-in`: intro length in ms (defaults 900 / 1000). */
    durationMs?: number;
  }

  type VideoWindowMotionPreset = "none" | "float" | "tilt-reveal" | "push-in" | "drift";

  /** Corner radius for the video window: a named preset, or a custom short-edge fraction (clamped 0..0.5 at resolve). `macos` emulates a real macOS window's rounding, and under `recording: true` it resolves to the capture's true pixel radius. */
  type VideoWindowRadius = "sharp" | "subtle" | "macos" | "rounded" | { custom: number };

  /** The window's analytic drop shadow onto the backing stage. `blur` and `offset` are fractions of the window's short edge (offset x right, y up); `opacity` is 0..1. */
  interface VideoWindowShadow {
    opacity: number;
    blur: number;
    offset: [number, number];
    /** `#rrggbb`; absent is the black soft shadow. With `blur: 0` it is a hard shadow. */
    colour?: string;
  }

  /** Vignette params. `darkness` 0 = no vignette. */
  interface VignetteParams {
    offset: number;
    darkness: number;
  }

  /** World-space plane size for a clip inside the format's frame rectangle, honouring `fit` (`contain` letterboxes, `cover` fills and lets overflow clip via the frustum); returns `[0, 0]` until the clip geometry is known. */
  function clipPlaneSize(fit: "cover" | "contain", frame: { width: number; height: number }, clip: { width: number; height: number }): { width: number; height: number };

  export {};
}
