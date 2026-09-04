import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { Reasoner, RecommendationOutput } from '../llm/reasoner.js';
import type { ReasonerIdentity } from '../llm/types.js';
import type { CaseContext } from '../services/context-service.js';
import {
  type StrategyEvaluation,
  evaluateStrategies,
  recommendationConfidence,
} from '../strategy/strategy-engine.js';
import type { StrategyCandidate } from '../types/decisions.js';
import type { RecoveryStrategy } from '../types/enums.js';
import { formatMinor } from '../types/money.js';

/**
 * THE STRATEGY AGENT
 *
 * Decides what to do about a diagnosed case. The division of labour with the reasoner is
 * strict and deliberate:
 *
 *   The ENGINE computes. Success probability per strategy, gross recovery, intervention
 *   cost, goodwill cost, expected value, structural eligibility — all arithmetic, all
 *   reproducible, all unit-tested.
 *
 *   The REASONER chooses among what the engine priced, and explains the choice. It can
 *   depart from the expected-value winner when the facts justify it — that is the whole
 *   reason to have a reasoning layer — but it can only pick something the engine marked
 *   available, and any departure is recorded as such so a reviewer sees it happened.
 *
 * The result is a recommendation, not an authorisation. The policy engine still gets the
 * final say downstream, and can refuse.
 */

export interface StrategyDecision {
  evaluation: StrategyEvaluation;
  candidates: StrategyCandidate[];
  /** What the expected-value engine would have chosen on its own. */
  economicChoice: RecoveryStrategy;
  /** What the agent actually recommends. */
  recommendedStrategy: RecoveryStrategy;
  selectedCandidate: StrategyCandidate;
  expectedValueMinor: number;
  successProbability: number;
  explanation: string;
  risks: string[];
  confidence: number;
  reasoner: ReasonerIdentity;
  /** Populated when the reasoner overrode the economic winner. */
  overrode: { from: RecoveryStrategy; to: RecoveryStrategy; costMinor: number } | null;
  latencyMs: number;
}

export interface StrategyAgentOptions {
  reasoner: Reasoner;
  logger?: Logger;
}

export class StrategyAgent {
  readonly id = 'agent:recovery_strategist';

  private readonly reasoner: Reasoner;
  private readonly logger: Logger;

  constructor(options: StrategyAgentOptions) {
    this.reasoner = options.reasoner;
    this.logger = options.logger ?? noopLogger;
  }

  /** Price the bounded action space for a case. Pure; no side effects, no I/O. */
  evaluate(context: CaseContext, recoveryProbability: number): StrategyEvaluation {
    return evaluateStrategies({
      amountAtRiskMinor: context.recoveryCase.amountAtRiskMinor,
      recoveryProbability,
      profile: context.profile,
      priorContactCount: context.recoveryCase.notificationCount,
      priorAttemptCount: context.recoveryCase.attemptCount,
      constraints: {
        contactOptOut: context.customer.contactOptOut,
        doNotRetry: context.customer.doNotRetry,
        mandateActive: context.mandateActive !== false,
        hasContactChannel: Boolean(context.customer.email || context.customer.phone),
        retryableSource:
          context.recoveryCase.sourceType === 'payment_failure' ||
          context.recoveryCase.sourceType === 'subscription_dunning',
      },
    });
  }

  async decide(input: {
    context: CaseContext;
    recoveryProbability: number;
    diagnosis: Parameters<Reasoner['recommend']>[0]['diagnosis'];
  }): Promise<StrategyDecision> {
    const started = Date.now();
    const { context, recoveryProbability } = input;

    const evaluation = this.evaluate(context, recoveryProbability);
    const economicChoice = evaluation.best.strategy;

    let recommendation: RecommendationOutput;
    let identity: ReasonerIdentity;

    try {
      const result = await this.reasoner.recommend({
        facts: {
          amountAtRisk: formatMinor(context.recoveryCase.amountAtRiskMinor, { whole: true }),
          failureLabel: context.profile.label,
          failureCategory: context.profile.category,
          sourceType: context.recoveryCase.sourceType.replace(/_/g, ' '),
          method: context.recoveryCase.method,
          issuer: context.issuer,
          customerName: context.customer.name,
          customerSegment: context.customer.segment,
          successfulPayments: context.features.successfulPaymentCount,
          failedPayments: context.features.failedPaymentCount,
          lifetimeValue: formatMinor(context.features.lifetimeValueMinor, { whole: true }),
          isSubscriber: context.features.isSubscriber,
          subscriptionAgeDays: context.features.subscriptionAgeDays,
          priorRecoveryAttempts: context.features.priorRecoveryAttempts,
          priorRecoverySuccesses: context.features.priorRecoverySuccesses,
          hoursSinceFailure: context.hoursSinceEvent,
          hasAlternateMethod: context.features.hasAlternateSuccessfulMethod,
          consecutiveFailures: context.features.consecutiveFailures,
          recoveryProbability,
        },
        diagnosis: input.diagnosis,
        candidates: evaluation.candidates,
        economicChoice,
        formattedCandidates: formatCandidateTable(evaluation.candidates),
      });
      recommendation = result.output;
      identity = result.identity;
    } catch (error) {
      // The reasoner contract says this cannot happen, but a recommendation must exist
      // whatever goes wrong upstream: fall back to the arithmetic.
      this.logger.error('strategy reasoner failed; using expected-value winner', error);
      recommendation = {
        strategy: economicChoice,
        explanation: evaluation.best.rationale,
        risks: [],
        confidence: recommendationConfidence(evaluation.candidates),
      };
      identity = {
        id: 'expected-value-engine',
        kind: 'deterministic',
        model: 'expected-value-only',
        degraded: true,
        degradedReason: 'reasoning layer unavailable; expected-value winner used directly',
      };
    }

    // The reasoner is only allowed to name an available strategy; `LlmReasoner` already
    // enforces this, and we re-check here so the guarantee does not depend on which
    // reasoner implementation happens to be wired in.
    const selectedCandidate =
      evaluation.candidates.find(
        (c) => c.strategy === recommendation.strategy && c.eligible,
      ) ?? evaluation.best;

    const overrode =
      selectedCandidate.strategy === economicChoice
        ? null
        : {
            from: economicChoice,
            to: selectedCandidate.strategy,
            costMinor: evaluation.best.expectedValueMinor - selectedCandidate.expectedValueMinor,
          };

    if (overrode) {
      this.logger.info('reasoner departed from the expected-value winner', {
        caseId: context.recoveryCase.id,
        from: overrode.from,
        to: overrode.to,
        expectedValueGivenUpMinor: overrode.costMinor,
      });
    }

    return {
      evaluation,
      candidates: evaluation.candidates,
      economicChoice,
      recommendedStrategy: selectedCandidate.strategy,
      selectedCandidate,
      expectedValueMinor: selectedCandidate.expectedValueMinor,
      successProbability: selectedCandidate.successProbability,
      explanation: recommendation.explanation,
      risks: recommendation.risks,
      // Blend the reasoner's stated confidence with how clear-cut the economics are.
      confidence: Number(
        (
          0.5 * recommendation.confidence +
          0.5 * recommendationConfidence(evaluation.candidates)
        ).toFixed(3),
      ),
      reasoner: identity,
      overrode,
      latencyMs: Date.now() - started,
    };
  }
}

/** Render the priced options as a compact table for the reasoning prompt. */
export function formatCandidateTable(candidates: readonly StrategyCandidate[]): string {
  const rows = candidates.map((c) => {
    const availability = c.eligible ? 'AVAILABLE' : `UNAVAILABLE — ${c.ineligibleReason ?? 'n/a'}`;
    return [
      `${c.strategy}:`,
      `  success probability ${(c.successProbability * 100).toFixed(1)}%`,
      `  gross recovery ${formatMinor(c.grossRecoveryMinor)}`,
      `  cost ${formatMinor(c.interventionCostMinor + c.goodwillCostMinor)} (${formatMinor(c.interventionCostMinor)} direct + ${formatMinor(c.goodwillCostMinor)} goodwill)`,
      `  EXPECTED VALUE ${formatMinor(c.expectedValueMinor)}`,
      `  delay ${c.delayHours}h`,
      `  ${availability}`,
    ].join('\n');
  });
  return rows.join('\n\n');
}
