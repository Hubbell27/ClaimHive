/**
 * Transparent statistics for the denial intelligence engine. No models: rates,
 * 95% confidence ranges and sample sizes, computed with textbook methods.
 *
 *   wilson()      Wilson score interval for a proportion (well-behaved for small n
 *                 and for rates near 0% or 100%, unlike the simple ± formula).
 *   newcombe()    Newcombe's hybrid score interval for the difference of two
 *                 independent proportions (Newcombe 1998, method 10), built from
 *                 the two Wilson intervals.
 */
export const Z95 = 1.959963984540054;

export interface Interval { rate: number; lo: number; hi: number; n: number; k: number }

export function wilson(k: number, n: number, z = Z95): Interval {
  if (n <= 0) return { rate: 0, lo: 0, hi: 1, n: 0, k: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n, k };
}

export interface Difference { diff: number; lo: number; hi: number }

/** 95% interval for (rate of a) − (rate of b). */
export function newcombe(a: Interval, b: Interval): Difference {
  const d = a.rate - b.rate;
  const lo = d - Math.sqrt((a.rate - a.lo) ** 2 + (b.hi - b.rate) ** 2);
  const hi = d + Math.sqrt((a.hi - a.rate) ** 2 + (b.rate - b.lo) ** 2);
  return { diff: d, lo: Math.max(-1, lo), hi: Math.min(1, hi) };
}

/** The owner's "strict" bar for calling a pattern a rule (Phase 4 decision). */
export const RULE_BAR = {
  minProcedures: 30,     // in each group being compared
  minPractices: 5,       // in each group being compared (also the pool-wide display minimum)
  minGapLowerBound: 0.15, // the cautious end of the 95% range for the gap must be ≥ 15 points
  usuallyDeniedLowerBound: 0.5, // "usually denied": the cautious end of the rate itself is ≥ 50%
} as const;

/** Appeal outcomes are shown with fewer cases, but never below the practice minimum. */
export const APPEAL_BAR = { minAppeals: 10, minPractices: 5 } as const;

export function strength(gapLo: number): "strong" | "solid" {
  return gapLo >= 0.35 ? "strong" : "solid";
}
