---
category: Forms
---

Settings/preferences row: semibold title + tertiary detail on the left, the control on the right, on a bordered panel card. Rows stack with a 6px gap automatically.

```tsx
<SettingsRow title="Workspace" detail="~/Kookaburra Cut">
  <Button small>Change…</Button>
</SettingsRow>
<SettingsRow title="Default codec" detail="Used by Verify and quick exports">
  <Select defaultValue="libx264">
    <option value="libx264">H.264 (deterministic)</option>
    <option value="prores_ks">ProRes 422 HQ</option>
  </Select>
</SettingsRow>
```
