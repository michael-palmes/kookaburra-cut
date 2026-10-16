# Recipes

Each starts with `kb status` and ends with a capture you Read and a plain-words report. `kb video X`
is the full `python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py video X`.

## "Cut the dead time and put it on the phone in scene 3"

```
kb video list                                    is there an edit already? (else:)
kb video new assets/sim-checkout.mov
kb video sheet sim-checkout                      Read: what is in it
kb video cleanup sim-checkout --dry-run          Read the changes sheet it prints
kb video cleanup sim-checkout                    applies (checkpointed)
kb video sheet sim-checkout --seams              Read: jumps sit on still screens, nothing important lost
kb video usages sim-checkout                     which slot shows it now
kb video render sim-checkout --use --scene 3 --slot device
kb check --app
kb capture --scene 3 --frames 3@0.5,3@2,3@4 --sheet     Read
```

Run the render in the background when the recording is long. If scene 3 has a fixed length and the
video is now shorter, the phone holds the last frame: offer `kb video fit sim-checkout --scene 3`,
or a follow-media scene (reference/media.md in the scene skill). Report: "The recording went from
28.0 s to 11.3 s: I removed the black start, a 5 s wait on a blinking cursor, two still screens and
the last second, and the loading spinner now plays 4x faster. It is on the phone in scene 3.
`kb undo` puts it back, and `kb video open sim-checkout` shows it in the editor."

## "Fit the 8 s scene and land the checkout tap on beat 4"

```
kb beats --scene 3                               the scene's beats, scene-local ms
kb video show sim-checkout                       the taps (none yet? see below)
kb video fit sim-checkout --scene 3 --dry-run    then without --dry-run
kb video align sim-checkout --tap t1 --beat 4 --scene 3 --keep-length
kb video frames sim-checkout --tap t1            Read: the touch shows from 0 ms, gone by +550
kb video render sim-checkout --use --scene 3
kb capture --scene 3 --at <beat 4 in seconds>    Read
```

No tap yet: `kb video taps suggest sim-checkout`, then for the checkout touch
`kb video frames sim-checkout --src s1@24.967 --grid`, Read it, and only when the touch is visible
`kb video tap add sim-checkout --src s1@24.967 --pos 0.694,0.383`. Align tries the scene side first
(shifting the phone's start by up to 1.5 s, no re-render) and says which it did; with `--keep-length`
an edit-side align keeps the 8 s fit.

## "Blur the email in the first 5 s"

```
kb video frames sim-checkout --at 0.5 --grid     Read: find the email; say x 0.08-0.62, y 0.21-0.25
kb video frames sim-checkout --at 0.5 --zoom 0,0.15,0.7,0.15 --grid     Read the edges closely
kb video mask add sim-checkout --at 0 --rect 0.06,0.20,0.58,0.06 --until 5 --style blur
kb video frames sim-checkout --mask m1           Read: span start, every key, both ends, the zoom
kb video sheet sim-checkout --count 24           Read: does the email appear again later?
kb video render sim-checkout
```

Pad the box a little past the text. If the field scrolls, key the box where it moves
(`kb video mask key sim-checkout m1 --at 2.4 --rect ...`) and check the frames again. If the email
shows later on another screen, add a mask there too. Pixelate (`--style pixelate`) or a solid
box (`--style solid --colour "#1C1C1E"`) when blur still hints at the text; raise `--strength`.

## Joining recordings, stills and end holds

```
kb video new assets/part-1.mov --name onboarding
kb video append onboarding assets/part-2.mov                 joins end to end (letterboxed if sizes differ)
kb video insert onboarding assets/title.png --at 0 --hold 1.5
kb video append onboarding assets/end-card.png --hold 2
kb video freeze onboarding --at end --hold 1.5               hold the last frame instead
kb video hold onboarding last 2.5                            change that hold later
kb video move onboarding c3 --before c1                      reorder
```

The first source sets the output size; others fit inside it. Render, use and check as above.

## Undo and recovery

- `kb undo` restores the edit document (and scenes) to the last checkpoint; re-render afterwards,
  because renders are not versioned (`kb video list` shows which renders are stale).
- A document that will not load: `kb video reset NAME --yes` rebuilds it from its source (the broken
  file is kept as `.json.bak`).
