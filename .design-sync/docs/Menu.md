---
category: Overlays
---

Dropdown action menu: an elevated panel of MenuItems that positions itself below its trigger. Wrap trigger + Menu in a relatively-positioned host (`className="dropdown-host"`).

```tsx
<div className="dropdown-host">
  <Button small>⋯</Button>
  <Menu>
    <MenuItem>Duplicate scene</MenuItem>
    <MenuItem>Reveal in Finder</MenuItem>
    <MenuItem disabled>Delete scene</MenuItem>
  </Menu>
</div>
```
