import type { FailureDiagnosis } from '../types/decisions.js';
import type { FailureReason, PaymentMethod, RecoveryStrategy } from '../types/enums.js';

/**
 * The failure taxonomy is the single source of domain truth in RECLAIM.
 *
 * It is deliberately shared by three consumers that must agree with each other:
 *   1. the synthetic data generator, which samples real outcomes from these profiles,
 *   2. the diagnosis engine, which explains a failure to a human,
 *   3. the strategy engine, which prices each intervention.
 *
 * Because all three read the same table, the explanation a merchant sees is a faithful
 * description of the process that actually generated the outcome — the model is learning
 * a real signal, not a decorative one.
 */

export type FailureCategory = FailureDiagnosis['category'];

export interface FailureProfile {
  reason: FailureReason;
  category: FailureCategory;
  /** Human-readable label used in charts and tables. */
  label: string;
  /** Bank/gateway error code shown alongside the reason, matching Razorpay conventions. */
  errorCode: string;
  /**
   * Probability that the underlying blocker clears on its own within a few days
   * (a topped-up balance, a bank coming back online) with no customer action.
   */
  selfResolving: boolean;
  /**
   * Base probability that this failure is recoverable at all, before any customer-level
   * evidence is considered. This is the prior the model starts from.
   */
  baseRecoverability: number;
  /** Hours to wait before a retry has its best chance. 0 means retry immediately. */
  optimalDelayHours: number;
  /** The customer must do something (new card, top-up, re-auth) for recovery to happen. */
  customerActionRequired: boolean;
  /** Structural gates. A revoked mandate cannot be retried at all, at any price. */
  retryPossible: boolean;
  paymentLinkPossible: boolean;
  /** Effectiveness of each strategy relative to `baseRecoverability`, in [0, 1.2]. */
  strategyLift: Record<RecoveryStrategy, number>;
  headline: string;
  explanation: string;
  /** Methods on which this failure can occur, used by the data generator. */
  methods: readonly PaymentMethod[];
}

const ALL_METHODS: readonly PaymentMethod[] = ['card', 'upi', 'netbanking', 'wallet', 'emi', 'nach'];

/**
 * `escalate` and `stop_recovery` never "recover" money directly, so their lift is 0 here.
 * Their value is priced separately by the expected-value engine: escalation routes to a
 * human who may recover the money, and stopping preserves goodwill and cost.
 */
const NO_DIRECT_LIFT = { escalate: 0, stop_recovery: 0 } as const;

export const FAILURE_PROFILES: Record<FailureReason, FailureProfile> = {
  insufficient_funds: {
    reason: 'insufficient_funds',
    category: 'funding',
    label: 'Insufficient funds',
    errorCode: 'BAD_REQUEST_ERROR:insufficient_funds',
    selfResolving: true,
    baseRecoverability: 0.62,
    optimalDelayHours: 72,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.28,
      delayed_retry: 1.0,
      payment_link: 0.74,
      customer_notification: 0.66,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The account did not have enough balance at the moment of capture',
    explanation:
      'Balance-driven declines are the most recoverable class of failure. The instrument is valid and the customer intends to pay; only the timing was wrong. Retrying immediately repeats the same decline, so value comes from waiting for the account to be funded — typically around salary or billing cycles.',
    methods: ['card', 'upi', 'netbanking', 'wallet', 'emi', 'nach'],
  },
  card_expired: {
    reason: 'card_expired',
    category: 'instrument',
    label: 'Card expired',
    errorCode: 'BAD_REQUEST_ERROR:card_expired',
    selfResolving: false,
    baseRecoverability: 0.54,
    optimalDelayHours: 0,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.02,
      delayed_retry: 0.03,
      payment_link: 1.0,
      customer_notification: 0.82,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The stored card is past its expiry date and can never be charged again',
    explanation:
      'No number of retries can succeed against an expired card — the instrument itself is dead. Recovery requires the customer to supply new credentials, so the only interventions with positive expected value are a payment link or a notification that drives an instrument update.',
    methods: ['card', 'emi'],
  },
  do_not_honour: {
    reason: 'do_not_honour',
    category: 'risk',
    label: 'Do not honour',
    errorCode: 'GATEWAY_ERROR:do_not_honour',
    selfResolving: true,
    baseRecoverability: 0.41,
    optimalDelayHours: 24,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.34,
      delayed_retry: 0.92,
      payment_link: 1.0,
      customer_notification: 0.58,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The issuing bank declined without stating a reason',
    explanation:
      'A generic issuer decline hides several underlying causes: soft fraud rules, velocity limits, or a temporary block. A moderate delay lets issuer counters reset, and switching the customer to a fresh authorisation through a payment link often clears the block outright.',
    methods: ['card', 'emi', 'netbanking'],
  },
  incorrect_cvv: {
    reason: 'incorrect_cvv',
    category: 'authentication',
    label: 'Incorrect CVV',
    errorCode: 'BAD_REQUEST_ERROR:incorrect_cvv',
    selfResolving: false,
    baseRecoverability: 0.58,
    optimalDelayHours: 0,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.04,
      delayed_retry: 0.04,
      payment_link: 1.0,
      customer_notification: 0.71,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The security code entered did not match the card',
    explanation:
      'A data-entry failure, not a funding failure. Retrying the same stored parameters reproduces the same rejection; the customer must re-enter their details, which a payment link is purpose-built for.',
    methods: ['card', 'emi'],
  },
  payment_timeout: {
    reason: 'payment_timeout',
    category: 'infrastructure',
    label: 'Payment timeout',
    errorCode: 'GATEWAY_ERROR:payment_timeout',
    selfResolving: true,
    baseRecoverability: 0.71,
    optimalDelayHours: 1,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.86,
      delayed_retry: 1.0,
      payment_link: 0.62,
      customer_notification: 0.34,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The authorisation never returned within the gateway window',
    explanation:
      'Timeouts usually reflect transient congestion rather than customer intent. They carry the highest recovery rate of any class, and a short delayed retry outperforms an immediate one because it lets the congested leg drain.',
    methods: ALL_METHODS,
  },
  gateway_error: {
    reason: 'gateway_error',
    category: 'infrastructure',
    label: 'Gateway error',
    errorCode: 'GATEWAY_ERROR:server_error',
    selfResolving: true,
    baseRecoverability: 0.68,
    optimalDelayHours: 2,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.74,
      delayed_retry: 1.0,
      payment_link: 0.58,
      customer_notification: 0.3,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The payment gateway returned an internal error',
    explanation:
      'The transaction never reached a decision. Because no issuer rule was triggered, the same parameters normally succeed once the upstream fault clears, making a bounded delayed retry the cheapest effective intervention.',
    methods: ALL_METHODS,
  },
  bank_downtime: {
    reason: 'bank_downtime',
    category: 'infrastructure',
    label: 'Bank downtime',
    errorCode: 'GATEWAY_ERROR:bank_downtime',
    selfResolving: true,
    baseRecoverability: 0.77,
    optimalDelayHours: 6,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.24,
      delayed_retry: 1.0,
      payment_link: 0.52,
      customer_notification: 0.28,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The issuing bank was unavailable during the attempt',
    explanation:
      'Scheduled and unscheduled bank outages produce clustered failures across many customers at once. Retrying during the outage window simply burns attempts; the correct action is to wait for the window to close, which is why this class carries the highest base recoverability in the taxonomy.',
    methods: ['card', 'upi', 'netbanking', 'nach', 'emi'],
  },
  risk_declined_by_bank: {
    reason: 'risk_declined_by_bank',
    category: 'risk',
    label: 'Declined by bank risk engine',
    errorCode: 'BAD_REQUEST_ERROR:payment_declined_by_bank',
    selfResolving: false,
    baseRecoverability: 0.22,
    optimalDelayHours: 48,
    customerActionRequired: true,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.12,
      delayed_retry: 0.44,
      payment_link: 0.78,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The bank fraud engine blocked the transaction',
    explanation:
      'Risk declines rarely clear through retries: repeated attempts reinforce the bank velocity signal that caused the block. Recovery depends on the customer authorising through a different route or contacting their bank, so notification outperforms automation here.',
    methods: ['card', 'netbanking', 'emi'],
  },
  international_not_allowed: {
    reason: 'international_not_allowed',
    category: 'instrument',
    label: 'International transactions disabled',
    errorCode: 'BAD_REQUEST_ERROR:international_transaction_not_allowed',
    selfResolving: false,
    baseRecoverability: 0.31,
    optimalDelayHours: 0,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      // A card-level control the merchant cannot change: waiting does not lift it.
      immediate_retry: 0.03,
      delayed_retry: 0.04,
      payment_link: 0.84,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The card is not enabled for international transactions',
    explanation:
      'A card-level control the merchant cannot change. The customer must either enable international usage with their bank or pay with a domestic instrument, both of which need a message rather than a retry.',
    methods: ['card'],
  },
  mandate_revoked: {
    reason: 'mandate_revoked',
    category: 'mandate',
    label: 'Mandate revoked',
    errorCode: 'BAD_REQUEST_ERROR:mandate_revoked',
    selfResolving: false,
    baseRecoverability: 0.19,
    optimalDelayHours: 0,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.0,
      delayed_retry: 0.0,
      payment_link: 0.88,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The recurring mandate authorising this charge has been cancelled',
    explanation:
      'Without a live mandate there is no legal authority to debit the account, so an automated retry is not merely ineffective — it is impermissible. Recovery requires the customer to re-authorise, which the policy engine enforces as a hard stop on all retry strategies.',
    methods: ['nach', 'upi', 'card'],
  },
  upi_collect_expired: {
    reason: 'upi_collect_expired',
    category: 'customer_intent',
    label: 'UPI collect request expired',
    errorCode: 'BAD_REQUEST_ERROR:upi_collect_expired',
    selfResolving: false,
    baseRecoverability: 0.49,
    optimalDelayHours: 4,
    customerActionRequired: true,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.42,
      delayed_retry: 0.68,
      payment_link: 1.0,
      customer_notification: 0.86,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The customer never approved the collect request before it lapsed',
    explanation:
      'The customer saw the request and did not act, so this is an attention problem rather than a capability problem. A fresh link delivered on the channel the customer actually reads recovers materially better than re-sending the same expired collect flow.',
    methods: ['upi'],
  },
  daily_limit_exceeded: {
    reason: 'daily_limit_exceeded',
    category: 'funding',
    label: 'Daily limit exceeded',
    errorCode: 'BAD_REQUEST_ERROR:payment_limit_exceeded',
    selfResolving: true,
    baseRecoverability: 0.66,
    optimalDelayHours: 26,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.08,
      delayed_retry: 1.0,
      payment_link: 0.7,
      customer_notification: 0.55,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The transaction breached a per-day limit on the instrument',
    explanation:
      'Limits reset on a fixed daily boundary, which makes this the most predictable failure in the taxonomy: a retry scheduled after the reset succeeds at close to the base rate, while any attempt before it is guaranteed to fail.',
    methods: ['upi', 'netbanking', 'card', 'wallet'],
  },
  authentication_failed: {
    reason: 'authentication_failed',
    category: 'authentication',
    label: '3DS authentication failed',
    errorCode: 'BAD_REQUEST_ERROR:payment_authentication_failed',
    selfResolving: false,
    baseRecoverability: 0.47,
    optimalDelayHours: 2,
    customerActionRequired: true,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.3,
      delayed_retry: 0.52,
      payment_link: 1.0,
      customer_notification: 0.74,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The customer did not complete the additional authentication step',
    explanation:
      'The OTP or bank-page step was abandoned or mistyped. Intent is usually intact, so giving the customer a clean second run at authentication — on their own time, through a link — is the highest-yield intervention.',
    methods: ['card', 'netbanking', 'emi'],
  },
  card_blocked: {
    reason: 'card_blocked',
    category: 'instrument',
    label: 'Card blocked',
    errorCode: 'BAD_REQUEST_ERROR:card_blocked',
    selfResolving: false,
    baseRecoverability: 0.17,
    optimalDelayHours: 0,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.01,
      delayed_retry: 0.02,
      payment_link: 0.72,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The card has been blocked by the issuer or the cardholder',
    explanation:
      'A blocked card is typically reported lost, stolen or frozen. The instrument will not come back, and repeated attempts against it can register as suspicious activity, so the only sound path is a different instrument entirely.',
    methods: ['card', 'emi'],
  },
  network_error: {
    reason: 'network_error',
    category: 'infrastructure',
    label: 'Network error',
    errorCode: 'GATEWAY_ERROR:network_error',
    selfResolving: true,
    baseRecoverability: 0.73,
    optimalDelayHours: 1,
    customerActionRequired: false,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.9,
      delayed_retry: 1.0,
      payment_link: 0.55,
      customer_notification: 0.26,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The connection to the processor dropped mid-transaction',
    explanation:
      'A pure transport fault with no issuer decision attached. Retries are cheap and effective, which makes this the one class where an immediate retry is close to optimal.',
    methods: ALL_METHODS,
  },
  invalid_account: {
    reason: 'invalid_account',
    category: 'instrument',
    label: 'Invalid account',
    errorCode: 'BAD_REQUEST_ERROR:invalid_account',
    selfResolving: false,
    baseRecoverability: 0.11,
    optimalDelayHours: 0,
    customerActionRequired: true,
    retryPossible: false,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.0,
      delayed_retry: 0.0,
      payment_link: 0.62,
      customer_notification: 1.0,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The destination account does not exist or is closed',
    explanation:
      'The stored account reference is structurally wrong. Nothing on the merchant side can repair it, and the low base recoverability means most of these cases should be stopped rather than worked.',
    methods: ['netbanking', 'nach', 'upi'],
  },
  wallet_insufficient_balance: {
    reason: 'wallet_insufficient_balance',
    category: 'funding',
    label: 'Wallet balance too low',
    errorCode: 'BAD_REQUEST_ERROR:wallet_insufficient_balance',
    selfResolving: true,
    baseRecoverability: 0.57,
    optimalDelayHours: 12,
    customerActionRequired: true,
    retryPossible: true,
    paymentLinkPossible: true,
    strategyLift: {
      immediate_retry: 0.16,
      delayed_retry: 0.62,
      payment_link: 1.0,
      customer_notification: 0.79,
      ...NO_DIRECT_LIFT,
    },
    headline: 'The wallet did not hold enough balance to cover the amount',
    explanation:
      'Wallets are topped up manually, so unlike a bank account the balance does not refill on a predictable cycle. Prompting the customer with an alternative instrument beats waiting for a top-up that may never come.',
    methods: ['wallet'],
  },
};

export const FAILURE_REASON_LIST = Object.values(FAILURE_PROFILES);

export function getFailureProfile(reason: FailureReason): FailureProfile {
  return FAILURE_PROFILES[reason];
}

/** Failure reasons that can occur on a given instrument, for realistic data generation. */
export function failureReasonsForMethod(method: PaymentMethod): FailureProfile[] {
  return FAILURE_REASON_LIST.filter((p) => p.methods.includes(method));
}

/** Structural gate consulted by the policy engine before any retry is even priced. */
export function retryIsStructurallyPossible(reason: FailureReason | null): boolean {
  if (!reason) return true;
  return FAILURE_PROFILES[reason].retryPossible;
}

export function categoryOf(reason: FailureReason | null): FailureCategory {
  return reason ? FAILURE_PROFILES[reason].category : 'customer_intent';
}
