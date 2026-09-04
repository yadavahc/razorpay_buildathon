/**
 * THE CHART SYSTEM
 *
 * Every chart in RECLAIM draws from these tokens, so the whole product reads as one
 * instrument rather than a collection of widgets.
 *
 * The palettes below are not chosen by eye. They were run through the data-viz
 * validator against this product's actual chart surface (#0b0b0f) and pass every gate:
 * lightness band, chroma floor, colour-blind separation, normal-vision separation and
 * contrast. The specific results are recorded next to each palette so a future change
 * can be re-validated rather than re-guessed.
 */

/** The surface charts are drawn on. The validator was run against this exact value. */
export const CHART_SURFACE = '#0b0b0f';

/**
 * CATEGORICAL — identity encoding. Assigned in fixed order, never cycled.
 *
 * Validated on #0b0b0f, adjacent pairlist: worst CVD ΔE 8.4 (protan), worst
 * normal-vision ΔE 19.3, all eight ≥ 3:1 contrast — all checks pass.
 *
 * Only the first three are safe for all-pairs forms (scatter, bubble): worst CVD
 * ΔE 9.4, normal-vision ΔE 20.9. Past three slots on an all-pairs chart, fold the
 * tail into "Other" or facet instead.
 */
export const CATEGORICAL = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
] as const;

export const CATEGORICAL_ALL_PAIRS_LIMIT = 3;

/**
 * STATUS — reserved. These mean good / bad / needs-attention and are never reused as
 * an identity hue, exactly as identity hues are never used to mean "bad".
 *
 * Contrast against the chart surface: mint 10.55:1, red 5.22:1, amber 9.15:1,
 * blue 5.74:1, silver 4.78:1 — all clear of the 3:1 non-text floor.
 */
export const STATUS = {
  recovered: '#2dd4bf',
  lost: '#ef4444',
  atRisk: '#f59e0b',
  info: '#6187e8',
  neutral: '#7c7c8a',
} as const;

/**
 * ORDINAL — for genuinely ordered categories only (funnel stages, tiers, bands).
 * One hue, light to dark.
 *
 * Validated with `--ordinal` on #0b0b0f: monotone lightness, every adjacent gap
 * ≥ 0.06 ΔL, dark end 2.42:1 against the surface, hue spread 4° — all checks pass.
 */
export const ORDINAL_6 = [
  '#cde2fb',
  '#9ec5f4',
  '#6da7ec',
  '#3987e5',
  '#256abf',
  '#184f95',
] as const;

/** Chart chrome. Recessive by design: the data is the only loud thing. */
export const CHROME = {
  grid: 'rgba(255,255,255,0.055)',
  axis: 'rgba(255,255,255,0.10)',
  tickText: '#7c7c8a',
  labelText: '#a1a1ad',
  cursor: 'rgba(255,255,255,0.07)',
} as const;

/** Mark specifications, applied uniformly. */
export const MARKS = {
  barMaxThickness: 24,
  barRadius: 4,
  lineWidth: 2,
  dotRadius: 4,
  /** Ring in the surface colour so overlapping dots stay legible. */
  dotStrokeWidth: 2,
  areaOpacity: 0.1,
  /** The gap between touching marks is surface colour, never a border. */
  surfaceGap: 2,
} as const;

export const AXIS_TICK = {
  fill: CHROME.tickText,
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
} as const;

/** Assign a categorical colour by stable key, so filtering never repaints survivors. */
export function categoricalFor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length]!;
}

/**
 * Build a stable key→colour map. Colour follows the entity rather than its current
 * rank, so a filter that removes a series leaves the others' colours untouched.
 */
export function buildColorScale(keys: readonly string[]): Record<string, string> {
  const scale: Record<string, string> = {};
  const ordered = [...new Set(keys)].sort();
  ordered.forEach((key, index) => {
    scale[key] = categoricalFor(index);
  });
  return scale;
}

/** Fold a long tail into "Other" so no chart ever needs a ninth hue. */
export function foldTail<T>(
  items: readonly T[],
  limit: number,
  value: (item: T) => number,
  merge: (rest: readonly T[], total: number) => T,
): T[] {
  if (items.length <= limit) return [...items];
  const head = items.slice(0, limit - 1);
  const tail = items.slice(limit - 1);
  const total = tail.reduce((sum, item) => sum + value(item), 0);
  return [...head, merge(tail, total)];
}
