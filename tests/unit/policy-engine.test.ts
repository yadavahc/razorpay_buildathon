import { describe, expect, it } from 'vitest';
import {
  POLICY_REASON_CODES,
  type PolicyEvaluationInput,
  defaultConfig,
  evaluatePolicy,
  suggestAlternative,
} from '@reclaim/core';

/**
 * The policy engine is the layer that decides whether money is allowed to move, so it is
 * tested as a pure function against explicit inputs rather than through the pipeline.
 * Every guardrail gets a case that trips it and a case that does not.
 */

const config = defaultConfig().policy;

function baseInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  const now = '2026-09-01T12:00:00.000Z';
  return {
    merchantId: 'merch_test',
    strategy: 'delayed_retry',
    amountMinor: 200_000,
    expectedValueMinor: 90_000,
    recoveryProbability: 0.62,
    case: {
      id: 'case_1',
      status: 'awaiting_action',
      sourceType: 'payment_failure',
      failureReason: 'insufficient_funds',
      attemptCount: 0,
      notificationCount: 0,
      cooldownUntil: null,
      lastActionAt: null,
      detectedAt: '2026-08-31T12:00:00.000Z',
      spentMinor: 0,
    },
    customer: {
      id: 'cust_1',
      contactOptOut: false,
      doNotRetry: false,
      chargebackCount: 0,
      timezone: 'UTC',
      hasContactChannel: true,
    },
    mandateActive: true,
    contactsInLast24h: 0,
    idempotencyHit: false,
    aiDecisionId: null,
    nowIso: now,
    config,
    ...overrides,
  };
}

describe('policy engine — verdicts', () => {
  it('allows a well-formed retry that clears every guardrail', () => {
    const decision = evaluatePolicy(baseInput());
    expect(decision.verdict).toBe('allow');
    expect(decision.reasonCodes).toEqual([]);
    expect(decision.suggestedAlternative).toBeNull();
  });

  it('evaluates every check even after one has already failed', () => {
    // A partial evaluation would show a merchant only the first problem, and the audit
    // record needs all of them.
    const decision = evaluatePolicy(
      baseInput({
        case: { ...baseInput().case, attemptCount: 99 },
        customer: { ...baseInput().customer, doNotRetry: true },
      }),
    );

    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED);
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.CUSTOMER_DO_NOT_RETRY);
    // Every guardrail produced a result, not just the failing ones.
    expect(decision.checks.length).toBeGreaterThanOrEqual(12);
  });

  it('records a policy version on every decision', () => {
    expect(evaluatePolicy(baseInput()).policyVersion).toBe(config.version);
  });
});

describe('policy engine — retry limits and cooldown', () => {
  it('denies a retry once the attempt budget is exhausted', () => {
    const decision = evaluatePolicy(
      baseInput({ case: { ...baseInput().case, attemptCount: config.maxRetries } }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED);
  });

  it('allows a retry while attempts remain', () => {
    const decision = evaluatePolicy(
      baseInput({ case: { ...baseInput().case, attemptCount: config.maxRetries - 1 } }),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('denies an action inside the cooldown window', () => {
    const decision = evaluatePolicy(
      baseInput({
        case: { ...baseInput().case, lastActionAt: '2026-09-01T10:00:00.000Z' },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.COOLDOWN_ACTIVE);
  });

  it('allows an action once the cooldown has elapsed', () => {
    const decision = evaluatePolicy(
      baseInput({
        case: { ...baseInput().case, lastActionAt: '2026-09-01T02:00:00.000Z' },
      }),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('honours an explicit cooldown timestamp on the case', () => {
    const decision = evaluatePolicy(
      baseInput({
        case: { ...baseInput().case, cooldownUntil: '2026-09-01T18:00:00.000Z' },
      }),
    );
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.COOLDOWN_ACTIVE);
  });

  it('does not apply cooldown to stopping or escalating', () => {
    for (const strategy of ['stop_recovery', 'escalate'] as const) {
      const decision = evaluatePolicy(
        baseInput({ strategy, case: { ...baseInput().case, lastActionAt: '2026-09-01T11:59:00.000Z' } }),
      );
      expect(decision.reasonCodes).not.toContain(POLICY_REASON_CODES.COOLDOWN_ACTIVE);
    }
  });
});

describe('policy engine — structural gates', () => {
  it('refuses to retry an expired card at any expected value', () => {
    const decision = evaluatePolicy(
      baseInput({
        expectedValueMinor: 10_000_000,
        case: { ...baseInput().case, failureReason: 'card_expired' },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE);
  });

  it('refuses to retry against a revoked mandate', () => {
    const decision = evaluatePolicy(baseInput({ mandateActive: false }));
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.MANDATE_INACTIVE);
  });

  it('permits a payment link where a retry is structurally impossible', () => {
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'payment_link',
        case: { ...baseInput().case, failureReason: 'card_expired' },
      }),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('refuses to retry an abandoned checkout, which has no authorisation to re-present', () => {
    const decision = evaluatePolicy(
      baseInput({
        case: { ...baseInput().case, sourceType: 'checkout_abandonment', failureReason: null },
      }),
    );
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE);
  });
});

describe('policy engine — customer consent is a hard gate', () => {
  it('never messages a customer who opted out, whatever the expected value', () => {
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'customer_notification',
        expectedValueMinor: 50_000_000,
        customer: { ...baseInput().customer, contactOptOut: true },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.CUSTOMER_OPTED_OUT);
  });

  it('still permits a silent retry for an opted-out customer', () => {
    // Opting out of contact is not opting out of being charged for what they bought.
    const decision = evaluatePolicy(
      baseInput({ customer: { ...baseInput().customer, contactOptOut: true } }),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('blocks money movement for a customer over the chargeback tolerance', () => {
    const decision = evaluatePolicy(
      baseInput({
        customer: { ...baseInput().customer, chargebackCount: config.maxChargebacks + 1 },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.CHARGEBACK_RISK);
  });

  it('blocks a message when no deliverable channel exists', () => {
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'customer_notification',
        customer: { ...baseInput().customer, hasContactChannel: false },
      }),
    );
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.NO_CONTACT_CHANNEL);
  });
});

describe('policy engine — quiet hours', () => {
  it('blocks an outbound message during the customer local night', () => {
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'customer_notification',
        nowIso: '2026-09-01T23:30:00.000Z',
        customer: { ...baseInput().customer, timezone: 'UTC' },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.QUIET_HOURS);
  });

  it('evaluates quiet hours in the customer timezone, not the merchant one', () => {
    // 23:30 UTC is 05:00 next day in Kolkata — still inside quiet hours there.
    const kolkata = evaluatePolicy(
      baseInput({
        strategy: 'customer_notification',
        nowIso: '2026-09-01T23:30:00.000Z',
        customer: { ...baseInput().customer, timezone: 'Asia/Kolkata' },
      }),
    );
    expect(kolkata.reasonCodes).toContain(POLICY_REASON_CODES.QUIET_HOURS);

    // 06:00 UTC is 11:30 in Kolkata — well inside the day.
    const daytime = evaluatePolicy(
      baseInput({
        strategy: 'customer_notification',
        nowIso: '2026-09-01T06:00:00.000Z',
        customer: { ...baseInput().customer, timezone: 'Asia/Kolkata' },
      }),
    );
    expect(daytime.reasonCodes).not.toContain(POLICY_REASON_CODES.QUIET_HOURS);
  });

  it('does not apply quiet hours to a silent retry', () => {
    const decision = evaluatePolicy(baseInput({ nowIso: '2026-09-01T23:30:00.000Z' }));
    expect(decision.reasonCodes).not.toContain(POLICY_REASON_CODES.QUIET_HOURS);
  });
});

describe('policy engine — economics', () => {
  it('denies an action below the expected-value floor', () => {
    const decision = evaluatePolicy(
      baseInput({ expectedValueMinor: config.minExpectedValueMinor - 1 }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW);
    expect(decision.suggestedAlternative).toBe('stop_recovery');
  });

  it('never applies the value floor to stopping', () => {
    const decision = evaluatePolicy(
      baseInput({ strategy: 'stop_recovery', expectedValueMinor: 0 }),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('denies an action that would exceed the per-case budget', () => {
    const decision = evaluatePolicy(
      baseInput({ case: { ...baseInput().case, spentMinor: config.caseBudgetMinor } }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.CASE_BUDGET_EXHAUSTED);
  });

  it('caps outbound messages per customer per rolling day', () => {
    const decision = evaluatePolicy(
      baseInput({ strategy: 'customer_notification', contactsInLast24h: config.dailyContactCap }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.CONTACT_CAP_EXCEEDED);
  });
});

describe('policy engine — human escalation', () => {
  it('routes an amount above the automated ceiling to a human rather than denying it', () => {
    const decision = evaluatePolicy(
      baseInput({ amountMinor: config.autoExecuteCeilingMinor + 1 }),
    );
    expect(decision.verdict).toBe('require_human');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.ABOVE_AUTO_EXECUTE_CEILING);
    expect(decision.suggestedAlternative).toBe('escalate');
  });

  it('escalates a material amount the model is not confident about', () => {
    const decision = evaluatePolicy(
      baseInput({
        amountMinor: config.autoExecuteCeilingMinor / 2 + 1,
        recoveryProbability: 0.2,
      }),
    );
    expect(decision.verdict).toBe('require_human');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.HIGH_VALUE_LOW_CONFIDENCE);
  });

  it('a denial always outranks an escalation', () => {
    // Both a hard failure and a human-review flag are present; deny must win.
    const decision = evaluatePolicy(
      baseInput({
        amountMinor: config.autoExecuteCeilingMinor + 1,
        customer: { ...baseInput().customer, doNotRetry: true },
      }),
    );
    expect(decision.verdict).toBe('deny');
  });
});

describe('policy engine — duplicate prevention and terminal cases', () => {
  it('denies an action whose idempotency key has already been used', () => {
    const decision = evaluatePolicy(baseInput({ idempotencyHit: true }));
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.DUPLICATE_ACTION);
    expect(decision.suggestedAlternative).toBe('stop_recovery');
  });

  it('refuses to act on a case that has already been resolved', () => {
    for (const status of ['recovered', 'stopped', 'unrecoverable'] as const) {
      const decision = evaluatePolicy(baseInput({ case: { ...baseInput().case, status } }));
      expect(decision.verdict).toBe('deny');
      expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.CASE_TERMINAL);
    }
  });
});

describe('policy engine — systemic incidents', () => {
  it('holds a retry into an issuer with an active incident', () => {
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'delayed_retry',
        suppressedDimensions: { issuers: ['HDFC Bank'], methods: [], failureReasons: [] },
        instrument: { issuer: 'HDFC Bank', method: 'card' },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reasonCodes).toContain(POLICY_REASON_CODES.SYSTEMIC_INCIDENT_ACTIVE);
  });

  it('still permits a payment link while the issuer is down', () => {
    // The bank's authorisation endpoint is down; a link the customer opens later is not.
    // Suppressing every strategy would turn an issuer outage into a total recovery outage.
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'payment_link',
        suppressedDimensions: { issuers: ['HDFC Bank'], methods: [], failureReasons: [] },
        instrument: { issuer: 'HDFC Bank', method: 'card' },
      }),
    );
    expect(decision.reasonCodes).not.toContain(POLICY_REASON_CODES.SYSTEMIC_INCIDENT_ACTIVE);
  });

  it("permits retries on an unaffected issuer during another issuer's outage", () => {
    const decision = evaluatePolicy(
      baseInput({
        strategy: 'delayed_retry',
        suppressedDimensions: { issuers: ['HDFC Bank'], methods: [], failureReasons: [] },
        instrument: { issuer: 'Axis Bank', method: 'card' },
      }),
    );
    expect(decision.reasonCodes).not.toContain(POLICY_REASON_CODES.SYSTEMIC_INCIDENT_ACTIVE);
  });

  it('permits everything when no incident data was supplied at all', () => {
    // A detector that never ran must not be able to halt recovery across the portfolio.
    const decision = evaluatePolicy(baseInput({ strategy: 'delayed_retry' }));
    expect(decision.reasonCodes).not.toContain(POLICY_REASON_CODES.SYSTEMIC_INCIDENT_ACTIVE);
    const check = decision.checks.find((c) => c.id === 'systemic_incident');
    expect(check?.result).toBe('pass');
  });
});

describe('policy engine — suggested alternatives', () => {
  it('turns an impossible retry into a payment link', () => {
    expect(
      suggestAlternative('delayed_retry', [POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE], 'deny'),
    ).toBe('payment_link');
  });

  it('turns an immediate retry blocked by cooldown into a delayed one', () => {
    expect(
      suggestAlternative('immediate_retry', [POLICY_REASON_CODES.COOLDOWN_ACTIVE], 'deny'),
    ).toBe('delayed_retry');
  });

  it('routes a contact strategy blocked by quiet hours to a silent retry', () => {
    // Quiet hours only ever blocks customer-facing contact, so a silent retry escapes the
    // check and can still move the money. Returning the blocked strategy instead reads to
    // the executor as "no alternative", which abandons positive expected value overnight.
    for (const blocked of ['payment_link', 'customer_notification'] as const) {
      const alternative = suggestAlternative(blocked, [POLICY_REASON_CODES.QUIET_HOURS], 'deny');
      expect(alternative).toBe('delayed_retry');
      expect(alternative).not.toBe(blocked);
    }
  });

  it('never proposes the strategy it was just denied', () => {
    // The executor's already-attempted guard turns a self-suggestion into a dead end, so a
    // fallback that equals its input silently costs a recovery. Sweep the whole matrix.
    const strategies = [
      'immediate_retry',
      'delayed_retry',
      'payment_link',
      'customer_notification',
      'escalate',
      'stop_recovery',
    ] as const;
    for (const strategy of strategies) {
      for (const code of Object.values(POLICY_REASON_CODES)) {
        for (const verdict of ['deny', 'require_human'] as const) {
          expect(suggestAlternative(strategy, [code], verdict)).not.toBe(strategy);
        }
      }
    }
  });

  it('offers no alternative when the customer has opted out', () => {
    expect(
      suggestAlternative('customer_notification', [POLICY_REASON_CODES.CUSTOMER_OPTED_OUT], 'deny'),
    ).toBe('stop_recovery');
  });

  it('offers no alternative for an allowed action', () => {
    expect(suggestAlternative('delayed_retry', [], 'allow')).toBeNull();
  });
});
