---
category: Overlays
---

Corner toast: elevated surface with a 3px semantic left edge (success green by default, `kind="error"` for danger). Anchors to the top-right of its nearest positioned ancestor — give the host `position: relative`. Semantics stay an edge + text, never a full-panel wash.

```tsx
<Toast actionLabel="Reveal in Finder" onAction={reveal} onClose={dismiss}>
  Export complete — launch-2026-16x9.mp4
</Toast>
<Toast kind="error" onClose={dismiss}>
  ffmpeg exited 1 — see the export log
</Toast>
```
