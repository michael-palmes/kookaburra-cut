import { Button, Select, SettingsRow } from "@kookaburra/chrome";

export const Stack = () => (
  <div style={{ width: 520 }}>
    <SettingsRow title="Workspace" detail="~/Kookaburra Cut">
      <Button small>Change…</Button>
    </SettingsRow>
    <SettingsRow title="Default codec" detail="Used by Verify and quick exports">
      <Select defaultValue="libx264">
        <option value="libx264">H.264 (deterministic)</option>
        <option value="prores_ks">ProRes 422 HQ</option>
      </Select>
    </SettingsRow>
    <SettingsRow title="Reduced motion" detail="Follows the system setting">
      <Button small>Override</Button>
    </SettingsRow>
  </div>
);
