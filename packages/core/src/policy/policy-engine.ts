import {
  EMPTY_SUPPRESSION,
  isSuppressed,
  type SuppressionSet,
} from '../analytics/incident-detector.js';
import type { PolicyConfig } from '../config/index.js';
import { retryIsStructurallyPossible } from '../domain/failure-taxonomy.js';
import { totalInterventionCost } from '../domain/intervention-economics.js';
import type { PolicyCheckResult, PolicyDecision } from '../types/decisions.js';
import type {
  CaseSourceType,
  FailureReason,
  PolicyVerdict,
  RecoveryStrategy,
} from '../types/enums.js';
import { TERMINAL_CASE_STATUSES, type CaseStatus } from '../types/enums.js';
import { formatMinor } from '../types/money.js';
import { hoursBetween, localClock } from '../util/time.js';
import { newId } from '../util/id.js';

/**
 * THE POLICY ENGINE
 *
 * This is the layer that decides whether money is allowed to move. It is deterministic,
 * total, and completely independent of the model and the language layer: given the same
 * inputs it returns the same verdict, every time, with no network calls and no
 * randomness. The AI recommends; this engine authorises.
 *
 * Design rules that are load-bearing:
 *
 *   1. EVERY check runs, even after one has already failed. A partial evaluation would
 *      show the merchant only the first problem, and the audit record needs all of them.
 *   2. A check can only ever restrict. There is no code path where a check upgrades a
 *      denial into an approval.
 *   3. Unknown or missing evidence resolves to the restrictive branch, never the
 *      permissive one.
 *   4. The verdict is a pure function of the check results: any `fail` denies; otherwise
 *      any human-review flag escalates; otherwise allow.
 */

export interface PolicyCaseState {
  id: string;
  status: CaseStatus;
  sourceType: CaseSourceType;
  failureReason: FailureReason | null;
  attemptCount: number;
  notificationCount: number;
  cooldownUntil: string | null;
  lastActionAt: string | null;
  detectedAt: string;
  /** Intervention spend already committed to this case, in minor units. */
  spentMinor: number;
}

export interface PolicyCustomerState {
  id: string;
  contactOptOut: boolean;
  doNotRetry: boolean;
  chargebackCount: number;
  timezone: string;
  hasContactChannel: boolean;
}

export interface PolicyEvaluationInput {
  merchantId: string;
  strategy: RecoveryStrategy;
  amountMinor: number;
  expectedValueMinor: number;
  recoveryProbability: number;
  case: PolicyCaseState;
  customer: PolicyCustomerState;
  /** Null when the case is not tied to a subscription mandate. */
  mandateActive: boolean | null;
  /** Contact events for this customer inside the trailing 24 hours. */
  contactsInLast24h: number;
  /** True when an identical action has already been recorded for this idempotency key. */
  idempotencyHit: boolean;
  aiDecisionId: string | null;
  nowIso: string;
  config: PolicyConfig;
  /**
   * Dimensions with a live systemic incident. Passed in rather than looked up so this
   * function stays pure and synchronous; absent means "no incident data available", which
   * resolves permissively because a missing detector must not halt all recovery.
   */
  suppressedDimensions?: SuppressionSet;
  /** The payment route this case would retry on. Absent disables the incident check. */
  instrument?: { issuer: string | null; method: string | null };
}

/** Machine-readable denial codes. The executor branches on these to pick a fallback. */
export const POLICY_REASON_CODES = {
  CASE_TERMINAL: 'CASE_TERMINAL',
  RETRY_STRUCTURALLY_IMPOSSIBLE: 'RETRY_STRUCTURALLY_IMPOSSIBLE',
  MANDATE_INACTIVE: 'MANDATE_INACTIVE',
  CUSTOMER_OPTED_OUT: 'CUSTOMER_OPTED_OUT',
  CUSTOMER_DO_NOT_RETRY: 'CUSTOMER_DO_NOT_RETRY',
  CHARGEBACK_RISK: 'CHARGEBACK_RISK',
  NO_CONTACT_CHANNEL: 'NO_CONTACT_CHANNEL',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
  CONTACT_CAP_EXCEEDED: 'CONTACT_CAP_EXCEEDED',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  QUIET_HOURS: 'QUIET_HOURS',
  SYSTEMIC_INCIDENT_ACTIVE: 'SYSTEMIC_INCIDENT_ACTIVE',
  EXPECTED_VALUE_TOO_LOW: 'EXPECTED_VALUE_TOO_LOW',
  CASE_BUDGET_EXHAUSTED: 'CASE_BUDGET_EXHAUSTED',
  DUPLICATE_ACTION: 'DUPLICATE_ACTION',
  ABOVE_AUTO_EXECUTE_CEILING: 'ABOVE_AUTO_EXECUTE_CEILING',
  HIGH_VALUE_LOW_CONFIDENCE: 'HIGH_VALUE_LOW_CONFIDENCE',
} as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[keyof typeof POLICY_REASON_CODES];

/** Codes that route to a human rather than blocking outright. */
const HUMAN_REVIEW_CODES = new Set<string>([
  POLICY_REASON_CODES.ABOVE_AUTO_EXECUTE_CEILING,
  POLICY_REASON_CODES.HIGH_VALUE_LOW_CONFIDENCE,
]);

const MONEY_MOVING: ReadonlySet<RecoveryStrategy> = new Set([
  'immediate_retry',
  'delayed_retry',
  'payment_link',
]);

const CUSTOMER_FACING: ReadonlySet<RecoveryStrategy> = new Set([
  'payment_link',
  'customer_notification',
]);

const RETRY_STRATEGIES: ReadonlySet<RecoveryStrategy> = new Set(['immediate_retry', 'delayed_retry']);

function check(
  id: string,
  name: string,
  description: string,
  result: PolicyCheckResult['result'],
  detail: string,
  reasonCode: string | null = null,
): PolicyCheckResult {
  return { id, name, description, result, detail, reasonCode };
}

/**
 * Evaluate one proposed action against every guardrail.
 *
 * `stop_recovery` is intentionally not exempt from evaluation — it runs the same checks
 * and passes them all — so that the audit trail contains a policy decision for every
 * single action taken, including the decision to do nothing.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
  const started = Date.now();
  const checks: PolicyCheckResult[] = [];
  const { config, strategy } = input;

  const isRetry = RETRY_STRATEGIES.has(strategy);
  const isContact = CUSTOMER_FACING.has(strategy);
  const movesMoney = MONEY_MOVING.has(strategy);
  const isStop = strategy === 'stop_recovery';
  const isEscalation = strategy === 'escalate';

  // --- 1. Case lifecycle -----------------------------------------------------
  const terminal = TERMINAL_CASE_STATUSES.includes(input.case.status);
  checks.push(
    check(
      'case_status',
      'Case is still open',
      'Terminal cases can never be acted on again; this is what makes recovery idempotent at the case level.',
      terminal && !isStop ? 'fail' : 'pass',
      terminal
        ? `Case is ${input.case.status}.`
        : `Case is ${input.case.status} and eligible for action.`,
      terminal && !isStop ? POLICY_REASON_CODES.CASE_TERMINAL : null,
    ),
  );

  // --- 2. Structural feasibility --------------------------------------------
  if (isRetry) {
    const possible =
      retryIsStructurallyPossible(input.case.failureReason) &&
      input.case.sourceType !== 'checkout_abandonment' &&
      input.case.sourceType !== 'overdue_invoice';
    checks.push(
      check(
        'structural_retry',
        'Retry is physically possible',
        'An expired card, a revoked mandate or an abandoned cart has no authorisation to re-present.',
        possible ? 'pass' : 'fail',
        possible
          ? 'A stored authorisation exists and the failure class permits re-presentment.'
          : `A ${input.case.failureReason ?? input.case.sourceType} cannot be recovered by re-presenting the same authorisation.`,
        possible ? null : POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE,
      ),
    );

    const mandateOk = input.mandateActive !== false;
    checks.push(
      check(
        'mandate_active',
        'Debit mandate is live',
        'Debiting without a live mandate is not merely ineffective, it is unauthorised.',
        mandateOk ? 'pass' : 'fail',
        mandateOk ? 'Mandate is active or not applicable.' : 'The recurring mandate has been revoked.',
        mandateOk ? null : POLICY_REASON_CODES.MANDATE_INACTIVE,
      ),
    );
  } else {
    checks.push(
      check(
        'structural_retry',
        'Retry is physically possible',
        'Only evaluated for retry strategies.',
        'skip',
        'Not a retry strategy.',
      ),
    );
  }

  // --- 3. Customer eligibility ----------------------------------------------
  const optOutBlocks = isContact && input.customer.contactOptOut;
  checks.push(
    check(
      'contact_consent',
      'Customer has not opted out',
      'Contact preference is a hard gate. No expected value justifies messaging someone who asked not to be messaged.',
      optOutBlocks ? 'fail' : 'pass',
      optOutBlocks
        ? 'Customer has opted out of recovery communication.'
        : input.customer.contactOptOut
          ? 'Customer has opted out, but this strategy sends nothing.'
          : 'Customer accepts recovery communication.',
      optOutBlocks ? POLICY_REASON_CODES.CUSTOMER_OPTED_OUT : null,
    ),
  );

  const doNotRetryBlocks = isRetry && input.customer.doNotRetry;
  checks.push(
    check(
      'do_not_retry_flag',
      'Customer is not flagged do-not-retry',
      'Set after disputes or explicit customer request; overrides any economic argument.',
      doNotRetryBlocks ? 'fail' : 'pass',
      doNotRetryBlocks ? 'Customer is flagged do-not-retry.' : 'No do-not-retry flag on this customer.',
      doNotRetryBlocks ? POLICY_REASON_CODES.CUSTOMER_DO_NOT_RETRY : null,
    ),
  );

  const chargebackBlocks = movesMoney && input.customer.chargebackCount > config.maxChargebacks;
  checks.push(
    check(
      'chargeback_risk',
      'Chargeback history within tolerance',
      'Re-charging a customer who disputes routinely converts a recovery attempt into a dispute cost.',
      chargebackBlocks ? 'fail' : 'pass',
      `${input.customer.chargebackCount} prior chargeback${input.customer.chargebackCount === 1 ? '' : 's'} against a limit of ${config.maxChargebacks}.`,
      chargebackBlocks ? POLICY_REASON_CODES.CHARGEBACK_RISK : null,
    ),
  );

  const channelBlocks = isContact && !input.customer.hasContactChannel;
  checks.push(
    check(
      'contact_channel',
      'A deliverable channel exists',
      'Sending to an address we do not have is a silent failure; block it at the gate instead.',
      channelBlocks ? 'fail' : 'pass',
      channelBlocks ? 'No email, phone or in-app channel on file.' : 'A deliverable channel is on file.',
      channelBlocks ? POLICY_REASON_CODES.NO_CONTACT_CHANNEL : null,
    ),
  );

  // --- 4. Rate limits --------------------------------------------------------
  const retriesBlocked = isRetry && input.case.attemptCount >= config.maxRetries;
  checks.push(
    check(
      'max_retries',
      'Retry budget remaining',
      'Bounded retries are the difference between a recovery engine and a denial-of-service against the customer bank.',
      retriesBlocked ? 'fail' : 'pass',
      `${input.case.attemptCount} of ${config.maxRetries} automated retries used on this case.`,
      retriesBlocked ? POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED : null,
    ),
  );

  // A retry into an issuer that is currently down is not a recovery attempt, it is a
  // guaranteed failure that spends the case's retry budget and the customer's patience at
  // the exact moment neither can be spared. Hold the cohort; release it as a wave when the
  // dimension recovers. Contact strategies are unaffected -- a payment link still works
  // while an issuer's authorisation endpoint does not.
  const incident = isRetry
    ? isSuppressed(input.suppressedDimensions ?? EMPTY_SUPPRESSION, {
        issuer: input.instrument?.issuer ?? null,
        method: input.instrument?.method ?? null,
        failureReason: input.case.failureReason,
      })
    : { suppressed: false, dimension: null, value: null };
  checks.push(
    check(
      'systemic_incident',
      'No active incident on this route',
      'Retrying into a known outage burns the retry budget on a certain failure.',
      incident.suppressed ? 'fail' : isRetry ? 'pass' : 'skip',
      incident.suppressed
        ? `Active incident on ${incident.dimension} ${incident.value}; retries held until it clears.`
        : isRetry
          ? 'No systemic incident affects this payment route.'
          : 'Not a retry strategy.',
      incident.suppressed ? POLICY_REASON_CODES.SYSTEMIC_INCIDENT_ACTIVE : null,
    ),
  );

  const contactBlocked = isContact && input.contactsInLast24h >= config.dailyContactCap;
  checks.push(
    check(
      'daily_contact_cap',
      'Daily contact cap respected',
      'Caps outbound messages per customer per rolling 24 hours across every open case.',
      contactBlocked ? 'fail' : 'pass',
      `${input.contactsInLast24h} of ${config.dailyContactCap} messages sent to this customer in the last 24h.`,
      contactBlocked ? POLICY_REASON_CODES.CONTACT_CAP_EXCEEDED : null,
    ),
  );

  // --- 5. Cooldown -----------------------------------------------------------
  let cooldownActive = false;
  let cooldownDetail = 'No cooldown in effect.';
  if (!isStop && !isEscalation) {
    if (input.case.cooldownUntil && input.nowIso < input.case.cooldownUntil) {
      cooldownActive = true;
      const hours = hoursBetween(input.nowIso, input.case.cooldownUntil);
      cooldownDetail = `Explicit cooldown active for another ${hours.toFixed(1)}h.`;
    } else if (input.case.lastActionAt) {
      const elapsed = hoursBetween(input.case.lastActionAt, input.nowIso);
      if (elapsed < config.cooldownHours) {
        cooldownActive = true;
        cooldownDetail = `Only ${elapsed.toFixed(1)}h since the last action; ${config.cooldownHours}h required.`;
      } else {
        cooldownDetail = `${elapsed.toFixed(1)}h since the last action, above the ${config.cooldownHours}h minimum.`;
      }
    }
  }
  checks.push(
    check(
      'cooldown',
      'Cooldown period elapsed',
      'Minimum spacing between two actions on the same case.',
      cooldownActive ? 'fail' : isStop || isEscalation ? 'skip' : 'pass',
      isStop || isEscalation ? 'Cooldown does not apply to stopping or escalating.' : cooldownDetail,
      cooldownActive ? POLICY_REASON_CODES.COOLDOWN_ACTIVE : null,
    ),
  );

  // --- 6. Quiet hours --------------------------------------------------------
  let quietBlocked = false;
  let quietDetail = 'Not a customer-facing action.';
  if (isContact) {
    const clock = localClock(input.nowIso, input.customer.timezone);
    const { quietHoursStart: start, quietHoursEnd: end } = config;
    // Window wraps midnight: 21:00 -> 09:00.
    quietBlocked = start > end ? clock.hour >= start || clock.hour < end : clock.hour >= start && clock.hour < end;
    quietDetail = `Local time for the customer is ${String(clock.hour).padStart(2, '0')}:${String(
      clock.minute,
    ).padStart(2, '0')} (${input.customer.timezone}); quiet hours run ${start}:00–${end}:00.`;
  }
  checks.push(
    check(
      'quiet_hours',
      'Outside quiet hours',
      'No outbound messages in the customer local night, regardless of expected value.',
      quietBlocked ? 'fail' : isContact ? 'pass' : 'skip',
      quietDetail,
      quietBlocked ? POLICY_REASON_CODES.QUIET_HOURS : null,
    ),
  );

  // --- 7. Economics ----------------------------------------------------------
  const evTooLow = !isStop && input.expectedValueMinor < config.minExpectedValueMinor;
  checks.push(
    check(
      'expected_value_floor',
      'Expected value clears the floor',
      'Acting below the floor destroys value; the correct action is to stop.',
      evTooLow ? 'fail' : isStop ? 'skip' : 'pass',
      isStop
        ? 'Stopping has no expected-value requirement.'
        : `Expected value ${formatMinor(input.expectedValueMinor)} against a floor of ${formatMinor(config.minExpectedValueMinor)}.`,
      evTooLow ? POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW : null,
    ),
  );

  const projectedSpend =
    input.case.spentMinor + totalInterventionCost(strategy, input.case.notificationCount);
  const budgetExhausted = !isStop && projectedSpend > config.caseBudgetMinor;
  checks.push(
    check(
      'case_budget',
      'Case intervention budget available',
      'Total spend per case is capped so a single stubborn case cannot consume the recovery budget.',
      budgetExhausted ? 'fail' : isStop ? 'skip' : 'pass',
      isStop
        ? 'Stopping costs nothing.'
        : `${formatMinor(projectedSpend)} projected against a ${formatMinor(config.caseBudgetMinor)} budget.`,
      budgetExhausted ? POLICY_REASON_CODES.CASE_BUDGET_EXHAUSTED : null,
    ),
  );

  // --- 8. Duplicate prevention ----------------------------------------------
  checks.push(
    check(
      'duplicate_prevention',
      'No identical action already executed',
      'The idempotency ledger is consulted before, not after, the provider call.',
      input.idempotencyHit ? 'fail' : 'pass',
      input.idempotencyHit
        ? 'An action with this exact idempotency key has already been executed.'
        : 'No prior action matches this idempotency key.',
      input.idempotencyHit ? POLICY_REASON_CODES.DUPLICATE_ACTION : null,
    ),
  );

  // --- 9. Human-review triggers ---------------------------------------------
  const aboveCeiling = movesMoney && input.amountMinor > config.autoExecuteCeilingMinor;
  checks.push(
    check(
      'auto_execute_ceiling',
      'Amount within automated authority',
      'Above the ceiling a human approves the action; automation prepares it but does not fire it.',
      aboveCeiling ? 'warn' : movesMoney ? 'pass' : 'skip',
      movesMoney
        ? `${formatMinor(input.amountMinor)} against an automated ceiling of ${formatMinor(config.autoExecuteCeilingMinor)}.`
        : 'This strategy moves no money.',
      aboveCeiling ? POLICY_REASON_CODES.ABOVE_AUTO_EXECUTE_CEILING : null,
    ),
  );

  // Large balance with a weak prediction is the classic case for human judgement.
  const highValueLowConfidence =
    !isStop &&
    !isEscalation &&
    input.amountMinor > config.autoExecuteCeilingMinor / 2 &&
    input.recoveryProbability < 0.35;
  checks.push(
    check(
      'high_value_low_confidence',
      'Confidence adequate for the amount',
      'Escalates cases where the balance is material but the model is not confident.',
      highValueLowConfidence ? 'warn' : 'pass',
      `${formatMinor(input.amountMinor)} at ${(input.recoveryProbability * 100).toFixed(0)}% predicted recovery.`,
      highValueLowConfidence ? POLICY_REASON_CODES.HIGH_VALUE_LOW_CONFIDENCE : null,
    ),
  );

  // --- Verdict ---------------------------------------------------------------
  const failed = checks.filter((c) => c.result === 'fail');
  const warned = checks.filter((c) => c.result === 'warn' && c.reasonCode);
  const reasonCodes = [...failed, ...warned]
    .map((c) => c.reasonCode)
    .filter((code): code is string => code !== null);

  let verdict: PolicyVerdict;
  if (failed.length > 0) verdict = 'deny';
  else if (warned.some((c) => HUMAN_REVIEW_CODES.has(c.reasonCode!))) verdict = 'require_human';
  else verdict = 'allow';

  return {
    id: newId('pol'),
    merchantId: input.merchantId,
    caseId: input.case.id,
    aiDecisionId: input.aiDecisionId,
    requestedStrategy: strategy,
    amountMinor: input.amountMinor,
    verdict,
    checks,
    reasonCodes,
    suggestedAlternative: suggestAlternative(strategy, reasonCodes, verdict),
    policyVersion: config.version,
    evaluatedAt: input.nowIso,
    durationMs: Math.max(0, Date.now() - started),
  };
}

/**
 * When an action is denied, propose the next thing worth trying. The executor uses this
 * to build a fallback chain rather than simply giving up, which is where a meaningful
 * share of recovered revenue actually comes from.
 */
export function suggestAlternative(
  strategy: RecoveryStrategy,
  reasonCodes: readonly string[],
  verdict: PolicyVerdict,
): RecoveryStrategy | null {
  if (verdict === 'allow') return null;
  // Escalating and stopping are terminal actions: there is nothing further to fall back to,
  // and proposing either as its own replacement is a dead end the executor has to unwind.
  if (strategy === 'stop_recovery' || strategy === 'escalate') return null;
  if (verdict === 'require_human') return 'escalate';

  const codes = new Set(reasonCodes);

  // Hard customer-level stops admit no alternative at all.
  if (
    codes.has(POLICY_REASON_CODES.CUSTOMER_OPTED_OUT) ||
    codes.has(POLICY_REASON_CODES.CHARGEBACK_RISK) ||
    codes.has(POLICY_REASON_CODES.CASE_TERMINAL) ||
    codes.has(POLICY_REASON_CODES.DUPLICATE_ACTION)
  ) {
    return 'stop_recovery';
  }

  if (codes.has(POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW)) return 'stop_recovery';
  if (codes.has(POLICY_REASON_CODES.CASE_BUDGET_EXHAUSTED)) return 'stop_recovery';

  // A retry that cannot happen becomes a link the customer can act on.
  if (
    codes.has(POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE) ||
    codes.has(POLICY_REASON_CODES.MANDATE_INACTIVE) ||
    codes.has(POLICY_REASON_CODES.CUSTOMER_DO_NOT_RETRY) ||
    codes.has(POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED)
  ) {
    // The link is the standard substitute for a retry that cannot happen -- unless the link
    // is what was just refused, in which case nothing further is worth proposing.
    return strategy === 'payment_link' ? null : 'payment_link';
  }

  // Timing problems become scheduled work rather than abandoned work -- but the substitute
  // has to actually escape the clock that blocked us. Returning the strategy we were just
  // denied is not a fallback: the executor's already-attempted guard reads it as "nothing
  // left to try" and ends the chain having recovered nothing.
  //
  // Quiet hours blocks customer-facing contact alone, so a silent retry clears the check
  // outright and can still move the money tonight. A case cooldown paces every non-stop
  // strategy on the case, so nothing escapes it except a retry that is itself deferred.
  if (codes.has(POLICY_REASON_CODES.COOLDOWN_ACTIVE)) {
    return strategy === 'immediate_retry' ? 'delayed_retry' : null;
  }
  if (codes.has(POLICY_REASON_CODES.QUIET_HOURS)) {
    return strategy === 'delayed_retry' ? null : 'delayed_retry';
  }

  // Out of contact budget, or no channel to contact them on: the money can still move
  // silently. If we were already the silent retry, there is nothing further to propose.
  if (
    codes.has(POLICY_REASON_CODES.CONTACT_CAP_EXCEEDED) ||
    codes.has(POLICY_REASON_CODES.NO_CONTACT_CHANNEL)
  ) {
    return strategy === 'delayed_retry' ? null : 'delayed_retry';
  }

  return 'stop_recovery';
}

/** Convenience predicate used by the executor and by tests. */
export function isAllowed(decision: PolicyDecision): boolean {
  return decision.verdict === 'allow';
}
