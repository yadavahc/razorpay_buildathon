/**
 * THE RECOVERY TIMING ENGINE
 *
 * The rest of the system decides WHAT to do about a failed payment. This decides WHEN.
 *
 * That question is usually answered with a constant — "retry after 24 hours" — which
 * quietly assumes every failure decays the same way. It does not. A wrong CVV is wrong
 * forever and no delay improves it. A bank outage is fixed in an hour. And a decline for
 * insufficient funds is not a fact about the customer at all: it is a fact about their
 * balance on one particular day, which changes on payday.
 *
 * So this module estimates recovery rate as a function of two timing variables —
 * hours-since-failure, and the day of the month a retry would land on — conditioned on
 * the failure reason, and then picks the moment with the best estimated rate.
 *
 * HOW IT AVOIDS FOOLING ITSELF
 *
 * Slicing outcomes two ways at once shatters the sample: with sixteen failure reasons,
 * six delay buckets and six day buckets there are hundreds of cells, most nearly empty,
 * and the maximum over a field of noisy cells is almost always noise. Three defences:
 *
 *   1. A cell needs MIN_CELL_SAMPLE observations before it is allowed to carry a rate.
 *   2. Cell rates are shrunk toward the reason's overall rate in proportion to how thin
 *      they are (empirical-Bayes style), so a 21-observation cell showing 100% is pulled
 *      most of the way back to the mean rather than being believed.
 *   3. A recommendation is only issued when the best cell beats the reason's baseline by
 *      more than MIN_MEANINGFUL_LIFT. Otherwise the honest answer is "timing does not
 *      matter for this failure", which is the correct answer for most technical declines.
 *
 * Everything here is measured from realised outcomes. Nothing is asserted about payment
 * behaviour that the data did not show.
 */

import type { RecoveryOutcome } from '../types/decisions.js';
import type { FailureReason, RecoveryStrategy } from '../types/enums.js';

/** Observations required before a cell may carry its own rate. */
export const MIN_CELL_SAMPLE = 20;
/** Shrinkage strength: the pseudo-count of prior observations pulling toward the mean. */
export const SHRINKAGE_STRENGTH = 40;
/** A timing edge smaller than this is not worth changing behaviour over. */
export const MIN_MEANINGFUL_LIFT = 0.03;
/**
 * Chi-square critical value at p<0.01 with 5 degrees of freedom (six day buckets).
 * Hard-coded because pulling in a stats library for one constant is not worth a dependency.
 */
export const CHI_SQUARE_P01_DF5 = 15.086;
/**
 * Z required of the best cell before its lift is called real.
 *
 * 3.3 is roughly p<0.001 two-tailed. Deliberately far stricter than a bare p<0.05: the
 * winning cell was selected by being the maximum of ~36 correlated comparisons, and the
 * distribution of a maximum is not the distribution of a single draw.
 */
export const WINNER_Z_THRESHOLD = 3.3;

/** Hours-since-failure buckets. Bounds are inclusive-exclusive on the lower edge. */
export const DELAY_BUCKETS: ReadonlyArray<{ label: string; maxHours: number }> = [
  { label: '0-6h', maxHours: 6 },
  { label: '6-24h', maxHours: 24 },
  { label: '1-2d', maxHours: 48 },
  { label: '2-4d', maxHours: 96 },
  { label: '4-7d', maxHours: 168 },
  { label: '7d+', maxHours: Number.POSITIVE_INFINITY },
];

/**
 * Day-of-month buckets.
 *
 * Chosen to straddle the pay cycle rather than to split the month evenly: the interesting
 * boundary is payday, so the first bucket is deliberately narrow.
 */
export const DAY_BUCKETS: ReadonlyArray<{ label: string; from: number; to: number }> = [
  { label: '1-4', from: 1, to: 4 },
  { label: '5-9', from: 5, to: 9 },
  { label: '10-15', from: 10, to: 15 },
  { label: '16-21', from: 16, to: 21 },
  { label: '22-26', from: 22, to: 26 },
  { label: '27-31', from: 27, to: 31 },
];

export interface TimingCell {
  delayBucket: string;
  dayBucket: string;
  observations: number;
  /** Raw rate in this cell. Reported for transparency; not what the recommendation uses. */
  rawRate: number | null;
  /** Rate after shrinkage toward the reason's mean. Null below MIN_CELL_SAMPLE. */
  shrunkRate: number | null;
}

export interface TimingProfile {
  failureReason: FailureReason;
  observations: number;
  /** The reason's overall realised recovery rate, and the thing lift is measured against. */
  baselineRate: number;
  cells: TimingCell[];
  /** Marginal effect of delay alone, useful when the day axis is too thin to read. */
  byDelay: Array<{ bucket: string; observations: number; rate: number | null }>;
  /** Marginal effect of day-of-month alone. */
  byDay: Array<{ bucket: string; observations: number; rate: number | null }>;
  best: {
    delayBucket: string;
    dayBucket: string;
    rate: number;
    liftOverBaseline: number;
    observations: number;
  } | null;
  /**
   * Null when no cell clears the evidence bar. That is a finding, not a gap: for most
   * technical declines timing genuinely does not move the outcome.
   */
  recommendation: string | null;
  /**
   * True when the day-of-month axis carries a meaningful effect in its own right.
   *
   * Deliberately NOT "the day axis beats the delay axis". Both effects are real and they
   * are independent: decay makes every failure worse with time, while the pay cycle moves
   * only liquidity-bound ones. Delay is usually the larger of the two, and asking which
   * wins would report the cycle as absent everywhere it actually exists.
   */
  cyclical: boolean;
  /** Spread of the marginals, so the UI can say which axis dominates without guessing. */
  delaySpread: number;
  daySpread: number;
  /** Chi-square statistic for the day axis. Above ~15.1 is significant at p<0.01, df=5. */
  dayChiSquare: number;
}

export interface TimingReport {
  profiles: TimingProfile[];
  totalOutcomes: number;
  /** Reasons excluded for having too few outcomes to say anything about. */
  skipped: Array<{ failureReason: FailureReason; observations: number }>;
  generatedAt: string;
}

export interface TimingEngineInput {
  outcomes: readonly RecoveryOutcome[];
  /**
   * Resolves an outcome to the timing coordinates of the attempt that produced it. Passed
   * in because the outcome record alone does not carry them, and the caller knows how to
   * join to the case and the action.
   */
  coordinatesFor: (
    outcome: RecoveryOutcome,
  ) => { failureReason: FailureReason; hoursSinceFailure: number; dayOfMonth: number } | null;
  nowIso: string;
}

export function buildTimingReport(input: TimingEngineInput): TimingReport {
  type Obs = { recovered: boolean; delay: string; day: string };
  const byReason = new Map<FailureReason, Obs[]>();

  for (const outcome of input.outcomes) {
    const coords = input.coordinatesFor(outcome);
    if (!coords) continue;
    const list = byReason.get(coords.failureReason) ?? [];
    list.push({
      recovered: outcome.recoveredAmountMinor > 0,
      delay: delayBucketFor(coords.hoursSinceFailure),
      day: dayBucketFor(coords.dayOfMonth),
    });
    byReason.set(coords.failureReason, list);
  }

  const profiles: TimingProfile[] = [];
  const skipped: TimingReport['skipped'] = [];

  for (const [failureReason, observations] of byReason) {
    // A reason needs enough total observations to support a grid at all, not just a cell.
    if (observations.length < MIN_CELL_SAMPLE * 3) {
      skipped.push({ failureReason, observations: observations.length });
      continue;
    }

    const baselineRate = mean(observations.map((o) => (o.recovered ? 1 : 0)));

    const cells: TimingCell[] = [];
    for (const delay of DELAY_BUCKETS) {
      for (const day of DAY_BUCKETS) {
        const inCell = observations.filter((o) => o.delay === delay.label && o.day === day.label);
        const n = inCell.length;
        const rawRate = n > 0 ? mean(inCell.map((o) => (o.recovered ? 1 : 0))) : null;
        cells.push({
          delayBucket: delay.label,
          dayBucket: day.label,
          observations: n,
          rawRate,
          // Shrink toward the reason's mean. With n = SHRINKAGE_STRENGTH the cell gets
          // half its own weight; far below that it is mostly the prior, which is exactly
          // the scepticism a thin cell deserves.
          shrunkRate:
            n >= MIN_CELL_SAMPLE && rawRate !== null
              ? (rawRate * n + baselineRate * SHRINKAGE_STRENGTH) / (n + SHRINKAGE_STRENGTH)
              : null,
        });
      }
    }

    const byDelay = DELAY_BUCKETS.map((bucket) => {
      const inBucket = observations.filter((o) => o.delay === bucket.label);
      return {
        bucket: bucket.label,
        observations: inBucket.length,
        rate:
          inBucket.length >= MIN_CELL_SAMPLE
            ? mean(inBucket.map((o) => (o.recovered ? 1 : 0)))
            : null,
      };
    });

    const byDay = DAY_BUCKETS.map((bucket) => {
      const inBucket = observations.filter((o) => o.day === bucket.label);
      return {
        bucket: bucket.label,
        observations: inBucket.length,
        rate:
          inBucket.length >= MIN_CELL_SAMPLE
            ? mean(inBucket.map((o) => (o.recovered ? 1 : 0)))
            : null,
      };
    });

    const scored = cells.filter(
      (cell): cell is TimingCell & { shrunkRate: number } => cell.shrunkRate !== null,
    );
    const top = scored.length > 0 ? scored.reduce((a, b) => (b.shrunkRate > a.shrunkRate ? b : a)) : null;

    const lift = top ? top.shrunkRate - baselineRate : 0;

    // Magnitude alone is not evidence. The best of ~36 cells beats the baseline by a few
    // points almost every time by chance, so requiring only MIN_MEANINGFUL_LIFT reports a
    // timing edge on every failure reason in the book -- including the ones where waiting
    // provably cannot help. Test the winning cell against the rest of its own population
    // with a two-proportion z-test, and set the bar high enough to survive having taken a
    // maximum over the whole grid.
    const winnerZ = top ? twoProportionZ(top, baselineRate, observations.length) : 0;
    const meaningful = top !== null && lift >= MIN_MEANINGFUL_LIFT && winnerZ >= WINNER_Z_THRESHOLD;

    // Which axis actually carries the signal? Spread across the marginals answers it, and
    // it is what distinguishes "retry sooner" from "retry after payday".
    const delaySpread = spread(byDelay.map((b) => b.rate));
    const daySpread = spread(byDay.map((b) => b.rate));
    // Whether the day axis carries real signal is a hypothesis test, not a threshold on a
    // spread. Max-minus-min over six buckets is a badly behaved statistic: with a few
    // hundred observations it drifts past any fixed cutoff on noise alone, which reports a
    // pay cycle on technical declines that cannot have one. A chi-square test against the
    // reason's own baseline asks the right question -- is this variation larger than chance
    // would produce -- and its threshold is a p-value rather than a guess.
    const dayChiSquare = chiSquareAgainstBaseline(byDay, baselineRate);
    const cyclical = dayChiSquare >= CHI_SQUARE_P01_DF5 && daySpread >= MIN_MEANINGFUL_LIFT * 2;

    profiles.push({
      failureReason,
      observations: observations.length,
      baselineRate,
      cells,
      byDelay,
      byDay,
      best: top
        ? {
            delayBucket: top.delayBucket,
            dayBucket: top.dayBucket,
            rate: top.shrunkRate,
            liftOverBaseline: lift,
            observations: top.observations,
          }
        : null,
      recommendation: meaningful && top ? phrase(top, lift, cyclical, byDay) : null,
      cyclical,
      delaySpread,
      daySpread,
      dayChiSquare,
    });
  }

  profiles.sort((a, b) => (b.best?.liftOverBaseline ?? 0) - (a.best?.liftOverBaseline ?? 0));

  return {
    profiles,
    totalOutcomes: input.outcomes.length,
    skipped,
    generatedAt: input.nowIso,
  };
}

function phrase(
  cell: { delayBucket: string; dayBucket: string; observations: number },
  lift: number,
  cyclical: boolean,
  byDay: ReadonlyArray<{ bucket: string; rate: number | null }>,
): string {
  const gain = `${(lift * 100).toFixed(1)} points above this failure's average`;
  const base = `Retry ${cell.delayBucket} after the failure — ${gain} (n=${cell.observations}).`;
  if (!cyclical) return base;

  const rated = byDay.filter((b): b is { bucket: string; rate: number } => b.rate !== null);
  if (rated.length < 2) return base;
  const best = rated.reduce((a, b) => (b.rate > a.rate ? b : a));
  const worst = rated.reduce((a, b) => (b.rate < a.rate ? b : a));
  const swing = ((best.rate - worst.rate) * 100).toFixed(1);

  return `${base} This failure is also cyclical: day ${best.bucket} of the month recovers ${swing} points better than day ${worst.bucket}, so a retry that would land in the trough is worth deferring past it.`;
}

export function delayBucketFor(hours: number): string {
  const safe = Math.max(0, hours);
  for (const bucket of DELAY_BUCKETS) {
    if (safe < bucket.maxHours) return bucket.label;
  }
  return DELAY_BUCKETS[DELAY_BUCKETS.length - 1]!.label;
}

export function dayBucketFor(dayOfMonth: number): string {
  const day = Math.min(31, Math.max(1, Math.round(dayOfMonth)));
  for (const bucket of DAY_BUCKETS) {
    if (day >= bucket.from && day <= bucket.to) return bucket.label;
  }
  return DAY_BUCKETS[DAY_BUCKETS.length - 1]!.label;
}

/**
 * The delay, in hours, that the evidence supports for this failure — or null when it does
 * not support one. The strategy engine consults this instead of a hard-coded constant.
 */
export function recommendedDelayHours(
  profile: TimingProfile | undefined,
  strategy: RecoveryStrategy,
): number | null {
  if (!profile || !profile.best || profile.recommendation === null) return null;
  if (strategy !== 'delayed_retry') return null;
  const bucket = DELAY_BUCKETS.find((b) => b.label === profile.best!.delayBucket);
  if (!bucket) return null;
  // Aim for the middle of the winning bucket rather than its edge: the estimate describes
  // the bucket, and its edges are where the neighbouring bucket's behaviour begins.
  const lower = DELAY_BUCKETS[DELAY_BUCKETS.indexOf(bucket) - 1]?.maxHours ?? 0;
  if (!Number.isFinite(bucket.maxHours)) return lower + 24;
  return (lower + bucket.maxHours) / 2;
}

/**
 * Chi-square statistic for "recovery rate is independent of bucket".
 *
 * Buckets below the sample floor contribute nothing rather than being folded in with a
 * fabricated rate, and buckets whose expected count is tiny are skipped because the
 * chi-square approximation is unreliable there.
 */
/**
 * Two-proportion z between a cell and the reason's overall rate.
 *
 * Uses the cell's own observation count, so a small cell needs a much larger apparent lift
 * to clear the bar than a large one -- which is exactly the asymmetry the raw lift number
 * hides.
 */
function twoProportionZ(
  cell: { shrunkRate: number; observations: number },
  baselineRate: number,
  totalObservations: number,
): number {
  const n1 = cell.observations;
  const n2 = Math.max(1, totalObservations - n1);
  if (n1 < MIN_CELL_SAMPLE) return 0;
  const pooled = baselineRate;
  if (pooled <= 0 || pooled >= 1) return 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return 0;
  return (cell.shrunkRate - baselineRate) / se;
}

function chiSquareAgainstBaseline(
  buckets: ReadonlyArray<{ observations: number; rate: number | null }>,
  baselineRate: number,
): number {
  if (baselineRate <= 0 || baselineRate >= 1) return 0;
  let statistic = 0;
  for (const bucket of buckets) {
    if (bucket.rate === null || bucket.observations < MIN_CELL_SAMPLE) continue;
    const expectedRecovered = bucket.observations * baselineRate;
    const expectedFailed = bucket.observations * (1 - baselineRate);
    if (expectedRecovered < 5 || expectedFailed < 5) continue;
    const observedRecovered = bucket.rate * bucket.observations;
    const observedFailed = bucket.observations - observedRecovered;
    statistic +=
      (observedRecovered - expectedRecovered) ** 2 / expectedRecovered +
      (observedFailed - expectedFailed) ** 2 / expectedFailed;
  }
  return statistic;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function spread(values: ReadonlyArray<number | null>): number {
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) return 0;
  return Math.max(...present) - Math.min(...present);
}
