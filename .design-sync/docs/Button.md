---
category: Actions
---

Neutral raised button — the default control. `primary` is the single accent-filled CTA (buff-gold fill, near-black text); use at most one per surface, always the concluding action. `small` is the 22px dense-row variant.

```tsx
<Button>Cancel</Button>
<Button primary>Export</Button>
<Button small>✎ Edit scene</Button>
<Button small primary>＋ New scene</Button>
```

Labels with live numerics (export %) stay width-stable — the class applies `tabular-nums`.
