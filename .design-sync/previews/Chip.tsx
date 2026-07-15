import { Chip, ChipRow } from "@kookaburra/chrome";

export const Choices = () => (
  <ChipRow>
    <Chip>3 s</Chip>
    <Chip selected>5 s</Chip>
    <Chip>8 s</Chip>
    <Chip>12 s</Chip>
  </ChipRow>
);

export const QuickActions = () => (
  <ChipRow>
    <Chip>Add a scene</Chip>
    <Chip>Change the text</Chip>
    <Chip>Swap media</Chip>
    <Chip>Retime the outro</Chip>
  </ChipRow>
);

export const DisabledChip = () => (
  <ChipRow>
    <Chip disabled>Verify (running…)</Chip>
    <Chip>Cancel</Chip>
  </ChipRow>
);
