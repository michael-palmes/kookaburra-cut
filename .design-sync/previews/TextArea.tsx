import { Field, TextArea } from "@kookaburra/chrome";

export const Default = () => (
  <div style={{ width: 380 }}>
    <Field label="Describe the scene">
      <TextArea placeholder="A slow push-in on the handset while the headline fades up…" />
    </Field>
  </div>
);
