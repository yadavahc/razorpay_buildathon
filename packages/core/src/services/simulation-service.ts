import { resolveCaseProfile } from '../domain/case-profiles.js';
import { totalInterventionCost } from '../domain/intervention-economics.js';
import { evaluateStrategies } from '../strategy/strategy-engine.js';
import type { RecoveryStrategy } from '../types/enums.js';
import type { DataStore } from '../store/types.js';
import { createRng } from '../util/rng.js';
import { round } from '../util/collections.js';
import type { ContextService } from './context-service.js';
import type { PredictionService } from './prediction-service.js';

/**
 * THE STRATEGY SIMULATOR
 *
 * Replays the open case portfolio under different recovery policies and reports what each
 * would have produced. This is how a merchant answers "should we be retrying everything?"
 * with a number instead of an opinion.
 *
 * Honesty about what this is: outcomes are *sampled*, not observed. For each case and
 * policy, the simulator takes the model's recovery probability, applies the strategy lift
 * from the failure taxonomy, and draws against it with a seeded generator. That is a
 * counterfactual, and it inherits whatever error the model has. What makes it useful
 * rather than decorative is that the same probability drives the live demo provider, so a
 * simulated policy and a real batch run agree with each other — and the seed makes every
 * comparison reproducible, so two policies are always judged on identical draws.
 */

export type PolicyName =
  | 'reclaim_optimal'
  | 'always_retry'
  | 'always_notify'
  | 'retry_then_link'
  | 'never_intervene'
  | 'threshold_only';

export interface SimulationPolicy {
  name: PolicyName;
  label: string;
  description: string;
  /** Choose a strategy for a case given its priced options. */
  choose: (input: {
    candidates: ReturnType<typeof evaluateStrategies>['candidates'];
    probability: number;
    amountMinor: number;
    threshold: number;
  }) => RecoveryStrategy;
}

export const SIMULATION_POLICIES: SimulationPolicy[] = [
  {
    name: 'reclaim_optimal',
    label: 'RECLAIM (expected value)',
    description:
      'Picks the highest expected-value option among those structurally available, and stops when nothing clears zero. This is what the live engine does.',
    choose: ({ candidates }) =>
      candidates
        .filter((c) => c.eligible)
        .reduce((a, b) => (b.expectedValueMinor > a.expectedValueMinor ? b : a)).strategy,
  },
  {
    name: 'always_retry',
    label: 'Retry everything',
    description:
      'The naive dunning baseline: retry every failure regardless of cause or economics. Cheap per attempt, but it burns attempts on failures that can never clear.',
    choose: ({ candidates }) => {
      const retry = candidates.find((c) => c.strategy === 'delayed_retry' && c.eligible);
      return retry ? 'delayed_retry' : 'stop_recovery';
    },
  },
  {
    name: 'always_notify',
    label: 'Message everyone',
    description:
      'Send every affected customer a notification. Reaches cases a retry cannot, but pays goodwill cost on every single case including the ones that would have self-resolved.',
    choose: ({ candidates }) => {
      const notify = candidates.find((c) => c.strategy === 'customer_notification' && c.eligible);
      return notify ? 'customer_notification' : 'stop_recovery';
    },
  },
  {
    name: 'retry_then_link',
    label: 'Retry, else payment link',
    description:
      'A sensible hand-written rule: retry when the instrument still works, otherwise send a link. No economics, but it respects structural feasibility.',
    choose: ({ candidates }) => {
      const retry = candidates.find((c) => c.strategy === 'delayed_retry' && c.eligible);
      if (retry) return 'delayed_retry';
      const link = candidates.find((c) => c.strategy === 'payment_link' && c.eligible);
      return link ? 'payment_link' : 'stop_recovery';
    },
  },
  {
    name: 'threshold_only',
    label: 'Model threshold only',
    description:
      'Act on any case the model scores above its operating threshold, using the best available strategy; ignore cost entirely. Shows what the model is worth without the economics layer.',
    choose: ({ candidates, probability, threshold }) => {
      if (probability < threshold) return 'stop_recovery';
      const actionable = candidates.filter(
        (c) => c.eligible && c.strategy !== 'stop_recovery' && c.strategy !== 'escalate',
      );
      if (actionable.length === 0) return 'stop_recovery';
      return actionable.reduce((a, b) => (b.successProbability > a.successProbability ? b : a))
        .strategy;
    },
  },
  {
    name: 'never_intervene',
    label: 'Do nothing',
    description:
      'The control. Recovers only what would have come back on its own, and spends nothing. Any policy that cannot beat this is destroying value.',
    choose: () => 'stop_recovery',
  },
];

export interface PolicySimulationResult {
  policy: PolicyName;
  label: string;
  description: string;
  casesEvaluated: number;
  interventions: number;
  /** Cases the policy chose to leave alone. */
  abstentions: number;
  recoveredCount: number;
  recoveredMinor: number;
  interventionCostMinor: number;
  netValueMinor: number;
  recoveryRate: number;
  /** Recovered amount per rupee of intervention cost. */
  returnOnSpend: number;
  amountAtRiskMinor: number;
  averageAttemptsPerCase: number;
  strategyMix: Array<{ strategy: RecoveryStrategy; count: number; share: number }>;
}

export interface SimulationReport {
  seed: number;
  casesEvaluated: number;
  amountAtRiskMinor: number;
  results: PolicySimulationResult[];
  /** The policy with the highest net value, and by how much it beats doing nothing. */
  winner: { policy: PolicyName; netValueMinor: number; upliftOverControlMinor: number };
  durationMs: number;
}

interface SimulationCase {
  caseId: string;
  amountMinor: number;
  probability: number;
  candidates: ReturnType<typeof evaluateStrategies>['candidates'];
  priorContacts: number;
  priorAttempts: number;
}

export class SimulationService {
  constructor(
    private readonly store: DataStore,
    private readonly context: ContextService,
    private readonly prediction: PredictionService,
  ) {}

  /**
   * Build the evaluation set once, then run every policy against it. Sharing the set is
   * what makes the comparison fair: each policy faces the same cases with the same
   * probabilities and the same random draws.
   */
  async run(
    merchantId: string,
    options: { limit?: number; seed?: number; policies?: PolicyName[] } = {},
  ): Promise<SimulationReport> {
    const started = Date.now();
    const seed = options.seed ?? 424242;
    const limit = options.limit ?? 400;

    const cases = await this.store.cases.list({
      where: [{ field: 'merchantId', op: '==', value: merchantId }],
    });
    const sample = cases.slice(0, limit);

    const evaluationSet: SimulationCase[] = [];
    for (const recoveryCase of sample) {
      try {
        const context = await this.context.buildContextForCase(recoveryCase);
        const probability =
          recoveryCase.recoveryProbability ?? this.prediction.predict(context.modelInput).probability;

        const evaluation = evaluateStrategies({
          amountAtRiskMinor: recoveryCase.amountAtRiskMinor,
          recoveryProbability: probability,
          profile: context.profile,
          priorContactCount: recoveryCase.notificationCount,
          priorAttemptCount: recoveryCase.attemptCount,
          constraints: {
            contactOptOut: context.customer.contactOptOut,
            doNotRetry: context.customer.doNotRetry,
            mandateActive: context.mandateActive !== false,
            hasContactChannel: Boolean(context.customer.email || context.customer.phone),
            retryableSource:
              recoveryCase.sourceType === 'payment_failure' ||
              recoveryCase.sourceType === 'subscription_dunning',
          },
        });

        evaluationSet.push({
          caseId: recoveryCase.id,
          amountMinor: recoveryCase.amountAtRiskMinor,
          probability,
          candidates: evaluation.candidates,
          priorContacts: recoveryCase.notificationCount,
          priorAttempts: recoveryCase.attemptCount,
        });
      } catch {
        // A case whose context cannot be built is skipped rather than aborting the run.
        continue;
      }
    }

    const selected = options.policies
      ? SIMULATION_POLICIES.filter((p) => options.policies!.includes(p.name))
      : SIMULATION_POLICIES;

    const threshold = this.prediction.threshold;
    const results = selected.map((policy) =>
      this.simulatePolicy(policy, evaluationSet, seed, threshold),
    );

    const control = results.find((r) => r.policy === 'never_intervene');
    const best = results.reduce((a, b) => (b.netValueMinor > a.netValueMinor ? b : a));

    return {
      seed,
      casesEvaluated: evaluationSet.length,
      amountAtRiskMinor: evaluationSet.reduce((sum, c) => sum + c.amountMinor, 0),
      results: results.sort((a, b) => b.netValueMinor - a.netValueMinor),
      winner: {
        policy: best.policy,
        netValueMinor: best.netValueMinor,
        upliftOverControlMinor: best.netValueMinor - (control?.netValueMinor ?? 0),
      },
      durationMs: Date.now() - started,
    };
  }

  private simulatePolicy(
    policy: SimulationPolicy,
    cases: readonly SimulationCase[],
    seed: number,
    threshold: number,
  ): PolicySimulationResult {
    let interventions = 0;
    let abstentions = 0;
    let recoveredCount = 0;
    let recoveredMinor = 0;
    let interventionCostMinor = 0;
    let attempts = 0;
    const strategyCounts = new Map<RecoveryStrategy, number>();

    for (const simulationCase of cases) {
      const strategy = policy.choose({
        candidates: simulationCase.candidates,
        probability: simulationCase.probability,
        amountMinor: simulationCase.amountMinor,
        threshold,
      });
      strategyCounts.set(strategy, (strategyCounts.get(strategy) ?? 0) + 1);

      if (strategy === 'stop_recovery') {
        abstentions += 1;
        continue;
      }

      interventions += 1;
      attempts += 1;
      interventionCostMinor += totalInterventionCost(strategy, simulationCase.priorContacts);

      const candidate = simulationCase.candidates.find((c) => c.strategy === strategy);
      const successProbability = candidate?.successProbability ?? 0;

      // Seeded on the case id, NOT on the policy: every policy faces the identical draw
      // for a given case, so differences in outcome come from the decision, not from luck.
      const draw = createRng(`sim:${seed}:${simulationCase.caseId}`).next();

      // Escalation recovers through a human; the money still arrives, so it counts, but
      // its cost is already the highest in the table.
      if (draw < successProbability) {
        recoveredCount += 1;
        recoveredMinor += simulationCase.amountMinor;
      }
    }

    const totalStrategies = [...strategyCounts.values()].reduce((s, v) => s + v, 0) || 1;
    const amountAtRiskMinor = cases.reduce((sum, c) => sum + c.amountMinor, 0);

    return {
      policy: policy.name,
      label: policy.label,
      description: policy.description,
      casesEvaluated: cases.length,
      interventions,
      abstentions,
      recoveredCount,
      recoveredMinor,
      interventionCostMinor,
      netValueMinor: recoveredMinor - interventionCostMinor,
      recoveryRate: amountAtRiskMinor === 0 ? 0 : round(recoveredMinor / amountAtRiskMinor),
      returnOnSpend:
        interventionCostMinor === 0 ? 0 : round(recoveredMinor / interventionCostMinor, 2),
      amountAtRiskMinor,
      averageAttemptsPerCase: cases.length === 0 ? 0 : round(attempts / cases.length, 2),
      strategyMix: [...strategyCounts.entries()]
        .map(([strategy, count]) => ({
          strategy,
          count,
          share: round(count / totalStrategies),
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Sensitivity analysis: how the optimal policy's net value moves as the expected-value
   * floor is raised. Shows a merchant exactly where their "stop working small cases"
   * threshold should sit.
   */
  async valueFloorSweep(
    merchantId: string,
    options: { limit?: number; seed?: number } = {},
  ): Promise<Array<{ floorMinor: number; interventions: number; netValueMinor: number; recoveredMinor: number }>> {
    const report = await this.run(merchantId, { ...options, policies: ['reclaim_optimal'] });
    const base = report.results[0];
    if (!base) return [];

    const floors = [0, 1_000, 2_000, 5_000, 10_000, 25_000, 50_000];
    const cases = await this.store.cases.list({
      where: [{ field: 'merchantId', op: '==', value: merchantId }],
    });
    const sample = cases.slice(0, options.limit ?? 400);
    const seed = options.seed ?? 424242;

    const rows: Array<{
      floorMinor: number;
      interventions: number;
      netValueMinor: number;
      recoveredMinor: number;
    }> = [];

    for (const floorMinor of floors) {
      let interventions = 0;
      let recoveredMinor = 0;
      let costMinor = 0;

      for (const recoveryCase of sample) {
        const probability = recoveryCase.recoveryProbability ?? 0;
        const expectedValue = recoveryCase.expectedValueMinor ?? 0;
        if (expectedValue < floorMinor) continue;

        interventions += 1;
        const profile = resolveCaseProfile({
          sourceType: recoveryCase.sourceType,
          failureReason: recoveryCase.failureReason,
        });
        const strategy: RecoveryStrategy = profile.retryPossible ? 'delayed_retry' : 'payment_link';
        costMinor += totalInterventionCost(strategy, recoveryCase.notificationCount);

        const lift = profile.strategyLift[strategy] ?? 0;
        const draw = createRng(`sim:${seed}:${recoveryCase.id}`).next();
        if (draw < probability * lift) recoveredMinor += recoveryCase.amountAtRiskMinor;
      }

      rows.push({
        floorMinor,
        interventions,
        recoveredMinor,
        netValueMinor: recoveredMinor - costMinor,
      });
    }

    return rows;
  }
}
