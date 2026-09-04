import { describe, expect, it } from 'vitest';
import {
  INTERVENTION_COSTS,
  MAX_STRATEGY_PROBABILITY,
  attemptFatigue,
  delayDecayFactor,
  evaluateAllStrategies,
  expectedValue,
  goodwillCostFor,
  resolveCaseProfile,
  totalInterventionCost,
} from '@reclaim/core';

/**
 * The expected-value engine decides how much money is worth spending to recover other
 * money, so it is asserted to the rupee. Every amount here is an integer number of paise;
 * a floating-point result anywhere in this file is a bug.
 */

const fundingProfile = resolveCaseProfile({
  sourceType: 'payment_failure',
  failureReason: 'insufficient_funds',
});

const deadCardProfile = resolveCaseProfile({
  sourceType: 'payment_failure',
  failureReason: 'card_expired',
});

describe('expected value — arithmetic', () => {
  it('computes gross recovery, cost and net value as exact integers', () => {
    const result = expectedValue({
      strategy: 'immediate_retry',
      amountAtRiskMinor: 1_000_000,
      recoveryProbability: 0.5,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });

    // p = 0.5 × lift 0.28 × decay 1 (no delay) × fatigue 1 = 0.14
    expect(result.successProbability).toBeCloseTo(0.14, 5);
    expect(result.grossRecoveryMinor).toBe(140_000);
    expect(result.directCostMinor).toBe(INTERVENTION_COSTS.immediate_retry.directCostMinor);
    expect(result.goodwillCostMinor).toBe(0);
    expect(result.expectedValueMinor).toBe(140_000 - 250);
    expect(Number.isInteger(result.expectedValueMinor)).toBe(true);
  });

  it('never returns a fractional amount for any strategy', () => {
    const breakdowns = evaluateAllStrategies({
      amountAtRiskMinor: 333_337,
      recoveryProbability: 0.37,
      profile: fundingProfile,
      priorContactCount: 1,
      priorAttemptCount: 1,
    });

    for (const row of breakdowns) {
      expect(Number.isInteger(row.grossRecoveryMinor)).toBe(true);
      expect(Number.isInteger(row.interventionCostMinor)).toBe(true);
      expect(Number.isInteger(row.expectedValueMinor)).toBe(true);
    }
  });

  it('scores stopping at exactly zero, so every other option has a hurdle', () => {
    const stop = expectedValue({
      strategy: 'stop_recovery',
      amountAtRiskMinor: 5_000_000,
      recoveryProbability: 0.9,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });

    expect(stop.successProbability).toBe(0);
    expect(stop.grossRecoveryMinor).toBe(0);
    expect(stop.interventionCostMinor).toBe(0);
    expect(stop.expectedValueMinor).toBe(0);
  });

  it('caps success probability below certainty', () => {
    const result = expectedValue({
      strategy: 'delayed_retry',
      amountAtRiskMinor: 100_000,
      recoveryProbability: 1,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });
    expect(result.successProbability).toBeLessThanOrEqual(MAX_STRATEGY_PROBABILITY);
  });
});

describe('expected value — strategy lift', () => {
  it('prefers a delayed retry over an immediate one for an insufficient-funds decline', () => {
    // The account is empty now and will not be less empty in one second.
    const immediate = expectedValue({
      strategy: 'immediate_retry',
      amountAtRiskMinor: 500_000,
      recoveryProbability: 0.6,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });
    const delayed = expectedValue({
      strategy: 'delayed_retry',
      amountAtRiskMinor: 500_000,
      recoveryProbability: 0.6,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });

    expect(delayed.successProbability).toBeGreaterThan(immediate.successProbability);
    expect(delayed.expectedValueMinor).toBeGreaterThan(immediate.expectedValueMinor);
  });

  it('gives a retry on an expired card almost no chance', () => {
    const retry = expectedValue({
      strategy: 'delayed_retry',
      amountAtRiskMinor: 500_000,
      recoveryProbability: 0.6,
      profile: deadCardProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });
    const link = expectedValue({
      strategy: 'payment_link',
      amountAtRiskMinor: 500_000,
      recoveryProbability: 0.6,
      profile: deadCardProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });

    expect(retry.successProbability).toBeLessThan(0.05);
    expect(link.expectedValueMinor).toBeGreaterThan(retry.expectedValueMinor);
  });
});

describe('expected value — decay and fatigue', () => {
  it('discounts delayed money, with a floor', () => {
    expect(delayDecayFactor(0)).toBe(1);
    expect(delayDecayFactor(24)).toBeLessThan(1);
    expect(delayDecayFactor(72)).toBeLessThan(delayDecayFactor(24));
    // A long wait makes recovery worse, not impossible.
    expect(delayDecayFactor(10_000)).toBeGreaterThanOrEqual(0.82);
  });

  it('reduces the odds of each successive attempt on the same case', () => {
    expect(attemptFatigue(0)).toBe(1);
    expect(attemptFatigue(1)).toBeLessThan(1);
    expect(attemptFatigue(2)).toBeLessThan(attemptFatigue(1));
    expect(attemptFatigue(20)).toBeGreaterThanOrEqual(0.25);
  });

  it('makes a fourth attempt worth materially less than a first', () => {
    const first = expectedValue({
      strategy: 'delayed_retry',
      amountAtRiskMinor: 400_000,
      recoveryProbability: 0.7,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });
    const fourth = expectedValue({
      strategy: 'delayed_retry',
      amountAtRiskMinor: 400_000,
      recoveryProbability: 0.7,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 3,
    });

    expect(fourth.expectedValueMinor).toBeLessThan(first.expectedValueMinor / 2);
  });
});

describe('expected value — goodwill cost', () => {
  it('charges nothing for a silent retry', () => {
    expect(goodwillCostFor('immediate_retry', 0)).toBe(0);
    expect(goodwillCostFor('delayed_retry', 5)).toBe(0);
  });

  it('escalates the cost of each additional message', () => {
    const first = goodwillCostFor('customer_notification', 0);
    const second = goodwillCostFor('customer_notification', 1);
    const third = goodwillCostFor('customer_notification', 2);

    expect(second).toBeGreaterThan(first);
    expect(third - second).toBe(second - first);
  });

  it('eventually makes another message worse than stopping', () => {
    // This is the mechanism that stops the engine from spamming a small balance.
    const amountMinor = 30_000;
    const spamming = expectedValue({
      strategy: 'customer_notification',
      amountAtRiskMinor: amountMinor,
      recoveryProbability: 0.35,
      profile: fundingProfile,
      priorContactCount: 4,
      priorAttemptCount: 2,
    });

    expect(spamming.expectedValueMinor).toBeLessThan(0);
  });

  it('totals direct and goodwill cost consistently', () => {
    for (const strategy of ['payment_link', 'customer_notification', 'escalate'] as const) {
      expect(totalInterventionCost(strategy, 2)).toBe(
        INTERVENTION_COSTS[strategy].directCostMinor + goodwillCostFor(strategy, 2),
      );
    }
  });
});

describe('expected value — escalation economics', () => {
  it('does not escalate a routine case automation already handles well', () => {
    // A human facing an insufficient-funds decline does exactly what automation does:
    // waits and retries. Paying twelve minutes of analyst time for that is value
    // destruction, and an earlier multiplicative model of the human lift got this wrong.
    const options = evaluateAllStrategies({
      amountAtRiskMinor: 350_000,
      recoveryProbability: 0.95,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });

    expect(options[0]!.strategy).not.toBe('escalate');
    const escalate = options.find((o) => o.strategy === 'escalate')!;
    const delayed = options.find((o) => o.strategy === 'delayed_retry')!;
    expect(delayed.expectedValueMinor).toBeGreaterThan(escalate.expectedValueMinor);
  });

  it('adds human value on the residual, so it helps most where automation is weak', () => {
    const strong = evaluateAllStrategies({
      amountAtRiskMinor: 1_000_000,
      recoveryProbability: 0.9,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });
    const weak = evaluateAllStrategies({
      amountAtRiskMinor: 1_000_000,
      recoveryProbability: 0.15,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });

    const gainWhenStrong =
      strong.find((o) => o.strategy === 'escalate')!.successProbability -
      strong.find((o) => o.strategy === 'delayed_retry')!.successProbability;
    const gainWhenWeak =
      weak.find((o) => o.strategy === 'escalate')!.successProbability -
      weak.find((o) => o.strategy === 'delayed_retry')!.successProbability;

    // The worse automation is doing, the more a human is worth.
    expect(gainWhenWeak).toBeGreaterThan(gainWhenStrong);
  });

  it('is worth escalating a large balance', () => {
    const options = evaluateAllStrategies({
      amountAtRiskMinor: 8_000_000,
      recoveryProbability: 0.25,
      profile: deadCardProfile,
      priorContactCount: 3,
      priorAttemptCount: 2,
    });
    const escalate = options.find((o) => o.strategy === 'escalate')!;
    expect(escalate.expectedValueMinor).toBeGreaterThan(0);
  });

  it('is not worth escalating a trivial balance', () => {
    // Twelve minutes of analyst time costs more than the money at stake.
    const options = evaluateAllStrategies({
      amountAtRiskMinor: 15_000,
      recoveryProbability: 0.5,
      profile: fundingProfile,
      priorContactCount: 0,
      priorAttemptCount: 0,
    });
    const escalate = options.find((o) => o.strategy === 'escalate')!;
    const stop = options.find((o) => o.strategy === 'stop_recovery')!;

    expect(escalate.expectedValueMinor).toBeLessThan(stop.expectedValueMinor);
  });
});

describe('expected value — ordering', () => {
  it('returns options sorted by expected value, best first', () => {
    const options = evaluateAllStrategies({
      amountAtRiskMinor: 750_000,
      recoveryProbability: 0.48,
      profile: fundingProfile,
      priorContactCount: 1,
      priorAttemptCount: 0,
    });

    for (let i = 1; i < options.length; i++) {
      expect(options[i - 1]!.expectedValueMinor).toBeGreaterThanOrEqual(
        options[i]!.expectedValueMinor,
      );
    }
  });

  it('is fully deterministic — the same input always prices identically', () => {
    const input = {
      amountAtRiskMinor: 1_234_567,
      recoveryProbability: 0.4321,
      profile: fundingProfile,
      priorContactCount: 2,
      priorAttemptCount: 1,
    };
    expect(evaluateAllStrategies(input)).toEqual(evaluateAllStrategies(input));
  });
});
