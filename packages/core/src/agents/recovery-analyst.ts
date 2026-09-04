import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { DiagnosisOutput, Reasoner } from '../llm/reasoner.js';
import type { ReasonerIdentity } from '../llm/types.js';
import type { CaseContext } from '../services/context-service.js';
import type { DataStore } from '../store/types.js';
import type { PredictionResult } from '../services/prediction-service.js';
import type { DecisionSignal } from '../types/decisions.js';
import { formatMinor } from '../types/money.js';
import { newId } from '../util/id.js';
import { READ_ONLY_SCOPES, type ToolCallContext, type ToolInvocation, ToolRegistry } from './tools/registry.js';

/**
 * THE RECOVERY ANALYST AGENT
 *
 * Investigates one revenue-loss event and produces a diagnosis. It holds read and compute
 * scopes only — it physically cannot call `retry_payment`, because the tool registry
 * checks scope before the handler runs. Investigation and action are separate concerns
 * carried out by separate agents with separate authority, which is how a system avoids
 * the failure mode where "let me look into this" turns into "I have charged the customer".
 *
 * The loop is a genuine plan/act/observe cycle: the reasoner picks the next tool from the
 * catalog, the registry validates and runs it, the observation feeds back into the next
 * planning step. The same loop runs whether the reasoner is a hosted model or the
 * deterministic planner, so the safety properties are identical in both modes.
 */

export interface InvestigationResult {
  runId: string;
  diagnosis: DiagnosisOutput;
  prediction: PredictionResult;
  signals: DecisionSignal[];
  toolCalls: ToolInvocation[];
  reasoner: ReasonerIdentity;
  detectedProblem: string;
  graphNarrative: string;
  latencyMs: number;
  /** Set when a tool failed and the investigation proceeded on partial evidence. */
  degradedEvidence: string | null;
}

export interface RecoveryAnalystOptions {
  registry: ToolRegistry;
  reasoner: Reasoner;
  store: DataStore;
  logger?: Logger;
  /** Hard cap on planning iterations. Prevents an agent loop from running away. */
  maxSteps?: number;
}

export class RecoveryAnalystAgent {
  readonly id = 'agent:recovery_analyst';

  private readonly registry: ToolRegistry;
  private readonly reasoner: Reasoner;
  private readonly store: DataStore;
  private readonly logger: Logger;
  private readonly maxSteps: number;

  constructor(options: RecoveryAnalystOptions) {
    this.registry = options.registry;
    this.reasoner = options.reasoner;
    this.store = options.store;
    this.logger = options.logger ?? noopLogger;
    this.maxSteps = options.maxSteps ?? 6;
  }

  async investigate(input: {
    context: CaseContext;
    prediction: PredictionResult;
    graphNarrative: string;
  }): Promise<InvestigationResult> {
    const started = Date.now();
    const runId = newId('run');
    const { context, prediction } = input;

    const toolContext: ToolCallContext = {
      merchantId: context.recoveryCase.merchantId,
      actor: { kind: 'agent', id: this.id },
      // Read and compute only. The absence of write scopes here is the whole point.
      scopes: READ_ONLY_SCOPES,
      store: this.store,
      logger: this.logger.child({ agent: this.id }),
      nowIso: context.nowIso,
      runId,
    };

    const toolCalls: ToolInvocation[] = [];
    const observations: Array<{ tool: string; ok: boolean; summary: string }> = [];

    for (let step = 0; step < this.maxSteps; step++) {
      const plan = await this.reasoner.planNextTool({
        goal: `Investigate why ${formatMinor(context.recoveryCase.amountAtRiskMinor, { whole: true })} was lost on case ${context.recoveryCase.id} and how recoverable it is.`,
        toolCatalog: this.registry.catalog(READ_ONLY_SCOPES),
        observations,
        stepsRemaining: this.maxSteps - step,
      });

      if (plan.output.done || plan.output.tool === null) break;

      const invocation = await this.registry.invoke(
        plan.output.tool,
        { caseId: context.recoveryCase.id, ...plan.output.arguments },
        toolContext,
      );
      toolCalls.push(invocation);
      observations.push({
        tool: invocation.tool,
        ok: invocation.ok,
        summary: invocation.summary,
      });

      if (!invocation.ok) {
        this.logger.warn('analyst tool call failed; continuing on partial evidence', {
          tool: invocation.tool,
          error: invocation.error,
        });
      }
    }

    const failedTools = toolCalls.filter((t) => !t.ok);

    // The diagnosis is built from the case context, which is authoritative, rather than
    // from parsed tool output. The tool loop establishes *what the agent looked at*; the
    // context guarantees the figures are right regardless of how the loop went.
    const { output: diagnosis, identity } = await this.reasoner.diagnose({
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
        recoveryProbability: prediction.probability,
      },
      taxonomyHeadline: context.profile.headline,
      taxonomyExplanation: context.profile.explanation,
      graphNarrative: input.graphNarrative,
    });

    return {
      runId,
      diagnosis,
      prediction,
      signals: prediction.signals,
      toolCalls,
      reasoner: identity,
      detectedProblem: this.describeProblem(context),
      graphNarrative: input.graphNarrative,
      latencyMs: Date.now() - started,
      degradedEvidence:
        failedTools.length === 0
          ? null
          : `${failedTools.length} evidence tool${failedTools.length === 1 ? '' : 's'} failed (${failedTools
              .map((t) => t.tool)
              .join(', ')}); the diagnosis was produced from the remaining signals.`,
    };
  }

  private describeProblem(context: CaseContext): string {
    const amount = formatMinor(context.recoveryCase.amountAtRiskMinor, { whole: true });
    switch (context.recoveryCase.sourceType) {
      case 'payment_failure':
        return `${amount} payment failed with ${context.profile.label.toLowerCase()} on ${context.recoveryCase.method.toUpperCase()} via ${context.issuer}.`;
      case 'subscription_dunning':
        return `${amount} subscription renewal failed with ${context.profile.label.toLowerCase()}, putting the recurring relationship at risk.`;
      case 'checkout_abandonment':
        return `${amount} checkout was abandoned — ${context.profile.label.toLowerCase()}.`;
      case 'overdue_invoice':
        return `${amount} invoice is overdue — ${context.profile.label.toLowerCase()}.`;
    }
  }
}
