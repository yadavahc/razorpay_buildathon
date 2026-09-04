import { handler, ok } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import { POLICY_REASON_CODES, formatMinor } from '@reclaim/core';

export const dynamic = 'force-dynamic';

/**
 * The guardrail rulebook plus its live enforcement record.
 *
 * The rules are described from the running configuration rather than hard-coded prose, so
 * changing `POLICY_MAX_RETRIES` in the environment changes what this page says.
 */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  const policy = engine.config.policy;
  const merchantId = engine.merchantId;

  const decisions = await engine.store.policyDecisions.list({
    where: [{ field: 'merchantId', op: '==', value: merchantId }],
  });

  const byVerdict = { allow: 0, deny: 0, require_human: 0 };
  const byReason = new Map<string, number>();
  const byCheck = new Map<string, { pass: number; fail: number; warn: number; skip: number }>();

  for (const decision of decisions) {
    byVerdict[decision.verdict] += 1;
    for (const code of decision.reasonCodes) {
      byReason.set(code, (byReason.get(code) ?? 0) + 1);
    }
    for (const check of decision.checks) {
      const entry = byCheck.get(check.id) ?? { pass: 0, fail: 0, warn: 0, skip: 0 };
      entry[check.result] += 1;
      byCheck.set(check.id, entry);
    }
  }

  // One description per guardrail, rendered from the values actually in force.
  const rules = [
    {
      id: 'max_retries',
      name: 'Maximum automated retries',
      value: String(policy.maxRetries),
      description: `A case may be re-presented at most ${policy.maxRetries} times by automation. Beyond that the engine must switch approach or stop; bounded retries are what separate a recovery engine from a denial-of-service against the customer's bank.`,
      reasonCode: POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED,
    },
    {
      id: 'cooldown',
      name: 'Cooldown between actions',
      value: `${policy.cooldownHours}h`,
      description: `At least ${policy.cooldownHours} hours must pass between two actions on the same case, so a failure cannot cascade into a burst of attempts.`,
      reasonCode: POLICY_REASON_CODES.COOLDOWN_ACTIVE,
    },
    {
      id: 'auto_execute_ceiling',
      name: 'Automated transaction ceiling',
      value: formatMinor(policy.autoExecuteCeilingMinor, { whole: true }),
      description: `Above ${formatMinor(policy.autoExecuteCeilingMinor, { whole: true })} automation prepares the action but a human authorises it. The engine does not move large sums unattended.`,
      reasonCode: POLICY_REASON_CODES.ABOVE_AUTO_EXECUTE_CEILING,
    },
    {
      id: 'daily_contact_cap',
      name: 'Daily contact cap',
      value: `${policy.dailyContactCap} per customer / 24h`,
      description: `A customer receives at most ${policy.dailyContactCap} recovery messages in any rolling 24 hours, counted across every open case they have.`,
      reasonCode: POLICY_REASON_CODES.CONTACT_CAP_EXCEEDED,
    },
    {
      id: 'expected_value_floor',
      name: 'Expected-value floor',
      value: formatMinor(policy.minExpectedValueMinor),
      description: `An action must be worth at least ${formatMinor(policy.minExpectedValueMinor)} in expected value. Below that, intervening destroys value and the correct action is to stop.`,
      reasonCode: POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW,
    },
    {
      id: 'quiet_hours',
      name: 'Quiet hours',
      value: `${policy.quietHoursStart}:00 – ${policy.quietHoursEnd}:00 local`,
      description: `No outbound message is sent during the customer's local night, evaluated in their own IANA timezone rather than the merchant's.`,
      reasonCode: POLICY_REASON_CODES.QUIET_HOURS,
    },
    {
      id: 'case_budget',
      name: 'Per-case intervention budget',
      value: formatMinor(policy.caseBudgetMinor),
      description: `Total intervention spend on a single case is capped at ${formatMinor(policy.caseBudgetMinor)}, so one stubborn case cannot consume the recovery budget.`,
      reasonCode: POLICY_REASON_CODES.CASE_BUDGET_EXHAUSTED,
    },
    {
      id: 'chargeback_risk',
      name: 'Chargeback tolerance',
      value: `${policy.maxChargebacks} prior disputes`,
      description: `A customer with more than ${policy.maxChargebacks} chargebacks is never re-charged automatically: the attempt is more likely to become a dispute than a recovery.`,
      reasonCode: POLICY_REASON_CODES.CHARGEBACK_RISK,
    },
    {
      id: 'contact_consent',
      name: 'Contact consent',
      value: 'Hard gate',
      description:
        'A customer who has opted out is never messaged, whatever the expected value. Consent is not a variable the optimiser is allowed to trade against.',
      reasonCode: POLICY_REASON_CODES.CUSTOMER_OPTED_OUT,
    },
    {
      id: 'mandate_active',
      name: 'Mandate validity',
      value: 'Hard gate',
      description:
        'Debiting without a live mandate is unauthorised, not merely ineffective. Retry strategies are blocked outright when a mandate has been revoked.',
      reasonCode: POLICY_REASON_CODES.MANDATE_INACTIVE,
    },
    {
      id: 'structural_retry',
      name: 'Structural feasibility',
      value: 'Hard gate',
      description:
        'An expired card, a blocked card and an abandoned cart have no authorisation to re-present. Retrying them is blocked before it is priced.',
      reasonCode: POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE,
    },
    {
      id: 'duplicate_prevention',
      name: 'Duplicate prevention',
      value: 'Idempotency ledger',
      description:
        'The idempotency key is claimed before the provider is called, never after. A replayed request is recorded as a prevented duplicate and never reaches the payment provider.',
      reasonCode: POLICY_REASON_CODES.DUPLICATE_ACTION,
    },
    {
      id: 'high_value_low_confidence',
      name: 'Human escalation trigger',
      value: `> ${formatMinor(policy.autoExecuteCeilingMinor / 2, { whole: true })} at < 35% confidence`,
      description:
        'A material balance the model is not confident about is routed to a human rather than guessed at. Ambiguity is escalated, not resolved by automation.',
      reasonCode: POLICY_REASON_CODES.HIGH_VALUE_LOW_CONFIDENCE,
    },
  ];

  return ok(
    {
      version: policy.version,
      config: policy,
      rules: rules.map((rule) => ({
        ...rule,
        enforcement: byCheck.get(rule.id) ?? { pass: 0, fail: 0, warn: 0, skip: 0 },
        blockedCount: byReason.get(rule.reasonCode) ?? 0,
      })),
      totals: {
        evaluations: decisions.length,
        ...byVerdict,
      },
      topReasons: [...byReason.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      recentDecisions: decisions
        .sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1))
        .slice(0, 30),
    },
    startedAt,
  );
});
