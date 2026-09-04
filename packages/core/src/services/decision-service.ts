import type { RecoveryAnalystAgent } from '../agents/recovery-analyst.js';
import type { StrategyAgent } from '../agents/strategy-agent.js';
import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { AIDecision } from '../types/decisions.js';
import type { RecoveryStrategy } from '../types/enums.js';
import type { DataStore } from '../store/types.js';
import { newId } from '../util/id.js';
import type { ActionExecutor, ExecutionResult } from './action-executor.js';
import { CaseService } from './case-service.js';
import type { CaseContext, ContextService } from './context-service.js';
import type { PredictionService } from './prediction-service.js';

/**
 * THE DECISION PIPELINE
 *
 * One case, end to end:
 *
 *   DETECT   the case already exists (ingestion opened it)
 *   CONTEXT  assemble the customer, their history, and the opportunity graph
 *   PREDICT  score recoverability with the trained model
 *   DIAGNOSE the analyst agent investigates via read-only tools
 *   DECIDE   the strategy agent prices every option and recommends one
 *   RECORD   persist an immutable AI decision record for the inspector
 *   GUARD    the executor runs the policy engine
 *   EXECUTE  the executor acts, with idempotency, retries and fallback
 *   MEASURE  the outcome is recorded against the prediction
 *
 * Each phase is separately observable, and the AI decision record is written *before*
 * execution begins. If the process died mid-execution, the reasoning that led to the
 * action would still be on record — which is the property an auditor actually cares about.
 */

export interface DecisionResult {
  caseId: string;
  aiDecision: AIDecision;
  execution: ExecutionResult | null;
  /** Null when the caller asked for a recommendation without execution. */
  executed: boolean;
  totalLatencyMs: number;
  phases: Array<{ phase: string; ms: number }>;
}

export interface DecisionServiceOptions {
  store: DataStore;
  context: ContextService;
  prediction: PredictionService;
  analyst: RecoveryAnalystAgent;
  /** Deterministic-reasoner analyst used for batch work. Defaults to `analyst`. */
  bulkAnalyst?: RecoveryAnalystAgent;
  strategist: StrategyAgent;
  /** Deterministic-reasoner strategist used for batch work. Defaults to `strategist`. */
  bulkStrategist?: StrategyAgent;
  executor: ActionExecutor;
  logger?: Logger;
}

export interface RunDecisionOptions {
  /** False to produce a recommendation and stop — used by the case detail screen. */
  execute?: boolean;
  /** Force a specific strategy, bypassing the recommendation but not the policy engine. */
  overrideStrategy?: RecoveryStrategy;
  actor?: { kind: 'agent' | 'user' | 'system' | 'scheduler' | 'simulator'; id: string };
  trigger?: string;
  asOfIso?: string;
  /**
   * Run the investigation on the deterministic reasoner rather than the language model.
   * Set automatically by `runBatch`: bulk sweeps produce prose nobody reads, and paying
   * per-case network latency for it is what turns a fast batch into an unusable one.
   */
  bulk?: boolean;
}

export class DecisionService {
  private readonly store: DataStore;
  private readonly context: ContextService;
  private readonly prediction: PredictionService;
  private readonly analyst: RecoveryAnalystAgent;
  private readonly bulkAnalyst: RecoveryAnalystAgent;
  private readonly strategist: StrategyAgent;
  private readonly bulkStrategist: StrategyAgent;
  private readonly executor: ActionExecutor;
  private readonly cases: CaseService;
  private readonly logger: Logger;

  constructor(options: DecisionServiceOptions) {
    this.store = options.store;
    this.context = options.context;
    this.prediction = options.prediction;
    this.analyst = options.analyst;
    this.bulkAnalyst = options.bulkAnalyst ?? options.analyst;
    this.strategist = options.strategist;
    this.bulkStrategist = options.bulkStrategist ?? options.strategist;
    this.executor = options.executor;
    this.cases = new CaseService(options.store);
    this.logger = options.logger ?? noopLogger;
  }

  async runCase(caseId: string, options: RunDecisionOptions = {}): Promise<DecisionResult> {
    const started = Date.now();
    const phases: Array<{ phase: string; ms: number }> = [];
    const mark = (phase: string, from: number): void => {
      phases.push({ phase, ms: Date.now() - from });
    };

    const actor = options.actor ?? { kind: 'agent' as const, id: 'agent:recovery_analyst' };
    const trigger = options.trigger ?? 'decision_pipeline';

    // --- CONTEXT -------------------------------------------------------------
    let phaseStart = Date.now();
    const context = await this.context.buildCaseContext(caseId, options.asOfIso);
    mark('context', phaseStart);

    if (!CaseService.isActionable(context.recoveryCase)) {
      throw Object.assign(
        new Error(`case ${caseId} is ${context.recoveryCase.status} and cannot be worked further`),
        { code: 'INVALID_STATE' },
      );
    }

    if (context.recoveryCase.status === 'detected') {
      await this.cases.transition(caseId, 'investigating', {
        at: context.nowIso,
        summary: 'Recovery analyst opened an investigation.',
      });
    }

    // --- PREDICT -------------------------------------------------------------
    phaseStart = Date.now();
    const prediction = this.prediction.predict(context.modelInput);
    mark('predict', phaseStart);

    await this.cases.appendTimeline(caseId, {
      at: context.nowIso,
      kind: 'predicted',
      summary: `Recovery probability ${(prediction.probability * 100).toFixed(1)}% from ${prediction.modelVersion}${prediction.degraded ? ' (degraded — no trained artifact)' : ''}.`,
    });

    // --- DIAGNOSE ------------------------------------------------------------
    phaseStart = Date.now();
    const graph = this.context.buildGraph(context);
    const analyst = options.bulk ? this.bulkAnalyst : this.analyst;
    const investigation = await analyst.investigate({
      context,
      prediction,
      graphNarrative: graph.narrative,
    });
    mark('diagnose', phaseStart);

    await this.cases.appendTimeline(caseId, {
      at: context.nowIso,
      kind: 'investigated',
      summary: investigation.diagnosis.headline,
    });

    // --- DECIDE --------------------------------------------------------------
    phaseStart = Date.now();
    const decision = await (options.bulk ? this.bulkStrategist : this.strategist).decide({
      context,
      recoveryProbability: prediction.probability,
      diagnosis: investigation.diagnosis,
    });
    mark('decide', phaseStart);

    const chosenStrategy = options.overrideStrategy ?? decision.recommendedStrategy;
    const chosenCandidate =
      decision.candidates.find((c) => c.strategy === chosenStrategy) ?? decision.selectedCandidate;

    // --- RECORD --------------------------------------------------------------
    const aiDecision: AIDecision = {
      id: newId('aid'),
      merchantId: context.recoveryCase.merchantId,
      caseId,
      reasoner: {
        id: decision.reasoner.id,
        kind: decision.reasoner.kind,
        model: decision.reasoner.model,
        degraded: decision.reasoner.degraded || investigation.reasoner.degraded,
        degradedReason: decision.reasoner.degradedReason ?? investigation.reasoner.degradedReason,
      },
      detectedProblem: investigation.detectedProblem,
      signals: investigation.signals,
      diagnosis: {
        failureReason: context.recoveryCase.failureReason,
        category: context.profile.category,
        selfResolving: context.profile.selfResolving,
        recoverabilityPrior: context.profile.baseRecoverability,
        headline: investigation.diagnosis.headline,
        explanation: investigation.diagnosis.explanation,
        recommendedWindowHours: context.profile.optimalDelayHours,
        customerActionRequired: context.profile.customerActionRequired,
      },
      recoveryProbability: prediction.probability,
      modelVersion: prediction.modelVersion,
      candidates: decision.candidates,
      recommendedStrategy: decision.recommendedStrategy,
      expectedValueMinor: decision.expectedValueMinor,
      confidence: decision.confidence,
      explanation: decision.explanation,
      toolCalls: investigation.toolCalls.map((call) => ({
        tool: call.tool,
        ok: call.ok,
        durationMs: call.durationMs,
        error: call.error,
      })),
      latencyMs: investigation.latencyMs + decision.latencyMs,
      createdAt: context.nowIso,
    };
    await this.store.aiDecisions.put(aiDecision);

    await this.cases.recordPrediction(caseId, {
      probability: prediction.probability,
      expectedValueMinor: decision.expectedValueMinor,
      isSubscriber: context.features.isSubscriber,
      lifetimeValueMinor: context.features.lifetimeValueMinor,
      at: context.nowIso,
    });

    await this.cases.appendTimeline(caseId, {
      at: context.nowIso,
      kind: 'decided',
      summary: `Recommended ${chosenStrategy.replace(/_/g, ' ')} — expected value ${(chosenCandidate.expectedValueMinor / 100).toFixed(0)} INR at ${(decision.confidence * 100).toFixed(0)}% confidence.`,
      refId: aiDecision.id,
      amountMinor: chosenCandidate.expectedValueMinor,
    });

    await this.store.appendAudit({
      merchantId: context.recoveryCase.merchantId,
      actor,
      event: 'ai.decision_recorded',
      trigger,
      caseId,
      customerId: context.customer.id,
      amountMinor: context.recoveryCase.amountAtRiskMinor,
      aiDecisionId: aiDecision.id,
      at: context.nowIso,
      metadata: {
        strategy: chosenStrategy,
        economicChoice: decision.economicChoice,
        overrode: decision.overrode ? `${decision.overrode.from}->${decision.overrode.to}` : null,
        probability: prediction.probability,
        reasoner: decision.reasoner.id,
        degraded: aiDecision.reasoner.degraded,
      },
    });

    if (options.execute === false) {
      return {
        caseId,
        aiDecision,
        execution: null,
        executed: false,
        totalLatencyMs: Date.now() - started,
        phases,
      };
    }

    // --- GUARD + EXECUTE + MEASURE ------------------------------------------
    phaseStart = Date.now();
    // Re-read the context so the executor sees the prediction we just persisted.
    const executionContext: CaseContext = {
      ...context,
      recoveryCase: await this.cases.get(caseId),
    };

    const execution = await this.executor.execute({
      context: executionContext,
      strategy: chosenStrategy,
      successProbability: chosenCandidate.successProbability,
      expectedValueMinor: chosenCandidate.expectedValueMinor,
      aiDecisionId: aiDecision.id,
      actor,
      trigger,
    });
    mark('execute', phaseStart);

    this.logger.info('case decision complete', {
      caseId,
      strategy: chosenStrategy,
      finalStrategy: execution.finalStrategy,
      status: execution.finalStatus,
      recoveredMinor: execution.recoveredAmountMinor,
    });

    return {
      caseId,
      aiDecision,
      execution,
      executed: true,
      totalLatencyMs: Date.now() - started,
      phases,
    };
  }

  /**
   * Work a queue of cases. Sequential by design: the policy engine reads per-customer
   * contact counts and per-case cooldowns that earlier iterations mutate, and running
   * concurrently would let two cases for the same customer both see "zero contacts today".
   */
  async runBatch(
    caseIds: readonly string[],
    options: RunDecisionOptions & { onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{
    processed: number;
    recoveredMinor: number;
    recoveredCount: number;
    blockedCount: number;
    escalatedCount: number;
    duplicatesPrevented: number;
    failedCount: number;
    errors: Array<{ caseId: string; error: string }>;
    results: DecisionResult[];
    durationMs: number;
  }> {
    const started = Date.now();
    const results: DecisionResult[] = [];
    const errors: Array<{ caseId: string; error: string }> = [];

    let recoveredMinor = 0;
    let recoveredCount = 0;
    let blockedCount = 0;
    let escalatedCount = 0;
    let duplicatesPrevented = 0;
    let failedCount = 0;

    for (const [index, caseId] of caseIds.entries()) {
      try {
        const result = await this.runCase(caseId, { bulk: true, ...options });
        results.push(result);
        const execution = result.execution;
        if (execution) {
          recoveredMinor += execution.recoveredAmountMinor;
          if (execution.recoveredAmountMinor > 0) recoveredCount += 1;
          if (execution.blockedByPolicy) blockedCount += 1;
          if (execution.escalated) escalatedCount += 1;
          if (execution.duplicatePrevented) duplicatesPrevented += 1;
          if (execution.finalStatus === 'failed') failedCount += 1;
        }
      } catch (error) {
        // One bad case must never abort a batch of thousands.
        failedCount += 1;
        errors.push({
          caseId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.warn('batch case failed', { caseId, error: String(error) });
      }
      options.onProgress?.(index + 1, caseIds.length);
    }

    return {
      processed: results.length,
      recoveredMinor,
      recoveredCount,
      blockedCount,
      escalatedCount,
      duplicatesPrevented,
      failedCount,
      errors,
      results,
      durationMs: Date.now() - started,
    };
  }
}
