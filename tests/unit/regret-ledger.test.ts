import { describe, expect, it } from 'vitest';
import {
  MIN_COMPARABLE_SAMPLE,
  POLICY_REASON_CODES,
  computeRegretLedger,
  type PolicyConfig,
  type PolicyDecision,
  type RecoveryCase,
  type RecoveryOutcome,
  type RecoveryStrategy,
} from '@reclaim/core';
import { policyReasonLabel } from '@reclaim/core/presentation';

const NOW = '2026-09-04T05:00:00.000Z';

const CONFIG: PolicyConfig = {
  version: 'test-policy',
  maxRetries: 3,
  cooldownHours: 6,
  autoExecuteCeilingMinor: 500_000,
  dailyContactCap: 2,
  minExpectedValueMinor: 2_000,
  quietHoursStart: 21,
  quietHoursEnd: 8,
  maxChargebacks: 1,
  caseBudgetMinor: 30_000,
} as PolicyConfig;

function decision(
  overrides: Partial<PolicyDecision> & Pick<PolicyDecision, 'caseId' | 'reasonCodes'>,
): PolicyDecision {
  return {
    id: `pd_${Math.random().toString(36).slice(2)}`,
    merchantId: 'm1',
    aiDecisionId: null,
    requestedStrategy: 'payment_link',
    amountMinor: 100_000,
    verdict: 'deny',
    checks: [],
    suggestedAlternative: null,
    policyVersion: 'test-policy',
    evaluatedAt: NOW,
    durationMs: 1,
    ...overrides,
  } as PolicyDecision;
}

function outcome(strategy: RecoveryStrategy, recovered: number, atRisk: number): RecoveryOutcome {
  return {
    id: `o_${Math.random().toString(36).slice(2)}`,
    merchantId: 'm1',
    caseId: 'c_other',
    actionId: null,
    outcome: recovered > 0 ? 'recovered' : 'failed',
    recoveredAmountMinor: recovered,
    amountAtRiskMinor: atRisk,
    strategy,
    predictedProbability: 0.5,
    timeToOutcomeMs: 1_000,
    recordedAt: NOW,
  } as RecoveryOutcome;
}

function recoveryCase(id: string, amountMinor: number): RecoveryCase {
  return { id, merchantId: 'm1', amountAtRiskMinor: amountMinor } as RecoveryCase;
}

/** Enough realised outcomes for a strategy to clear the quotable-sample bar. */
function realisedFor(strategy: RecoveryStrategy, rate: number, n = MIN_COMPARABLE_SAMPLE + 5) {
  return Array.from({ length: n }, () => outcome(strategy, Math.round(100_000 * rate), 100_000));
}

const base = {
  config: CONFIG,
  labelFor: policyReasonLabel,
  nowIso: NOW,
};

describe('regret ledger — facts are counted, not estimated', () => {
  it('de-duplicates exposure when one case is blocked repeatedly for the same reason', () => {
    // The same case denied three times is one case worth of money at stake, not three.
    const decisions = [
      decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS] }),
      decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS] }),
      decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS] }),
    ];

    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: decisions,
      outcomes: realisedFor('payment_link', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });

    const row = ledger.rows.find((r) => r.reasonCode === POLICY_REASON_CODES.QUIET_HOURS)!;
    expect(row.blockedDecisions).toBe(3);
    expect(row.blockedCases).toBe(1);
    expect(row.blockedExposureMinor).toBe(100_000);
  });

  it('credits every cited reason code for a denial with several', () => {
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({
          caseId: 'c1',
          reasonCodes: [
            POLICY_REASON_CODES.QUIET_HOURS,
            POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW,
          ],
        }),
      ],
      outcomes: realisedFor('payment_link', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });

    expect(ledger.rows.map((r) => r.reasonCode).sort()).toEqual(
      [POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW, POLICY_REASON_CODES.QUIET_HOURS].sort(),
    );
  });

  it('ignores allowed decisions entirely', () => {
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [decision({ caseId: 'c1', reasonCodes: [], verdict: 'allow' })],
      outcomes: realisedFor('payment_link', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.evidenceBase.blockedDecisions).toBe(0);
  });
});

describe('regret ledger — estimates refuse to overstate', () => {
  it('quotes no figure when the comparable sample is too thin', () => {
    // Three realised outcomes cannot support a rupee claim about foregone revenue.
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS] })],
      outcomes: realisedFor('payment_link', 0.5, 3),
      cases: [recoveryCase('c1', 100_000)],
    });

    const row = ledger.rows[0];
    expect(row.comparableRecoveryRate).toBeNull();
    expect(row.estimatedForegoneMinor).toBeNull();
    expect(row.netRegretMinor).toBeNull();
    expect(row.caveat).toContain('below the');
    expect(ledger.totals.rowsWithoutEstimate).toBe(1);
  });

  it('derives the rate from realised outcomes rather than from any model score', () => {
    // 40% of money actually came back on payment_link, so 40% of blocked exposure is the
    // estimate — regardless of what the model would have predicted for these cases.
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS] })],
      outcomes: realisedFor('payment_link', 0.4),
      cases: [recoveryCase('c1', 200_000)],
    });

    const row = ledger.rows[0];
    expect(row.comparableRecoveryRate).toBeCloseTo(0.4, 5);
    expect(row.estimatedForegoneMinor).toBe(80_000);
  });

  it('weights the rate by the strategies the guardrail actually blocked', () => {
    // Blocked twice on payment_link (20% realised) and once on delayed_retry (80%).
    // The blend must follow that 2:1 mix, not an unweighted average of the two rates.
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({
          caseId: 'c1',
          requestedStrategy: 'payment_link',
          reasonCodes: [POLICY_REASON_CODES.COOLDOWN_ACTIVE],
        }),
        decision({
          caseId: 'c2',
          requestedStrategy: 'payment_link',
          reasonCodes: [POLICY_REASON_CODES.COOLDOWN_ACTIVE],
        }),
        decision({
          caseId: 'c3',
          requestedStrategy: 'delayed_retry',
          reasonCodes: [POLICY_REASON_CODES.COOLDOWN_ACTIVE],
        }),
      ],
      outcomes: [...realisedFor('payment_link', 0.2), ...realisedFor('delayed_retry', 0.8)],
      cases: [
        recoveryCase('c1', 100_000),
        recoveryCase('c2', 100_000),
        recoveryCase('c3', 100_000),
      ],
    });

    const row = ledger.rows[0];
    expect(row.comparableRecoveryRate).toBeCloseTo((0.2 * 2 + 0.8 * 1) / 3, 5);
  });

  it('leaves net regret null when the harm has no defensible cash price', () => {
    // A message not sent at 3am is a real benefit and an unquotable one. The ledger says so
    // rather than inventing a goodwill rupee figure to make the column add up.
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS] })],
      outcomes: realisedFor('payment_link', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });

    const row = ledger.rows[0];
    expect(row.harmPrevented.pricedMinor).toBeNull();
    expect(row.netRegretMinor).toBeNull();
    expect(row.estimatedForegoneMinor).not.toBeNull();
  });

  it('prices a prevented duplicate charge at the full amount', () => {
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.DUPLICATE_ACTION] }),
      ],
      outcomes: realisedFor('payment_link', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });

    const row = ledger.rows[0];
    expect(row.harmPrevented.pricedMinor).toBe(100_000);
    expect(row.netRegretMinor).toBe(row.estimatedForegoneMinor! - 100_000);
  });
});

describe('regret ledger — proposals stay inside their lane', () => {
  it('never proposes relaxing a consent guardrail, however expensive it is', () => {
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({ caseId: 'c1', reasonCodes: [POLICY_REASON_CODES.CUSTOMER_OPTED_OUT] }),
        decision({ caseId: 'c2', reasonCodes: [POLICY_REASON_CODES.CUSTOMER_DO_NOT_RETRY] }),
        decision({ caseId: 'c3', reasonCodes: [POLICY_REASON_CODES.DUPLICATE_ACTION] }),
      ],
      outcomes: realisedFor('payment_link', 0.9),
      cases: [
        recoveryCase('c1', 5_000_000),
        recoveryCase('c2', 5_000_000),
        recoveryCase('c3', 5_000_000),
      ],
    });

    // Large foregone figures on every row...
    expect(ledger.totals.estimatedForegoneMinor).toBeGreaterThan(0);
    // ...and not one of them is a reason to contact someone who said no.
    expect(ledger.proposals).toHaveLength(0);
    for (const row of ledger.rows) {
      expect(row.caveat).toContain('not a case for relaxing it');
    }
  });

  it('proposes narrowing quiet hours only while it still blocks silent retries', () => {
    const blockingSilent = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({
          caseId: 'c1',
          requestedStrategy: 'delayed_retry',
          reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS],
        }),
      ],
      outcomes: realisedFor('delayed_retry', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });
    expect(blockingSilent.proposals.map((p) => p.id)).toContain('amend_quiet_hours_scope');

    // Once the guardrail is correctly scoped to customer-facing strategies there is
    // nothing left to propose, and the ledger must stop asking.
    const correctlyScoped = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({
          caseId: 'c1',
          requestedStrategy: 'customer_notification',
          reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS],
        }),
      ],
      outcomes: realisedFor('customer_notification', 0.5),
      cases: [recoveryCase('c1', 100_000)],
    });
    expect(correctlyScoped.proposals.map((p) => p.id)).not.toContain('amend_quiet_hours_scope');
  });

  it('marks every proposal as requiring human approval', () => {
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [
        decision({
          caseId: 'c1',
          requestedStrategy: 'delayed_retry',
          reasonCodes: [POLICY_REASON_CODES.QUIET_HOURS],
        }),
        decision({ caseId: 'c2', reasonCodes: [POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW] }),
        decision({ caseId: 'c3', reasonCodes: [POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED] }),
      ],
      outcomes: [...realisedFor('delayed_retry', 0.5), ...realisedFor('payment_link', 0.5)],
      cases: [
        recoveryCase('c1', 100_000),
        recoveryCase('c2', 100_000),
        recoveryCase('c3', 100_000),
      ],
    });

    expect(ledger.proposals.length).toBeGreaterThan(0);
    for (const proposal of ledger.proposals) {
      expect(proposal.requiresHumanApproval).toBe(true);
      // A proposal that cannot say what it changes is not actionable.
      expect(proposal.change.from).not.toBe(proposal.change.to);
      expect(proposal.sampleSize).toBeGreaterThanOrEqual(MIN_COMPARABLE_SAMPLE);
    }
  });

  it('produces no proposals at all when nothing was blocked', () => {
    const ledger = computeRegretLedger({
      ...base,
      policyDecisions: [],
      outcomes: realisedFor('payment_link', 0.5),
      cases: [],
    });
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.proposals).toHaveLength(0);
    expect(ledger.totals.netRegretMinor).toBe(0);
  });
});
