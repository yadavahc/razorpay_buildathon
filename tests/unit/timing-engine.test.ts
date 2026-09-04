import { describe, expect, it } from 'vitest';
import {
  MIN_CELL_SAMPLE,
  buildTimingReport,
  dayBucketFor,
  delayBucketFor,
  recommendedDelayHours,
  type FailureReason,
  type RecoveryOutcome,
} from '@reclaim/core';

const NOW = '2026-09-04T00:00:00.000Z';

let seq = 0;
function outcome(recovered: boolean): RecoveryOutcome {
  seq += 1;
  return {
    id: `o_${seq}`,
    merchantId: 'm1',
    caseId: `c_${seq}`,
    actionId: null,
    outcome: recovered ? 'recovered' : 'failed',
    recoveredAmountMinor: recovered ? 100_000 : 0,
    amountAtRiskMinor: 100_000,
    strategy: 'delayed_retry',
    predictedProbability: 0.5,
    timeToOutcomeMs: 0,
    recordedAt: NOW,
  } as RecoveryOutcome;
}

/**
 * Builds a population with a controllable recovery rate at given timing coordinates.
 * `spec` maps "delayHours|dayOfMonth" to [count, rate].
 */
function population(
  failureReason: FailureReason,
  spec: Record<string, [number, number]>,
): { outcomes: RecoveryOutcome[]; coordsFor: Map<string, { hours: number; day: number }> } {
  const outcomes: RecoveryOutcome[] = [];
  const coordsFor = new Map<string, { hours: number; day: number }>();
  for (const [key, [count, rate]] of Object.entries(spec)) {
    const [hours, day] = key.split('|').map(Number) as [number, number];
    for (let i = 0; i < count; i++) {
      const o = outcome(i < Math.round(count * rate));
      outcomes.push(o);
      coordsFor.set(o.id, { hours, day });
    }
  }
  void failureReason;
  return { outcomes, coordsFor };
}

function report(
  failureReason: FailureReason,
  spec: Record<string, [number, number]>,
) {
  const { outcomes, coordsFor } = population(failureReason, spec);
  return buildTimingReport({
    outcomes,
    nowIso: NOW,
    coordinatesFor: (o) => {
      const c = coordsFor.get(o.id);
      if (!c) return null;
      return { failureReason, hoursSinceFailure: c.hours, dayOfMonth: c.day };
    },
  });
}

describe('timing engine — bucketing', () => {
  it('places hours in the right delay bucket', () => {
    expect(delayBucketFor(0)).toBe('0-6h');
    expect(delayBucketFor(5.9)).toBe('0-6h');
    expect(delayBucketFor(6)).toBe('6-24h');
    expect(delayBucketFor(200)).toBe('7d+');
    // Negative time is nonsense; clamp rather than fall off the end of the table.
    expect(delayBucketFor(-5)).toBe('0-6h');
  });

  it('places days in the right day bucket and clamps out-of-range values', () => {
    expect(dayBucketFor(1)).toBe('1-4');
    expect(dayBucketFor(4)).toBe('1-4');
    expect(dayBucketFor(5)).toBe('5-9');
    expect(dayBucketFor(31)).toBe('27-31');
    expect(dayBucketFor(0)).toBe('1-4');
    expect(dayBucketFor(99)).toBe('27-31');
  });
});

describe('timing engine — refuses to read noise as signal', () => {
  it('skips a failure reason with too few outcomes to support a grid', () => {
    const r = report('incorrect_cvv', { '2|10': [10, 0.9] });
    expect(r.profiles).toHaveLength(0);
    expect(r.skipped[0]?.failureReason).toBe('incorrect_cvv');
  });

  it('leaves a thin cell without a rate however extreme it looks', () => {
    const r = report('gateway_error', {
      '2|10': [100, 0.5],
      // Five observations, all recovered. Tempting, and worthless.
      '2|28': [5, 1.0],
    });
    const profile = r.profiles[0]!;
    const thin = profile.cells.find((c) => c.dayBucket === '27-31' && c.delayBucket === '0-6h')!;
    expect(thin.observations).toBe(5);
    expect(thin.rawRate).toBe(1);
    expect(thin.shrunkRate).toBeNull();
  });

  it('shrinks a small cell toward the reason baseline rather than believing it', () => {
    const r = report('do_not_honour', {
      '2|10': [300, 0.4],
      // Exactly at the sample floor, and perfect. Shrinkage must pull it well down.
      '2|28': [MIN_CELL_SAMPLE, 1.0],
    });
    const profile = r.profiles[0]!;
    const cell = profile.cells.find((c) => c.dayBucket === '27-31' && c.delayBucket === '0-6h')!;
    expect(cell.rawRate).toBe(1);
    expect(cell.shrunkRate).not.toBeNull();
    expect(cell.shrunkRate!).toBeLessThan(0.75);
    expect(cell.shrunkRate!).toBeGreaterThan(profile.baselineRate);
  });

  it('reports no recommendation when timing genuinely does not matter', () => {
    // Flat across every coordinate: the honest answer is "nothing to do here".
    const r = report('card_expired', {
      '2|2': [80, 0.5],
      '2|18': [80, 0.5],
      '30|2': [80, 0.5],
      '30|18': [80, 0.5],
    });
    const profile = r.profiles[0]!;
    expect(profile.recommendation).toBeNull();
    expect(profile.cyclical).toBe(false);
  });
});

describe('timing engine — recovers the effects that are there', () => {
  it('finds a delay effect and recommends the better window', () => {
    const r = report('payment_timeout', {
      '2|10': [200, 0.8],
      '100|10': [200, 0.3],
    });
    const profile = r.profiles[0]!;
    expect(profile.best?.delayBucket).toBe('0-6h');
    expect(profile.recommendation).toContain('0-6h');
    expect(profile.delaySpread).toBeGreaterThan(0.3);
  });

  it('detects a day-of-month cycle even when the delay effect is larger', () => {
    // This is the case the first implementation got wrong: delay dominates, but the
    // cycle is plainly present and reporting it as absent would hide the finding.
    const r = report('insufficient_funds', {
      // Strong delay effect...
      '2|2': [200, 0.85],
      '2|28': [200, 0.55],
      '100|2': [200, 0.45],
      '100|28': [200, 0.15],
    });
    const profile = r.profiles[0]!;
    expect(profile.delaySpread).toBeGreaterThan(profile.daySpread);
    // ...and the cycle is still reported, because it is real.
    expect(profile.cyclical).toBe(true);
    expect(profile.recommendation).toContain('cyclical');
    expect(profile.recommendation).toContain('1-4');
  });

  it('does not call a technical failure cyclical on a noisy day axis', () => {
    // Six buckets of a few hundred observations will always show *some* max-minus-min
    // spread. Requiring chi-square significance is what stops that being read as a pay
    // cycle on failures that cannot have one.
    const r = report('bank_downtime', {
      '2|2': [60, 0.70],
      '2|7': [60, 0.64],
      '2|12': [60, 0.66],
      '2|18': [60, 0.64],
      '2|24': [60, 0.73],
      '2|29': [60, 0.67],
    });
    const profile = r.profiles[0]!;
    expect(profile.daySpread).toBeGreaterThan(0.06);
    expect(profile.dayChiSquare).toBeLessThan(15.086);
    expect(profile.cyclical).toBe(false);
  });

  it('does not call a flat day axis cyclical', () => {
    const r = report('gateway_error', {
      '2|2': [120, 0.8],
      '2|28': [120, 0.8],
      '100|2': [120, 0.3],
      '100|28': [120, 0.3],
    });
    const profile = r.profiles[0]!;
    expect(profile.daySpread).toBeLessThan(0.06);
    expect(profile.cyclical).toBe(false);
  });
});

describe('timing engine — the winning cell must be significant, not just largest', () => {
  it('reports no edge when the best cell only wins by chance', () => {
    // A flat population with one small cell that happens to look good. The maximum over a
    // grid does this constantly; without a significance test every failure reason in the
    // product would claim a timing edge.
    const spec: Record<string, [number, number]> = {};
    for (const hours of [2, 12, 30, 60, 120, 200]) {
      for (const day of [2, 7, 12, 18, 24, 29]) {
        spec[`${hours}|${day}`] = [40, 0.5];
      }
    }
    spec['2|2'] = [22, 0.68];
    const r = report('gateway_error', spec);
    const profile = r.profiles[0]!;
    expect(profile.recommendation).toBeNull();
  });

  it('reports an edge when the winning cell is large and clearly better', () => {
    const spec: Record<string, [number, number]> = {};
    for (const hours of [30, 60, 120, 200]) {
      for (const day of [2, 7, 12, 18, 24, 29]) {
        spec[`${hours}|${day}`] = [60, 0.35];
      }
    }
    for (const day of [2, 7, 12, 18, 24, 29]) {
      spec[`2|${day}`] = [120, 0.8];
    }
    const r = report('payment_timeout', spec);
    const profile = r.profiles[0]!;
    expect(profile.recommendation).not.toBeNull();
    expect(profile.best?.delayBucket).toBe('0-6h');
  });
});

describe('timing engine — the delay it hands the strategy engine', () => {
  it('returns the midpoint of the winning bucket, not its edge', () => {
    const r = report('payment_timeout', {
      '12|10': [200, 0.85],
      '100|10': [200, 0.2],
    });
    const profile = r.profiles[0]!;
    expect(profile.best?.delayBucket).toBe('6-24h');
    // Midpoint of 6h..24h.
    expect(recommendedDelayHours(profile, 'delayed_retry')).toBe(15);
  });

  it('offers no delay for strategies that are not a deferred retry', () => {
    const r = report('payment_timeout', {
      '12|10': [200, 0.85],
      '100|10': [200, 0.2],
    });
    const profile = r.profiles[0]!;
    expect(recommendedDelayHours(profile, 'payment_link')).toBeNull();
    expect(recommendedDelayHours(profile, 'immediate_retry')).toBeNull();
  });

  it('offers no delay when there is no recommendation to give', () => {
    const r = report('card_expired', {
      '2|2': [80, 0.5],
      '2|18': [80, 0.5],
      '30|2': [80, 0.5],
      '30|18': [80, 0.5],
    });
    expect(recommendedDelayHours(r.profiles[0], 'delayed_retry')).toBeNull();
    expect(recommendedDelayHours(undefined, 'delayed_retry')).toBeNull();
  });
});
