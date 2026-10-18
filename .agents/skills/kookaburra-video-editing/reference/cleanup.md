# Cleanup: removing dead time

`./kb video cleanup NAME` cuts what nobody wants to watch (black, long heads and tails, still
screens, a cursor blinking while nothing happens) and speeds up loading spinners. It applies and
reports; `--dry-run` shows the same report and writes nothing. Run it on a source path and it uses
(or makes) that recording's edit.

## What the analysis sees

`./kb video analyse NAME|SRC` decodes the recording once (cached by content) and splits it into
intervals, each with a confidence:

| Kind | What it is | Confidence |
| --- | --- | --- |
| `black` | Nothing but black (a dark splash with a logo is not black) | 0.98 |
| `lead-in`, `lead-out` | Idle before the first action, idle after the last | as static |
| `idle static` | Nothing changes. A Simulator recording's held frame is certain | 0.99 held frame, 0.95 truly still, 0.85 near still |
| `idle blink` | Only a text cursor toggling | 0.9 |
| `idle loading` | A small spot changing fast and regularly (a spinner) | 0.6 to 0.8 by regularity |
| `active` (`typing`) | Anything else; small changes moving along a few times a second are typing | never cut |

Events: `screen-change` (a new screen) and `tap-candidate` (a small change after a still moment,
followed within 700 ms by a new screen: a likely touch, with its spot). Camera footage (every frame
changes) is analysed as `camera`: only black and true freezes count. `--profile screen|camera`
overrides the guess.

## What cleanup never touches

- Active stretches and typing, plus a pad either side.
- Screen changes, plus reading time after each.
- The edit's taps and tap candidates of confidence 0.7 or more, plus a guard either side.
- `--keep A-B` (timeline ranges; repeatable) and `--skip iN` intervals (`s2:i4` for another source).
- Clips that are retimed, frozen or stills (reported as left alone). It never reorders.

## Strength

| | gentle | normal (default) | aggressive |
| --- | --- | --- | --- |
| Minimum confidence to cut | 0.9 | 0.8 | 0.6 |
| Pad after activity | 800 ms | 500 ms | 300 ms |
| Reading time after a screen change | 1500 ms | 1000 ms | 600 ms |
| Pad before the next activity | 500 ms | 300 ms | 200 ms |
| Head kept before the first action | 600 ms | 400 ms | 250 ms |
| Tail kept after the last action | 1500 ms | 1000 ms | 600 ms |
| Smallest cut worth making | 700 ms | 400 ms | 200 ms |
| Loading: fastest speed, longest result | 2x, 2 s | 4x, 1 s | 6x, 0.6 s |
| Tap guard before/after | 600/900 ms | 400/700 ms | 300/600 ms |
| Shortest piece left between cuts | 600 ms | 400 ms | 250 ms |
| Closest two jumps may be | 1.5 s | 1 s | 0.6 s |
| Most it may remove | 60% | 80% | 92% |

Loading is sped up (never cut) with the smallest menu speed that brings it under the longest result,
up to the fastest speed; any detected loading (confidence 0.6 or more) qualifies. `--no-speed` turns
that off; `--cuts-only` keeps the head and tail too and only cuts inside.

Choose gentle when the user mentions reading, a tutorial or "keep it natural"; aggressive only for
"as tight as possible". Past the removal cap cleanup refuses (exit 1): the analysis has probably
mistaken something for idle. Look at the sheet, then rerun with `--gentle` or `--keep`.

## How it cuts

Cuts sit at least two output frames inside a still stretch, on whole milliseconds, so the frame
either side of the jump is the same still screen and the jump is invisible. A cut that would leave a
sliver under the shortest piece, or jumps closer than the spacing above, is dropped (the report says
why). Ranges apply in source time to every copy of that stretch. A second run finds nothing to do.

## Reading the report

```
sim-checkout: changed 28.00s -> 13.63s (1680 -> 818 frames) at normal
  cut              source s1 0.00-3.00s  timeline 0.00s-3.00s  black and what follows i1+i2 (0.98), saves 3.00s
  sped up to 4x    source s1 11.17-17.70s  timeline 11.17s-17.70s  idle loading i5 (0.80), saves 4.90s
  kept i8 idle static 21.75-25.00s: --skip
  taps protected: t1
changes sheet: ~/Kookaburra Cut/_bridge/video/<slug>/sheets/sim-checkout/cleanup-changes-....png
next: Read the changes sheet, then kb video render sim-checkout; undo: kb undo; open in the editor: kb video open sim-checkout
```

- Timeline ranges are where the change sat BEFORE cleanup.
- The changes sheet pairs the last frame before each jump with the first after (red edge), plus
  each speed change; Read it. Identical pairs mean an invisible cut.
- `--emit-plan` prints the source-range ops (`cutSource`, `speedSource`) instead of applying them,
  for `./kb video apply NAME -` after you edit the list.
- `./kb video taps suggest NAME` lists tap candidates with the commands to check and add each.
