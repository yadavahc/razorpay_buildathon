import type { CaseSourceType, FailureReason, RecoveryStrategy } from '../types/enums.js';
import type { FailureCategory, FailureProfile } from './failure-taxonomy.js';
import { FAILURE_PROFILES } from './failure-taxonomy.js';

/**
 * Not every revenue-loss event is a declined payment. Checkout abandonment and overdue
 * receivables have no bank error code at all, yet they need the same downstream
 * treatment: a recoverability prior, a delay recommendation, and a per-strategy lift.
 *
 * `CaseProfile` is the shape the decisioning pipeline consumes; failure declines,
 * abandoned carts and overdue invoices all normalise into it.
 */
export interface CaseProfile {
  key: string;
  category: FailureCategory;
  label: string;
  selfResolving: boolean;
  baseRecoverability: number;
  optimalDelayHours: number;
  customerActionRequired: boolean;
  retryPossible: boolean;
  paymentLinkPossible: boolean;
  strategyLift: Record<RecoveryStrategy, number>;
  headline: string;
  explanation: string;
}

const NO_DIRECT_LIFT = { escalate: 0, stop_recovery: 0 } as const;

/**
 * Abandonment recovers better the further down the funnel the customer got: someone who
 * reached the OTP screen has already committed far more than someone who left at the cart.
 */
export const ABANDONMENT_PROFILES: Record<string, CaseProfile> = {
  cart: {
    key: 'abandoned_cart',
    category: 'customer_intent',
    label: 'Abandoned at cart',
    selfResolving: false,
    baseRecoverability: 0.14,
    optimalDelayHours: 4,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0,
      delayed_retry: 0,
      payment_link: 0.86,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The customer left before choosing how to pay',
    explanation:
      'Early-funnel abandonment signals weak intent: the customer never selected an instrument, so there is nothing to retry. Only a re-engagement message or a ready-to-pay link has any chance, and the low base rate means these cases are worth working only at high cart values.',
  },
  contact: {
    key: 'abandoned_contact',
    category: 'customer_intent',
    label: 'Abandoned at contact details',
    selfResolving: false,
    baseRecoverability: 0.21,
    optimalDelayHours: 3,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0,
      delayed_retry: 0,
      payment_link: 0.92,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The customer entered contact details and then left',
    explanation:
      'The customer surrendered a contact channel before dropping out, which both raises intent and makes them reachable. Recovery is a delivery problem: get a payable link into a channel they read.',
  },
  method_selected: {
    key: 'abandoned_method',
    category: 'customer_intent',
    label: 'Abandoned after selecting a method',
    selfResolving: false,
    baseRecoverability: 0.34,
    optimalDelayHours: 2,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0,
      delayed_retry: 0,
      payment_link: 1.0,
      customer_notification: 0.84,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The customer chose an instrument but never authorised',
    explanation:
      'Method selection is a strong intent signal. The drop-off is usually friction or a distraction rather than a decision not to buy, so a link that resumes exactly where they stopped converts well.',
  },
  otp_pending: {
    key: 'abandoned_otp',
    category: 'authentication',
    label: 'Abandoned at authentication',
    selfResolving: false,
    baseRecoverability: 0.46,
    optimalDelayHours: 1,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0,
      delayed_retry: 0,
      payment_link: 1.0,
      customer_notification: 0.78,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The customer reached the OTP step and did not finish',
    explanation:
      'This is the highest-intent abandonment there is — the customer authorised everything except the final step, often because the OTP was slow to arrive. Acting within the hour, while intent is still warm, is what makes the difference.',
  },
};

/** Overdue receivables decay: the older the invoice, the less of it comes back. */
export function overdueProfile(daysOverdue: number): CaseProfile {
  const bucket =
    daysOverdue <= 7 ? 'fresh' : daysOverdue <= 30 ? 'aging' : daysOverdue <= 90 ? 'stale' : 'delinquent';

  const table: Record<string, { base: number; delay: number; headline: string; explanation: string }> = {
    fresh: {
      base: 0.68,
      delay: 12,
      headline: 'Recently overdue — most of these are simple oversights',
      explanation:
        'Invoices under a week past due are dominated by administrative delay rather than unwillingness to pay. A single well-timed reminder with a payable link resolves the majority before they age.',
    },
    aging: {
      base: 0.46,
      delay: 24,
      headline: 'Aging receivable — attention is fading',
      explanation:
        'Between one week and one month, recovery starts depending on active follow-up. The invoice is no longer top of mind and competes with newer obligations, so each additional week of silence costs measurable recovery rate.',
    },
    stale: {
      base: 0.24,
      delay: 48,
      headline: 'Stale receivable — automated reminders are losing effect',
      explanation:
        'Past a month, repeated automated reminders show sharply diminishing returns. Value shifts to human collection on the largest balances and to writing off the smallest ones cleanly.',
    },
    delinquent: {
      base: 0.09,
      delay: 72,
      headline: 'Delinquent receivable — recovery is unlikely without human contact',
      explanation:
        'Beyond ninety days the base recovery rate is below one in ten. Continuing to spend automated interventions here destroys value; only high-balance accounts justify a human escalation.',
    },
  };

  const cfg = table[bucket]!;
  return {
    key: `overdue_${bucket}`,
    category: 'customer_intent',
    label: `Overdue invoice (${bucket})`,
    selfResolving: false,
    baseRecoverability: cfg.base,
    optimalDelayHours: cfg.delay,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0,
      delayed_retry: 0,
      payment_link: 1.0,
      customer_notification: 0.88,
      ...NO_DIRECT_LIFT,
    },
    headline: cfg.headline,
    explanation: cfg.explanation,
  };
}

export function fromFailureProfile(profile: FailureProfile): CaseProfile {
  return {
    key: profile.reason,
    category: profile.category,
    label: profile.label,
    selfResolving: profile.selfResolving,
    baseRecoverability: profile.baseRecoverability,
    optimalDelayHours: profile.optimalDelayHours,
    customerActionRequired: profile.customerActionRequired,
    retryPossible: profile.retryPossible,
    paymentLinkPossible: profile.paymentLinkPossible,
    strategyLift: profile.strategyLift,
    headline: profile.headline,
    explanation: profile.explanation,
  };
}

export interface CaseProfileInput {
  sourceType: CaseSourceType;
  failureReason: FailureReason | null;
  abandonmentStage?: string | null;
  daysOverdue?: number | null;
}

/**
 * Normalise any revenue-loss event into the single profile shape the rest of the
 * pipeline understands. Unknown inputs fall back to a conservative generic profile
 * rather than throwing, because a missing signal must never stall a case.
 */
export function resolveCaseProfile(input: CaseProfileInput): CaseProfile {
  if (input.sourceType === 'checkout_abandonment') {
    return ABANDONMENT_PROFILES[input.abandonmentStage ?? 'cart'] ?? ABANDONMENT_PROFILES.cart!;
  }
  if (input.sourceType === 'overdue_invoice') {
    return overdueProfile(input.daysOverdue ?? 0);
  }
  if (input.failureReason && FAILURE_PROFILES[input.failureReason]) {
    return fromFailureProfile(FAILURE_PROFILES[input.failureReason]);
  }
  return {
    key: 'unclassified',
    category: 'customer_intent',
    label: 'Unclassified revenue loss',
    selfResolving: false,
    baseRecoverability: 0.3,
    optimalDelayHours: 12,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0,
      delayed_retry: 0,
      payment_link: 0.8,
      customer_notification: 0.8,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The loss reason could not be classified from the available signals',
    explanation:
      'No error code or funnel stage was attached to this event. RECLAIM falls back to a conservative prior and prefers low-cost interventions until more evidence arrives.',
  };
}
