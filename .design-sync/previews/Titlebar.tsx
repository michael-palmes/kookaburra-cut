import { Button, Titlebar } from "@kookaburra/chrome";

export const Editor = () => (
  <Titlebar title="launch-2026" subtitle="~/Kookaburra Cut/launch-2026">
    <Button small>Media</Button>
    <Button small>Theme</Button>
    <Button small primary>
      Export
    </Button>
  </Titlebar>
);

export const Minimal = () => <Titlebar title="Kookaburra Cut" subtitle="No project open" />;
