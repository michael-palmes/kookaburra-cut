/** What the compiler can't read off the toolkit's source: a working example and the timing rules `kb toolkit show` prints. `toolkitDocs.test.ts` holds every example to the real props, so a renamed prop fails here first. */
export const TOOLKIT_SHOW: Readonly<
  Record<string, { example?: string; timing?: readonly string[] }>
> = {
  AnimatedHeadline: {
    example: `<AnimatedHeadline text={title} textKey="title" fontSize={0.6} preset="stamp" hitAt={grid?.bar(5) ?? 2000} to={600} />`,
    timing: [
      "from to to is the in window, ms: each unit plays the whole window and later units start stagger ms later, so the last settles after `to`.",
      "A motion's durationMs wins over `to`: the `durationMs` prop pins first unit's start to last unit's settle (stagger and unit duration scale together), a sidecar spec's durationMs replaces the window.",
      "hitAt is the first unit's landing: the in keeps its duration and starts the motion's lead earlier (delayMs included). See kb catalog textMotion for each motion's measured impactMs at 600 ms; it wins over `from`.",
      "An out starts at outAt, plays over outDurationMs (default the in's duration) and never shifts with hitAt or delayMs.",
    ],
  },
  AnimatedCounter: {
    example: `<AnimatedCounter from={0} to={1200} durationMs={1600} startMs={400} ease="outCubic" />`,
    timing: [
      "The count runs startMs to startMs + durationMs. hitAt lands it on `to` at that ms, starting durationMs earlier.",
      "steps: equal jumps where the EASED progress crosses each k/n, so the first falls after 1/n (never at startMs), the last exactly at the end, and ease moves the ones between.",
      'stepsAt: one jump at each ms, whatever the window says, landing on `to` on the last. ticks="beats": one on every grid beat inside the window. Both pop; with them ease bends how far each jump goes, not when.',
    ],
  },
  AnimatedGroup: {
    example: `<AnimatedGroup preset="fade-up" hitAt={1200} to={500}><ImageCard src="assets/icon.png" /></AnimatedGroup>`,
    timing: [
      "from to to is the in window, the whole group one unit. durationMs pins it; hitAt lands it, starting the motion's lead earlier and winning over `from`.",
      "An out starts at outAt and plays over the same duration as the in.",
    ],
  },
  Stamp: {
    example: `<Stamp hitAt={2000}><AnimatedHeadline text={title} preset="static" /></Stamp>`,
    timing: [
      "at is when the pop starts; hitAt is when it first reaches full size, about 95 ms after the start on the default pop (kb catalog stamps). It overshoots at inMs and settles by inMs + settleMs.",
    ],
  },
  ImageCard: {
    example: `<ImageCard src="assets/mark.png" width={1} tint="accent" from={0} to={300} outAt={3000} />`,
    timing: [
      "from to to is a linear fade-in; absent is opaque at once. outAt starts a linear fade-out over outDurationMs (default the fade-in's length, else 300 ms). opacity multiplies both.",
    ],
  },
  ScreenLayer: {
    example: `<ScreenLayer order="front"><Scrim to="background" start={0.5} /><AnimatedHeadline text={title} position={[0, -1.4, 0]} /></ScreenLayer>`,
    timing: [
      "Children stack in JSX order. front draws over the finished frame, past depth of field and, on a solo frame, past the effects; during a transition it crossfades with its scene and picks up the effects.",
      "back draws over the background and under everything 3D, inside the scene's own pass: effects and depth of field apply to it like the backdrop.",
    ],
  },
  Vignette: {
    example: `<Vignette opacity={0.6} keys={[{ tMs: 0, opacity: 0 }, { tMs: 500, opacity: 0.6 }]} />`,
    timing: [
      "keys override the props they name; a keyed fill holds stills until its last key lands.",
    ],
  },
  Scrim: {
    example: `<Scrim to="background" kind="linear" angleDeg={180} start={0.4} opacity={0.8} />`,
    timing: [
      "keys override the props they name; a keyed fill holds stills until its last key lands.",
    ],
  },
  Gradient: {
    example: `<Gradient from="accent" to="background" kind="radial" />`,
    timing: [
      "keys override the props they name; a keyed fill holds stills until its last key lands.",
    ],
  },
  StagedObject: {
    example: `<StagedObject objectId="bitcoin-coin" position={[0, 0.3, 0]} rotationDeg={[0, 20, 0]} scale={1.2} />`,
    timing: [
      "objectId placed in TSX loads when it first mounts, even mid-film: every capture waits for it, so no frame shows it missing. A preview pops it in. No gizmo: use the sidecar `objects` array for an object the inspector should move.",
    ],
  },
  useBeatGrid: {
    example: `const grid = useBeatGrid();\nconst hit = grid?.at(5, 3) ?? 2000;`,
    timing: [
      "Null without an audio.grid. at(bar, beat?, sixteenth?) and bar(...) are 1-based scene-local ms, negative before the scene; at(position) also takes cue: and section: and throws when it can't resolve.",
    ],
  },
  useBeatAt: {
    example: `const at = useBeatAt();\nconst hit = at(5, 3) ?? 2000;`,
    timing: [
      "Scene-local ms, or null with one log line when the project has no grid, so `?? ms` keeps the scene's own timing.",
    ],
  },
  useTextMetrics: {
    example: `const metrics = useTextMetrics("title", title, { fontSize: 0.6 });\nconst size = metrics?.fitFontSize(2) ?? 0.6;`,
    timing: [
      "Null until the face has loaded, so never divide by a width you haven't checked. Captures wait for the measure.",
    ],
  },
  useFormat: {
    example: `const format = useFormat();\nconst size = format.shape === "wide" ? 0.6 : format.shape === "square" ? 0.5 : 0.36;`,
    timing: [
      'shape: "wide" from aspect 1.2 (16:9, 3:2, 5:4), "tall" at 0.85 and below (9:16, 2:3, 4:5, phone), else "square" (1:1).',
    ],
  },
};
