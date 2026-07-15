import { Button, Field, Modal, Select, TextInput } from "@kookaburra/chrome";

export const NewProject = () => (
  <Modal
    title="New project"
    onClose={() => {}}
    actions={
      <>
        <Button>Cancel</Button>
        <Button primary>Create</Button>
      </>
    }
  >
    <Field label="Name" hint="Lowercase, dashes — becomes the folder name.">
      <TextInput placeholder="spring-launch" />
    </Field>
    <Field label="Aspect">
      <Select defaultValue="16:9">
        <option value="16:9">16:9 · 3840×2160</option>
        <option value="9:16">9:16 · 2160×3840</option>
      </Select>
    </Field>
  </Modal>
);
