import { Chip, Field, TextInput } from "@kookaburra/chrome";

export const WithInput = () => (
  <div style={{ width: 320 }}>
    <Field label="Scene name">
      <TextInput defaultValue="03-device-hero" />
    </Field>
  </div>
);

export const WithHint = () => (
  <div style={{ width: 320 }}>
    <Field label="Duration" hint="Whole seconds, 1–60.">
      <TextInput defaultValue="8" style={{ width: "5.5rem" }} />
    </Field>
  </div>
);

export const WithChips = () => (
  <div style={{ width: 380 }}>
    <Field label="Text motion">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <Chip>Theme default</Chip>
        <Chip selected>fade-scale</Chip>
        <Chip>twist-scale</Chip>
        <Chip>scatter-scale</Chip>
      </div>
    </Field>
  </div>
);
