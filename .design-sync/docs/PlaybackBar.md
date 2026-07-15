---
category: Frame
---

Segmented per-scene playback bar (v13): round play/pause (a raised fill — deliberately NOT accent-filled; the accent stays reserved for the playhead), a mute toggle, one flex-weighted cell per scene with a 2px accent playhead over the track, a labels row beneath, the mono timecode readout and a dashed New scene affordance. Sits at the bottom of the stage column.

```tsx
<PlaybackBar
  scenes={[
    { name: "Opening", durationMs: 2400 },
    { name: "Device", durationMs: 3100 },
  ]}
  activeIndex={1}
  fraction={0.34}
  readout="00:03.0 / 00:05.5"
  onPlayPause={toggle}
  onNewScene={addScene}
/>
```

Cells tile on scene START boundaries and flex-weight by duration, so widths mirror the timeline. Scrubbing is frame-accurate stepping — never animate or ease the playhead.
