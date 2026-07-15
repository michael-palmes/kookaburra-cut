import { Field, TextInput } from "@kookaburra/chrome";

export const Default = () => <TextInput placeholder="launch-2026" style={{ width: 280 }} />;

export const WithValue = () => <TextInput defaultValue="spring-launch" style={{ width: 280 }} />;

export const InAField = () => (
  <div style={{ width: 320 }}>
    <Field label="Project name" hint="Lowercase, dashes — becomes the folder name.">
      <TextInput placeholder="my-project" />
    </Field>
  </div>
);
