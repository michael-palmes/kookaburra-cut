---
category: Frame
---

Custom macOS titlebar (46px, v13): the left ~78px stays clear for the traffic lights, the project identity leads as name stacked over its display path, and global actions right-align after the spacer — Export is the ONLY accent control. In the real app the bar is the window-drag region and every child is no-drag.

```tsx
<Titlebar title="launch-2026" subtitle="~/Kookaburra Cut/launch-2026">
  <Button small>Find an action ⌘K</Button>
  <Button small primary>Export</Button>
</Titlebar>
```
