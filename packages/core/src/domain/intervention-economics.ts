import type { RecoveryStrategy } from '../types/enums.js';

/**
 * What each intervention costs to run, in integer paise.
 *
 * These numbers are the difference between a recovery engine and a retry loop: an action
 * is only worth taking when the money it is expected to bring back exceeds what it costs
 * to take, including the cost of irritating a customer who has already been messaged twice.
 */
export interface InterventionCost {
  strategy: RecoveryStrategy;
  /** Direct operating cost: gateway attempt fee, message delivery, human minutes. */
  directCostMinor: number;
  /**
   * Goodwill charged on the *first* use. Escalates with repeated contact via
   * `goodwillEscalationMinor`, which is what stops the engine from spamming.
   */
  baseGoodwillCostMinor: number;
  goodwillEscalationMinor: number;
  label: string;
  description: string;
  /** Whether executing this strategy moves money through the payment provider. */
  movesMoney: boolean;
}

export const INTERVENTION_COSTS: Record<RecoveryStrategy, InterventionCost> = {
  immediate_retry: {
    strategy: 'immediate_retry',
    directCostMinor: 250,
    // Zero goodwill, at any prior contact count. A retry is invisible to the customer,
    // so charging it against messages already sent would price an unrelated cost into
    // it. The declining value of repeated attempts is modelled where it belongs — in
    // `attemptFatigue`, which lowers the success probability rather than raising the cost.
    baseGoodwillCostMinor: 0,
    goodwillEscalationMinor: 0,
    label: 'Immediate retry',
    description:
      'Re-present the same authorisation straight away. Cheapest possible action and invisible to the customer, but it repeats whatever condition caused the decline.',
    movesMoney: true,
  },
  delayed_retry: {
    strategy: 'delayed_retry',
    directCostMinor: 250,
    baseGoodwillCostMinor: 0,
    goodwillEscalationMinor: 0,
    label: 'Delayed retry',
    description:
      'Schedule the retry for the window in which the blocking condition has most likely cleared. Same cost as an immediate retry, materially better odds on funding and infrastructure failures.',
    movesMoney: true,
  },
  payment_link: {
    strategy: 'payment_link',
    directCostMinor: 900,
    baseGoodwillCostMinor: 1_200,
    goodwillEscalationMinor: 1_800,
    label: 'Payment link',
    description:
      'Issue a fresh hosted payment page so the customer can pay with any instrument. The only path that works when the stored instrument is structurally dead.',
    movesMoney: true,
  },
  customer_notification: {
    strategy: 'customer_notification',
    directCostMinor: 350,
    baseGoodwillCostMinor: 900,
    goodwillEscalationMinor: 2_400,
    label: 'Customer notification',
    description:
      'Tell the customer what happened and what to do about it. Low direct cost, but goodwill cost rises steeply with every additional message.',
    movesMoney: false,
  },
  escalate: {
    strategy: 'escalate',
    directCostMinor: 18_000,
    baseGoodwillCostMinor: 0,
    goodwillEscalationMinor: 0,
    label: 'Human escalation',
    description:
      'Route to a human operator. Roughly twelve minutes of analyst time, which only pays for itself on large balances or genuinely ambiguous cases.',
    movesMoney: false,
  },
  stop_recovery: {
    strategy: 'stop_recovery',
    directCostMinor: 0,
    baseGoodwillCostMinor: 0,
    goodwillEscalationMinor: 0,
    label: 'Stop recovery',
    description:
      'Close the case without further action. Always available, always costs nothing, and is the correct answer whenever every other option has negative expected value.',
    movesMoney: false,
  },
};

/**
 * What a human operator adds, expressed as the share of the cases automation would have
 * MISSED that they nonetheless recover.
 *
 * Modelling this as a residual rather than as a multiplier over the automated ceiling
 * matters, and the difference is not cosmetic. A multiplier says a human is 35% better at
 * everything, which produces the absurd conclusion that a routine insufficient-funds
 * decline — where the textbook answer is "wait three days and retry" and a human would do
 * exactly that — is worth twelve minutes of analyst time. A residual says what is actually
 * true: where automation is already going to succeed, a human adds almost nothing; where
 * automation is stuck, a human can negotiate, correct bad data, or reach the customer
 * directly, and that is worth paying for.
 */
export const HUMAN_RESIDUAL_RECOVERY = 0.22;

/** Ceiling on any single strategy's success probability. Nothing is ever certain. */
export const MAX_STRATEGY_PROBABILITY = 0.94;

/**
 * Goodwill cost for the Nth contact on a case. The first message is cheap; the third is
 * expensive enough to make stopping the rational choice on small balances.
 *
 * `priorContactCount` is messages already sent, so only customer-facing strategies can
 * accrue it. Silent retries return zero however many messages preceded them.
 */
export function goodwillCostFor(strategy: RecoveryStrategy, priorContactCount: number): number {
  const cost = INTERVENTION_COSTS[strategy];
  if (cost.baseGoodwillCostMinor === 0 && cost.goodwillEscalationMinor === 0) return 0;
  return cost.baseGoodwillCostMinor + cost.goodwillEscalationMinor * Math.max(0, priorContactCount);
}

export function directCostFor(strategy: RecoveryStrategy): number {
  return INTERVENTION_COSTS[strategy].directCostMinor;
}

export function totalInterventionCost(strategy: RecoveryStrategy, priorContactCount: number): number {
  return directCostFor(strategy) + goodwillCostFor(strategy, priorContactCount);
}

/** Strategies that put a charge through the provider and therefore need idempotency. */
export function movesMoney(strategy: RecoveryStrategy): boolean {
  return INTERVENTION_COSTS[strategy].movesMoney;
}
