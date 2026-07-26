// Pure auto-ranging logic for the automation editor's value axis, kept
// free of React/DOM so it can be fuzz tested (yarn test:autorange).
//
// Rules:
// - The view is ALWAYS centered on 0, spanning symmetric power-of-two
//   pairs: -1..1, -2..2, -4..4, -8..8, ... (radius never below 1).
// - The outermost keyframe (the value furthest from 0) dictates the range.
// - While dragging, the range is FROZEN: entering the top or bottom 10%
//   of the view (|value| > 0.8 * radius) changes nothing yet.
// - On release, the range refits in both directions: it becomes the
//   smallest power of two keeping the outermost value out of the 10%
//   edge bands.

export type ViewRange = { center: number; span: number };

export type Extremes = { low: number; high: number };

const DEFAULT_VIEW: ViewRange = { center: 0, span: 2 };

// Smallest power-of-two radius (>= 1) keeping the outermost value out of
// the view's top/bottom 10% bands (|value| <= 0.8 * radius).
export const fitRadius = (extremes: Extremes) => {
  const outermost = Math.max(Math.abs(extremes.low), Math.abs(extremes.high));
  const needed = outermost / 0.8;
  if (!(needed > 1) || !isFinite(needed)) return 1;
  return Math.pow(2, Math.ceil(Math.log2(needed) - 1e-9));
};

export const computeTargetView = (
  extremes: Extremes | null,
  previous: ViewRange | null,
  isDragging = false,
): ViewRange => {
  if (!extremes) return previous ?? DEFAULT_VIEW;
  const previousRadius = previous ? previous.span / 2 : 1;
  // The range is frozen while dragging; it refits (grow or shrink) only
  // once the drag is released.
  const radius = isDragging && previous ? previousRadius : fitRadius(extremes);
  return { center: 0, span: 2 * radius };
};

// One animation step easing the view toward its target. Returns the next
// view and whether it has settled (snapped exactly onto the target).
export const easeView = (
  current: ViewRange,
  target: ViewRange,
  alpha = 0.16,
): { next: ViewRange; settled: boolean } => {
  const closeEnough =
    Math.abs(current.center - target.center) < target.span * 0.002 &&
    Math.abs(current.span - target.span) < target.span * 0.002;
  if (closeEnough) return { next: { ...target }, settled: true };
  return {
    next: {
      center: current.center + (target.center - current.center) * alpha,
      span: current.span + (target.span - current.span) * alpha,
    },
    settled: false,
  };
};

export const extremesOf = (values: number[]): Extremes | null => {
  if (values.length === 0) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return { low, high };
};
