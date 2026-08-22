import { ComparisonSideIcon } from "../ComparisonSideIcon";
import type { CompareSide } from "./compareSideRouting";
import { type SegmentedOption, SegmentedRow } from "./rows";

/** The Before/After choice, shown at the top of the Device, Theme, Background and Lighting surfaces when the scene has a comparison. One shared value per scene drives all four, so the side stays put as you move between them. The split-screen glyph is the same one the wizard uses: Before fills the left half, After the right. */
export const COMPARE_SIDE_OPTIONS: SegmentedOption<CompareSide>[] = [
  {
    value: "a",
    label: "Before",
    icon: <ComparisonSideIcon side="before" />,
    title: "Edit the before side",
  },
  {
    value: "b",
    label: "After",
    icon: <ComparisonSideIcon side="after" />,
    title: "Edit the after side",
  },
];

export function CompareSideSelector({
  value,
  onChange,
}: {
  value: CompareSide;
  onChange: (side: CompareSide) => void;
}) {
  return (
    <SegmentedRow
      ariaLabel="Comparison side"
      className="comparison-side-tabs"
      options={COMPARE_SIDE_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
