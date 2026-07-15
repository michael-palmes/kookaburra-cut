import { Button, Menu, MenuItem } from "@kookaburra/chrome";

export const RailMenu = () => (
  <div className="rail-more" style={{ margin: "16px 0 0 16px" }}>
    <Button small>⋯</Button>
    <Menu>
      <MenuItem>Duplicate scene</MenuItem>
      <MenuItem>Reveal in Finder</MenuItem>
      <MenuItem>Re-scaffold sidecar</MenuItem>
      <MenuItem disabled>Delete scene</MenuItem>
    </Menu>
  </div>
);
