---
category: Overlays
---

Modal dialog on the scrim: elevated surface, 12px radius, the app's one dialog shadow. `wide` (46rem) hosts pickers and grids. Compose the body from Field/TextInput/Select; put the single `primary` Button last in `actions`.

```tsx
<Modal
  title="New project"
  onClose={close}
  actions={
    <>
      <Button onClick={close}>Cancel</Button>
      <Button primary>Create</Button>
    </>
  }
>
  <Field label="Name">
    <TextInput placeholder="spring-launch" />
  </Field>
</Modal>
```

Inline validation: `<p className="modal-error">…</p>` (danger) and `<p className="modal-hint">…</p>` (tertiary).
