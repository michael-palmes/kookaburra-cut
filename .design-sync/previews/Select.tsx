import { Field, Select } from "@kookaburra/chrome";

export const Aspect = () => (
  <Select defaultValue="16:9">
    <option value="16:9">16:9 · 3840×2160</option>
    <option value="9:16">9:16 · 2160×3840</option>
    <option value="1:1">1:1 · 2160×2160</option>
    <option value="4:5">4:5 · 2160×2700</option>
  </Select>
);

export const InAField = () => (
  <div style={{ width: 320 }}>
    <Field label="Codec">
      <Select defaultValue="libx264">
        <option value="libx264">H.264 (deterministic)</option>
        <option value="prores_ks">ProRes 422 HQ</option>
        <option value="libx265">H.265</option>
      </Select>
    </Field>
  </div>
);
