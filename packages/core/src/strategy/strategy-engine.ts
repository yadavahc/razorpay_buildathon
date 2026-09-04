import type { CaseProfile } from '../domain/case-profiles.js';
import { INTERVENTION_COSTS } from '../domain/intervention-economics.js';
import type { StrategyCandidate } from '../types/decisions.js';
import type { RecoveryStrategy } from '../types/enums.js';
import { formatMinor } from '../types/money.js';
import { round } from '../util/collections.js';
import { type ExpectedValueBreakdown, evaluateAllStrategies } from './expected-value.js';

/**
 * The strategy engine prices every option and produces the comparison table the merchant
 * sees. It applies *structural* eligibility only — physics, not permission:
 *
 *   - you cannot retry a revoked mandate or an expired card,
 *   - you cannot message a customer who has opted out,
 *   - you cannot raise a payment link for a channel that does not support one.
 *
 * Everything else — retry counts, cooldowns, transaction ceilings, quiet hours, budgets —
 * is the policy engine's decision, and the policy engine runs *after* this one and can
 * overrule it. Keeping the two separate is what lets us show "the AI wanted X, policy
 * allowed Y" in the Decision Inspector instead of silently collapsing the two.
 */

export interface StrategyEngineInput {
  amountAtRiskMinor: number;
  recoveryProbability: number;
  profile: CaseProfile;
  priorContactCount: number;
  priorAttemptCount: number;
  /** Structural facts that make certain strategies physically impossible. */
  constraints: {
    contactOptOut: boolean;
    doNotRetry: boolean;
    mandateActive: boolean;
    hasContactChannel: boolean;
    /** The case source supports re-charging a stored instrument at all. */
    retryableSource: boolean;
  };
}

export interface StrategyEvaluation {
  candidates: StrategyCandidate[];
  /** Highest expected value among structurally eligible options. */
  best: StrategyCandidate;
  /** Best option ignoring eligibility, so the UI can explain what was ruled out. */
  bestUnconstrained: StrategyCandidate;
  totalExpectedValueMinor: number;
}

interface Eligibility {
  eligible: boolean;
  reason: string | null;
}

function eligibilityFor(
  strategy: RecoveryStrategy,
  input: StrategyEngineInput,
): Eligibility {
  const { constraints, profile } = input;

  switch (strategy) {
    case 'immediate_retry':
    case 'delayed_retry': {
      if (!constraints.retryableSource) {
        return {
          eligible: false,
          reason: 'This loss type has no stored authorisation to re-present.',
        };
      }
      if (!profile.retryPossible) {
        return {
          eligible: false,
          reason: `A ${profile.label.toLowerCase()} cannot be cleared by re-presenting the same authorisation.`,
        };
      }
      if (!constraints.mandateActive) {
        return {
          eligible: false,
          reason: 'The recurring mandate is not active, so an automated debit is not authorised.',
        };
      }
      if (constraints.doNotRetry) {
        return { eligible: false, reason: 'This customer is flagged do-not-retry.' };
      }
      return { eligible: true, reason: null };
    }
    case 'payment_link': {
      if (!profile.paymentLinkPossible) {
        return { eligible: false, reason: 'A payment link cannot resolve this failure class.' };
      }
      if (!constraints.hasContactChannel) {
        return { eligible: false, reason: 'No deliverable contact channel is on file.' };
      }
      if (constraints.contactOptOut) {
        return { eligible: false, reason: 'The customer has opted out of contact.' };
      }
      return { eligible: true, reason: null };
    }
    case 'customer_notification': {
      if (constraints.contactOptOut) {
        return { eligible: false, reason: 'The customer has opted out of contact.' };
      }
      if (!constraints.hasContactChannel) {
        return { eligible: false, reason: 'No deliverable contact channel is on file.' };
      }
      return { eligible: true, reason: null };
    }
    case 'escalate':
    case 'stop_recovery':
      // Always structurally available: a human can always look, and doing nothing is
      // always possible. This guarantees the engine can never be left with no legal move.
      return { eligible: true, reason: null };
  }
}

function rationaleFor(
  breakdown: ExpectedValueBreakdown,
  input: StrategyEngineInput,
  eligibility: Eligibility,
): string {
  if (!eligibility.eligible) return eligibility.reason ?? 'Not available for this case.';

  const cost = INTERVENTION_COSTS[breakdown.strategy];
  const pct = (breakdown.successProbability * 100).toFixed(0);

  switch (breakdown.strategy) {
    case 'immediate_retry':
      return `Re-presenting now succeeds about ${pct}% of the time for a ${input.profile.label.toLowerCase()}. It costs ${formatMinor(
        breakdown.interventionCostMinor,
      )} and the customer never sees it, but it does not give the blocking condition any time to clear.`;
    case 'delayed_retry':
      return `Waiting ${breakdown.delayHours} hours lets the underlying condition clear, lifting the success rate to about ${pct}%. Same ${formatMinor(
        breakdown.interventionCostMinor,
      )} cost as an immediate retry, and still invisible to the customer.`;
    case 'payment_link':
      return `A fresh hosted link lets the customer pay with any instrument, converting about ${pct}% of cases like this. It costs ${formatMinor(
        breakdown.interventionCostMinor,
      )} including the goodwill of asking the customer to act.`;
    case 'customer_notification':
      return `Telling the customer what happened converts about ${pct}% here. Cheap to send at ${formatMinor(
        breakdown.directCostMinor,
      )}, but the goodwill charge of ${formatMinor(
        breakdown.goodwillCostMinor,
      )} reflects ${input.priorContactCount} prior contact${input.priorContactCount === 1 ? '' : 's'} on this case.`;
    case 'escalate':
      return `A human operator recovers about ${pct}% of cases like this, but twelve minutes of analyst time costs ${formatMinor(
        breakdown.directCostMinor,
      )}. That only clears the bar on balances large enough to pay for the attention.`;
    case 'stop_recovery':
      return `Closing the case costs nothing and returns nothing. It is the right answer whenever every other option has negative expected value — ${cost.description.toLowerCase()}`;
  }
}

export function evaluateStrategies(input: StrategyEngineInput): StrategyEvaluation {
  const breakdowns = evaluateAllStrategies({
    amountAtRiskMinor: input.amountAtRiskMinor,
    recoveryProbability: input.recoveryProbability,
    profile: input.profile,
    priorContactCount: input.priorContactCount,
    priorAttemptCount: input.priorAttemptCount,
  });

  const candidates: StrategyCandidate[] = breakdowns.map((breakdown) => {
    const eligibility = eligibilityFor(breakdown.strategy, input);
    return {
      strategy: breakdown.strategy,
      successProbability: breakdown.successProbability,
      grossRecoveryMinor: breakdown.grossRecoveryMinor,
      interventionCostMinor: breakdown.directCostMinor,
      goodwillCostMinor: breakdown.goodwillCostMinor,
      expectedValueMinor: breakdown.expectedValueMinor,
      delayHours: breakdown.delayHours,
      rationale: rationaleFor(breakdown, input, eligibility),
      eligible: eligibility.eligible,
      ineligibleReason: eligibility.reason,
    };
  });

  const eligible = candidates.filter((c) => c.eligible);
  // `stop_recovery` is always eligible, so this can never be undefined.
  const best = eligible.reduce((a, b) => (b.expectedValueMinor > a.expectedValueMinor ? b : a));
  const bestUnconstrained = candidates.reduce((a, b) =>
    b.expectedValueMinor > a.expectedValueMinor ? b : a,
  );

  return {
    candidates,
    best,
    bestUnconstrained,
    totalExpectedValueMinor: best.expectedValueMinor,
  };
}

/**
 * Confidence in the recommendation itself, distinct from the recovery probability.
 * It is high when one option clearly dominates and low when the top two are within a
 * rounding error of each other — exactly the situation where a human should look.
 */
export function recommendationConfidence(candidates: readonly StrategyCandidate[]): number {
  const eligible = candidates.filter((c) => c.eligible).sort((a, b) => b.expectedValueMinor - a.expectedValueMinor);
  if (eligible.length < 2) return 0.5;
  const [first, second] = eligible as [StrategyCandidate, StrategyCandidate];
  const spread = first.expectedValueMinor - second.expectedValueMinor;
  const scale = Math.max(Math.abs(first.expectedValueMinor), 10_000);
  return round(Math.min(0.97, 0.5 + 0.47 * Math.min(1, spread / scale)), 3);
}
