import { Menu, MenuItem } from "@kookaburra/chrome";

export const States = () => (
  <div style={{ position: "relative", height: 150, width: 220 }}>
    <Menu style={{ position: "static" }}>
      <MenuItem>Duplicate scene</MenuItem>
      <MenuItem disabled>Delete scene</MenuItem>
    </Menu>
  </div>
);
