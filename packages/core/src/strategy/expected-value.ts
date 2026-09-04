import type { CaseProfile } from '../domain/case-profiles.js';
import {
  HUMAN_RESIDUAL_RECOVERY,
  MAX_STRATEGY_PROBABILITY,
  directCostFor,
  goodwillCostFor,
} from '../domain/intervention-economics.js';
import type { RecoveryStrategy } from '../types/enums.js';
import { RECOVERY_STRATEGIES } from '../types/enums.js';
import { scaleMinor } from '../types/money.js';
import { clamp, round } from '../util/collections.js';

/**
 * EXPECTED RECOVERY VALUE
 *
 * The model tells us how likely this money is to come back *if we act well*. It does not
 * tell us which action, or whether acting is worth it at all. That is this module's job,
 * and it is deliberately pure arithmetic — no model, no LLM, fully reproducible, and
 * unit-tested to the rupee.
 *
 *   P(strategy)  = P(recoverable) x lift(strategy | failure class) x delay decay
 *   EV(strategy) = P(strategy) x amount at risk
 *                  - direct cost
 *                  - goodwill cost (escalating with prior contact)
 *
 * `stop_recovery` always scores exactly zero, which gives every other option a hard
 * hurdle to clear. An engine that cannot choose to do nothing will always find a reason
 * to spend money.
 */

export interface ExpectedValueInput {
  strategy: RecoveryStrategy;
  amountAtRiskMinor: number;
  /** Model output: probability this loss is recoverable given a well-chosen action. */
  recoveryProbability: number;
  profile: CaseProfile;
  /** Messages already sent on this case; drives the escalating goodwill cost. */
  priorContactCount: number;
  /** Retries already spent; used to damp the odds of yet another attempt. */
  priorAttemptCount: number;
}

export interface ExpectedValueBreakdown {
  strategy: RecoveryStrategy;
  successProbability: number;
  grossRecoveryMinor: number;
  directCostMinor: number;
  goodwillCostMinor: number;
  interventionCostMinor: number;
  expectedValueMinor: number;
  delayHours: number;
  /** Multiplier applied for waiting; below 1 because delayed money can evaporate. */
  delayDecay: number;
  liftApplied: number;
}

/**
 * Every hour of delay carries a small risk that the customer churns, cancels, or buys
 * elsewhere. Modelled as a linear decay with a floor, because a floor is honest: waiting
 * three days does not make recovery impossible, it just makes it worse.
 */
export function delayDecayFactor(delayHours: number): number {
  return clamp(1 - 0.0018 * delayHours, 0.82, 1);
}

/**
 * Repeated attempts on the same case yield less each time — the easy failures have
 * already been cleared out by the earlier attempts.
 */
export function attemptFatigue(priorAttemptCount: number): number {
  return clamp(Math.pow(0.72, Math.max(0, priorAttemptCount)), 0.25, 1);
}

export function delayHoursFor(strategy: RecoveryStrategy, profile: CaseProfile): number {
  switch (strategy) {
    case 'immediate_retry':
      return 0;
    case 'delayed_retry':
      return profile.optimalDelayHours > 0 ? profile.optimalDelayHours : 6;
    case 'payment_link':
      return 0;
    case 'customer_notification':
      return 0;
    case 'escalate':
      return 4;
    case 'stop_recovery':
      return 0;
  }
}

export function successProbabilityFor(input: ExpectedValueInput): number {
  if (input.strategy === 'stop_recovery') return 0;

  const delayHours = delayHoursFor(input.strategy, input.profile);
  const decay = delayDecayFactor(delayHours);
  const fatigue = attemptFatigue(input.priorAttemptCount);

  if (input.strategy === 'escalate') {
    // A human does the best automated thing available, and then adds judgement on top of
    // whatever that would have missed. Computing the automated ceiling from the fully
    // priced strategies — each with its own delay decay — rather than from raw lifts is
    // what keeps escalation from looking attractive on cases automation already handles.
    const automatedStrategies: RecoveryStrategy[] = [
      'immediate_retry',
      'delayed_retry',
      'payment_link',
      'customer_notification',
    ];
    const bestAutomated = Math.max(
      0,
      ...automatedStrategies.map((strategy) =>
        successProbabilityFor({ ...input, strategy }),
      ),
    );
    return clamp(
      round(bestAutomated + (1 - bestAutomated) * HUMAN_RESIDUAL_RECOVERY),
      0,
      MAX_STRATEGY_PROBABILITY,
    );
  }

  const lift = input.profile.strategyLift[input.strategy] ?? 0;
  return clamp(
    round(input.recoveryProbability * lift * decay * fatigue),
    0,
    MAX_STRATEGY_PROBABILITY,
  );
}

export function expectedValue(input: ExpectedValueInput): ExpectedValueBreakdown {
  const delayHours = delayHoursFor(input.strategy, input.profile);
  const successProbability = successProbabilityFor(input);
  const grossRecoveryMinor = scaleMinor(input.amountAtRiskMinor, successProbability);
  const directCostMinor = directCostFor(input.strategy);
  const goodwillCostMinor = goodwillCostFor(input.strategy, input.priorContactCount);
  const interventionCostMinor = directCostMinor + goodwillCostMinor;

  return {
    strategy: input.strategy,
    successProbability,
    grossRecoveryMinor,
    directCostMinor,
    goodwillCostMinor,
    interventionCostMinor,
    expectedValueMinor: grossRecoveryMinor - interventionCostMinor,
    delayHours,
    delayDecay: round(delayDecayFactor(delayHours)),
    liftApplied:
      input.strategy === 'stop_recovery' ? 0 : round(input.profile.strategyLift[input.strategy] ?? 0),
  };
}

/** Price every strategy in the bounded action space, highest expected value first. */
export function evaluateAllStrategies(
  base: Omit<ExpectedValueInput, 'strategy'>,
): ExpectedValueBreakdown[] {
  return RECOVERY_STRATEGIES.map((strategy) => expectedValue({ ...base, strategy })).sort(
    (a, b) => b.expectedValueMinor - a.expectedValueMinor,
  );
}
