import { Button } from "@kookaburra/chrome";

export const Neutral = () => <Button>Cancel</Button>;

export const Primary = () => <Button primary>Export</Button>;

export const Small = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Button small>✎ Edit scene</Button>
    <Button small primary>
      ＋ New scene
    </Button>
  </div>
);

export const Disabled = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Button disabled>Verify ×2</Button>
    <Button primary disabled>
      Exporting… 42%
    </Button>
  </div>
);
