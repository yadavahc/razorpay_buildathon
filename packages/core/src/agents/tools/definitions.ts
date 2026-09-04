import { z } from 'zod';
import { resolveCaseProfile } from '../../domain/case-profiles.js';
import { getFailureProfile } from '../../domain/failure-taxonomy.js';
import { RECOVERY_STRATEGIES } from '../../types/enums.js';
import { formatMinor } from '../../types/money.js';
import { idempotencyKeyFor } from '../../util/hash.js';
import { round } from '../../util/collections.js';
import type { ActionExecutor } from '../../services/action-executor.js';
import type { AnalyticsService } from '../../services/analytics-service.js';
import type { ContextService } from '../../services/context-service.js';
import type { PredictionService } from '../../services/prediction-service.js';
import { evaluateStrategies } from '../../strategy/strategy-engine.js';
import { ToolRegistry, caseIdInput, type ToolCallContext } from './registry.js';

/**
 * THE TOOL CATALOG
 *
 * Eleven tools, split cleanly into two groups by what they are allowed to do.
 *
 *   READ / COMPUTE — gather evidence and price options. Free of side effects, so an
 *   agent can call them in any order, repeatedly, without consequence.
 *
 *   WRITE — cause something to happen in the world. Every one of them delegates to the
 *   ActionExecutor rather than touching a provider directly, which means each inherits
 *   the full safety stack: policy evaluation, idempotency claim before side effect,
 *   bounded retries, circuit breaking, fallback, outcome recording and audit. There is
 *   deliberately no path from an agent to a payment provider that bypasses that.
 */

export interface ToolServices {
  context: ContextService;
  prediction: PredictionService;
  analytics: AnalyticsService;
  executor: ActionExecutor;
}

const strategyEnum = z.enum(RECOVERY_STRATEGIES);

export function createToolRegistry(services: ToolServices): ToolRegistry {
  const registry = new ToolRegistry();

  // ---------------------------------------------------------------- read tools

  registry.register({
    name: 'get_customer_context',
    description:
      'Load the customer behind a recovery case: segment, lifetime value, payment success ratio, eligibility flags and relationship age.',
    parameterSummary: '{ caseId: string }',
    inputSchema: caseIdInput,
    outputSchema: z.object({
      customerId: z.string(),
      name: z.string(),
      segment: z.string(),
      lifetimeValueMinor: z.number().int(),
      successfulPayments: z.number().int(),
      failedPayments: z.number().int(),
      successRatio: z.number(),
      contactOptOut: z.boolean(),
      doNotRetry: z.boolean(),
      chargebackCount: z.number().int(),
      isSubscriber: z.boolean(),
      subscriptionAgeDays: z.number().nullable(),
      daysSinceLastSuccess: z.number().nullable(),
      consecutiveFailures: z.number().int(),
      hasAlternateSuccessfulMethod: z.boolean(),
      timezone: z.string(),
    }),
    scope: 'read:customer',
    mutating: false,
    summarize: (out) =>
      `${out.name} (${out.segment}): ${out.successfulPayments} successful / ${out.failedPayments} failed payments, lifetime value ${formatMinor(out.lifetimeValueMinor, { whole: true })}${
        out.contactOptOut ? ', OPTED OUT of contact' : ''
      }${out.doNotRetry ? ', flagged DO-NOT-RETRY' : ''}.`,
    handler: async (input) => {
      const ctx = await services.context.buildCaseContext(input.caseId);
      return {
        customerId: ctx.customer.id,
        name: ctx.customer.name,
        segment: ctx.customer.segment,
        lifetimeValueMinor: ctx.features.lifetimeValueMinor,
        successfulPayments: ctx.features.successfulPaymentCount,
        failedPayments: ctx.features.failedPaymentCount,
        successRatio: ctx.features.successRatio,
        contactOptOut: ctx.customer.contactOptOut,
        doNotRetry: ctx.customer.doNotRetry,
        chargebackCount: ctx.customer.chargebackCount,
        isSubscriber: ctx.features.isSubscriber,
        subscriptionAgeDays: ctx.features.subscriptionAgeDays,
        daysSinceLastSuccess: ctx.features.daysSinceLastSuccess,
        consecutiveFailures: ctx.features.consecutiveFailures,
        hasAlternateSuccessfulMethod: ctx.features.hasAlternateSuccessfulMethod,
        timezone: ctx.customer.timezone,
      };
    },
  });

  registry.register({
    name: 'get_payment_history',
    description:
      'Recent payments for the customer on a case, newest first, with status, method, issuer and failure reason.',
    parameterSummary: '{ caseId: string, limit?: number (default 10, max 50) }',
    inputSchema: caseIdInput.extend({ limit: z.number().int().min(1).max(50).default(10) }),
    outputSchema: z.object({
      totalPayments: z.number().int(),
      capturedCount: z.number().int(),
      failedCount: z.number().int(),
      distinctMethods: z.array(z.string()),
      recentRecoveryRate: z.number().nullable(),
      payments: z.array(
        z.object({
          id: z.string(),
          amountMinor: z.number().int(),
          status: z.string(),
          method: z.string(),
          issuer: z.string(),
          failureReason: z.string().nullable(),
          createdAt: z.string(),
          fromRecovery: z.boolean(),
        }),
      ),
    }),
    scope: 'read:payments',
    mutating: false,
    summarize: (out) =>
      `${out.totalPayments} payments on file: ${out.capturedCount} captured, ${out.failedCount} failed, across ${out.distinctMethods.join('/') || 'no'} instruments.`,
    handler: async (input) => {
      const ctx = await services.context.buildCaseContext(input.caseId);
      const all = ctx.customerContext.payments;
      const recent = [...all].reverse().slice(0, input.limit);
      return {
        totalPayments: all.length,
        capturedCount: all.filter((p) => p.status === 'captured').length,
        failedCount: all.filter((p) => p.status === 'failed').length,
        distinctMethods: [...new Set(all.map((p) => p.method))],
        recentRecoveryRate:
          ctx.features.priorRecoveryAttempts === 0 ? null : ctx.features.priorRecoveryRate,
        payments: recent.map((p) => ({
          id: p.id,
          amountMinor: p.amountMinor,
          status: p.status,
          method: p.method,
          issuer: p.issuer,
          failureReason: p.failureReason,
          createdAt: p.createdAt,
          fromRecovery: p.source === 'recovery',
        })),
      };
    },
  });

  registry.register({
    name: 'get_subscription',
    description:
      'Subscription and mandate state for the case. A revoked mandate makes automated retries structurally impossible.',
    parameterSummary: '{ caseId: string }',
    inputSchema: caseIdInput,
    outputSchema: z.object({
      hasSubscription: z.boolean(),
      mandateActive: z.boolean().nullable(),
      subscriptions: z.array(
        z.object({
          id: z.string(),
          planName: z.string(),
          status: z.string(),
          planAmountMinor: z.number().int(),
          interval: z.string(),
          completedCycles: z.number().int(),
          failedCycles: z.number().int(),
          mandateActive: z.boolean(),
          startedAt: z.string(),
        }),
      ),
      activeRecurringValueMinor: z.number().int(),
    }),
    scope: 'read:subscription',
    mutating: false,
    summarize: (out) =>
      out.hasSubscription
        ? `${out.subscriptions.length} subscription(s); mandate ${out.mandateActive === false ? 'REVOKED — retries not permitted' : 'active'}, ${formatMinor(out.activeRecurringValueMinor, { whole: true })} of recurring value at stake.`
        : 'No subscription attached to this customer.',
    handler: async (input) => {
      const ctx = await services.context.buildCaseContext(input.caseId);
      const subs = ctx.customerContext.subscriptions;
      return {
        hasSubscription: subs.length > 0,
        mandateActive: ctx.mandateActive,
        subscriptions: subs.map((s) => ({
          id: s.id,
          planName: s.planName,
          status: s.status,
          planAmountMinor: s.planAmountMinor,
          interval: s.interval,
          completedCycles: s.completedCycles,
          failedCycles: s.failedCycles,
          mandateActive: s.mandateActive,
          startedAt: s.startedAt,
        })),
        activeRecurringValueMinor: ctx.features.activeSubscriptionValueMinor,
      };
    },
  });

  registry.register({
    name: 'diagnose_failure',
    description:
      'Classify the loss event against the failure taxonomy: category, recoverability prior, whether it clears on its own, the optimal retry window, and whether the customer must act.',
    parameterSummary: '{ caseId: string }',
    inputSchema: caseIdInput,
    outputSchema: z.object({
      profileKey: z.string(),
      label: z.string(),
      category: z.string(),
      selfResolving: z.boolean(),
      baseRecoverability: z.number(),
      optimalDelayHours: z.number(),
      customerActionRequired: z.boolean(),
      retryPossible: z.boolean(),
      paymentLinkPossible: z.boolean(),
      headline: z.string(),
      explanation: z.string(),
      errorCode: z.string().nullable(),
    }),
    scope: 'read:payments',
    mutating: false,
    summarize: (out) =>
      `${out.label} (${out.category}): base recoverability ${(out.baseRecoverability * 100).toFixed(0)}%, ${out.retryPossible ? `retry viable after ${out.optimalDelayHours}h` : 'retry impossible'}, ${out.customerActionRequired ? 'customer must act' : 'no customer action needed'}.`,
    handler: async (input) => {
      const ctx = await services.context.buildCaseContext(input.caseId);
      const profile = ctx.profile;
      return {
        profileKey: profile.key,
        label: profile.label,
        category: profile.category,
        selfResolving: profile.selfResolving,
        baseRecoverability: profile.baseRecoverability,
        optimalDelayHours: profile.optimalDelayHours,
        customerActionRequired: profile.customerActionRequired,
        retryPossible: profile.retryPossible,
        paymentLinkPossible: profile.paymentLinkPossible,
        headline: profile.headline,
        explanation: profile.explanation,
        errorCode: ctx.recoveryCase.failureReason
          ? getFailureProfile(ctx.recoveryCase.failureReason).errorCode
          : null,
      };
    },
  });

  registry.register({
    name: 'get_recovery_probability',
    description:
      'Score the case with the trained recovery-probability model. Returns the calibrated probability, the operating threshold, and the strongest signals driving the score.',
    parameterSummary: '{ caseId: string }',
    inputSchema: caseIdInput,
    outputSchema: z.object({
      probability: z.number(),
      threshold: z.number(),
      aboveThreshold: z.boolean(),
      modelVersion: z.string(),
      degraded: z.boolean(),
      degradedReason: z.string().nullable(),
      topDrivers: z.array(
        z.object({
          label: z.string(),
          direction: z.string(),
          contribution: z.number(),
        }),
      ),
    }),
    scope: 'compute:prediction',
    mutating: false,
    summarize: (out) =>
      `Recovery probability ${(out.probability * 100).toFixed(1)}% (threshold ${(out.threshold * 100).toFixed(0)}%, model ${out.modelVersion}${out.degraded ? ', DEGRADED' : ''}).`,
    handler: async (input) => {
      const ctx = await services.context.buildCaseContext(input.caseId);
      const prediction = services.prediction.predict(ctx.modelInput);
      return {
        probability: prediction.probability,
        threshold: prediction.threshold,
        aboveThreshold: prediction.aboveThreshold,
        modelVersion: prediction.modelVersion,
        degraded: prediction.degraded,
        degradedReason: prediction.degradedReason,
        topDrivers: prediction.drivers.slice(0, 5).map((d) => ({
          label: d.label,
          direction: d.direction,
          contribution: d.contribution,
        })),
      };
    },
  });

  registry.register({
    name: 'calculate_expected_recovery',
    description:
      'Price every strategy in the bounded action space: success probability, gross recovery, intervention cost, goodwill cost and net expected value. Marks structurally unavailable options.',
    parameterSummary: '{ caseId: string, probabilityOverride?: number (0-1) }',
    inputSchema: caseIdInput.extend({
      probabilityOverride: z.number().min(0).max(1).optional(),
    }),
    outputSchema: z.object({
      amountAtRiskMinor: z.number().int(),
      recoveryProbability: z.number(),
      bestStrategy: strategyEnum,
      bestExpectedValueMinor: z.number().int(),
      candidates: z.array(
        z.object({
          strategy: strategyEnum,
          successProbability: z.number(),
          expectedValueMinor: z.number().int(),
          interventionCostMinor: z.number().int(),
          goodwillCostMinor: z.number().int(),
          delayHours: z.number(),
          eligible: z.boolean(),
          ineligibleReason: z.string().nullable(),
          rationale: z.string(),
        }),
      ),
    }),
    scope: 'compute:strategy',
    mutating: false,
    summarize: (out) =>
      `Best option: ${out.bestStrategy.replace(/_/g, ' ')} at ${formatMinor(out.bestExpectedValueMinor)} expected value on ${formatMinor(out.amountAtRiskMinor, { whole: true })} at risk.`,
    handler: async (input) => {
      const ctx = await services.context.buildCaseContext(input.caseId);
      const probability =
        input.probabilityOverride ??
        ctx.recoveryCase.recoveryProbability ??
        services.prediction.predict(ctx.modelInput).probability;

      const evaluation = evaluateStrategies({
        amountAtRiskMinor: ctx.recoveryCase.amountAtRiskMinor,
        recoveryProbability: probability,
        profile: ctx.profile,
        priorContactCount: ctx.recoveryCase.notificationCount,
        priorAttemptCount: ctx.recoveryCase.attemptCount,
        constraints: {
          contactOptOut: ctx.customer.contactOptOut,
          doNotRetry: ctx.customer.doNotRetry,
          mandateActive: ctx.mandateActive !== false,
          hasContactChannel: Boolean(ctx.customer.email || ctx.customer.phone),
          retryableSource:
            ctx.recoveryCase.sourceType === 'payment_failure' ||
            ctx.recoveryCase.sourceType === 'subscription_dunning',
        },
      });

      return {
        amountAtRiskMinor: ctx.recoveryCase.amountAtRiskMinor,
        recoveryProbability: round(probability),
        bestStrategy: evaluation.best.strategy,
        bestExpectedValueMinor: evaluation.best.expectedValueMinor,
        candidates: evaluation.candidates.map((c) => ({
          strategy: c.strategy,
          successProbability: c.successProbability,
          expectedValueMinor: c.expectedValueMinor,
          interventionCostMinor: c.interventionCostMinor,
          goodwillCostMinor: c.goodwillCostMinor,
          delayHours: c.delayHours,
          eligible: c.eligible,
          ineligibleReason: c.ineligibleReason,
          rationale: c.rationale,
        })),
      };
    },
  });

  // --------------------------------------------------------------- write tools

  /**
   * All five write tools share one shape: validate, hand to the executor with the correct
   * strategy, and report what actually happened. The executor owns policy, idempotency,
   * retries, fallback and audit — the tool adds nothing of its own to that path.
   */
  const executionOutputSchema = z.object({
    caseId: z.string(),
    requestedStrategy: strategyEnum,
    finalStrategy: strategyEnum,
    status: z.string(),
    policyVerdict: z.string(),
    policyReasonCodes: z.array(z.string()),
    recoveredAmountMinor: z.number().int(),
    blockedByPolicy: z.boolean(),
    duplicatePrevented: z.boolean(),
    fallbacksUsed: z.number().int(),
    notes: z.array(z.string()),
    providerRef: z.string().nullable(),
  });

  const runExecution = async (
    caseId: string,
    strategy: (typeof RECOVERY_STRATEGIES)[number],
    context: ToolCallContext,
  ) => {
    const ctx = await services.context.buildCaseContext(caseId);
    const probability =
      ctx.recoveryCase.recoveryProbability ?? services.prediction.predict(ctx.modelInput).probability;

    const evaluation = evaluateStrategies({
      amountAtRiskMinor: ctx.recoveryCase.amountAtRiskMinor,
      recoveryProbability: probability,
      profile: ctx.profile,
      priorContactCount: ctx.recoveryCase.notificationCount,
      priorAttemptCount: ctx.recoveryCase.attemptCount,
      constraints: {
        contactOptOut: ctx.customer.contactOptOut,
        doNotRetry: ctx.customer.doNotRetry,
        mandateActive: ctx.mandateActive !== false,
        hasContactChannel: Boolean(ctx.customer.email || ctx.customer.phone),
        retryableSource:
          ctx.recoveryCase.sourceType === 'payment_failure' ||
          ctx.recoveryCase.sourceType === 'subscription_dunning',
      },
    });
    const candidate = evaluation.candidates.find((c) => c.strategy === strategy);

    const result = await services.executor.execute({
      context: ctx,
      strategy,
      successProbability: candidate?.successProbability ?? probability,
      expectedValueMinor: candidate?.expectedValueMinor ?? 0,
      aiDecisionId: null,
      actor: { kind: context.actor.kind === 'user' ? 'user' : 'agent', id: context.actor.id },
      trigger: `tool:${strategy}`,
    });

    const firstStep = result.steps[0];
    return {
      caseId,
      requestedStrategy: strategy,
      finalStrategy: result.finalStrategy,
      status: result.finalStatus,
      policyVerdict: firstStep?.policyDecision.verdict ?? 'allow',
      policyReasonCodes: firstStep?.policyDecision.reasonCodes ?? [],
      recoveredAmountMinor: result.recoveredAmountMinor,
      blockedByPolicy: result.blockedByPolicy,
      duplicatePrevented: result.duplicatePrevented,
      fallbacksUsed: result.fallbacksUsed,
      notes: result.notes,
      providerRef: result.steps.at(-1)?.action?.providerRef ?? null,
    };
  };

  const summarizeExecution = (out: z.infer<typeof executionOutputSchema>): string => {
    if (out.duplicatePrevented) return `Duplicate suppressed; no action taken on ${out.caseId}.`;
    if (out.blockedByPolicy) {
      return `Policy ${out.policyVerdict} (${out.policyReasonCodes.join(', ') || 'no code'}); ${
        out.finalStrategy === out.requestedStrategy
          ? 'no alternative available'
          : `fell back to ${out.finalStrategy.replace(/_/g, ' ')}`
      }.`;
    }
    if (out.recoveredAmountMinor > 0) {
      return `Recovered ${formatMinor(out.recoveredAmountMinor)} via ${out.finalStrategy.replace(/_/g, ' ')}.`;
    }
    return `${out.finalStrategy.replace(/_/g, ' ')} finished with status ${out.status}.`;
  };

  registry.register({
    name: 'retry_payment',
    description:
      'Re-present the failed authorisation. Choose "delayed" to schedule it for the window in which the blocking condition has most likely cleared. Subject to retry limits, cooldown, mandate validity and the transaction ceiling.',
    parameterSummary: '{ caseId: string, timing: "immediate" | "delayed" }',
    inputSchema: caseIdInput.extend({
      timing: z.enum(['immediate', 'delayed']).default('delayed'),
    }),
    outputSchema: executionOutputSchema,
    scope: 'write:payment',
    mutating: true,
    idempotencyKey: (input, context) =>
      idempotencyKeyFor({
        tool: 'retry_payment',
        caseId: input.caseId,
        timing: input.timing,
        runId: context.runId,
      }),
    summarize: summarizeExecution,
    handler: (input, context) =>
      runExecution(
        input.caseId,
        input.timing === 'immediate' ? 'immediate_retry' : 'delayed_retry',
        context,
      ),
  });

  registry.register({
    name: 'create_payment_link',
    description:
      'Issue a fresh hosted payment page so the customer can pay with any instrument, and deliver it on their preferred channel. The only route that works when the stored instrument is structurally dead.',
    parameterSummary: '{ caseId: string }',
    inputSchema: caseIdInput,
    outputSchema: executionOutputSchema,
    scope: 'write:payment',
    mutating: true,
    idempotencyKey: (input, context) =>
      idempotencyKeyFor({ tool: 'create_payment_link', caseId: input.caseId, runId: context.runId }),
    summarize: summarizeExecution,
    handler: (input, context) => runExecution(input.caseId, 'payment_link', context),
  });

  registry.register({
    name: 'send_notification',
    description:
      'Tell the customer what happened and what to do about it. Subject to the daily contact cap, quiet hours in the customer local timezone, and contact opt-out.',
    parameterSummary: '{ caseId: string }',
    inputSchema: caseIdInput,
    outputSchema: executionOutputSchema,
    scope: 'write:notification',
    mutating: true,
    idempotencyKey: (input, context) =>
      idempotencyKeyFor({ tool: 'send_notification', caseId: input.caseId, runId: context.runId }),
    summarize: summarizeExecution,
    handler: (input, context) => runExecution(input.caseId, 'customer_notification', context),
  });

  registry.register({
    name: 'escalate_case',
    description:
      'Route the case to a human operator. Use for high-value cases the model is unsure about, or where automation has exhausted its options.',
    parameterSummary: '{ caseId: string, reason: string }',
    inputSchema: caseIdInput.extend({ reason: z.string().min(3).max(300) }),
    outputSchema: executionOutputSchema,
    scope: 'write:case',
    mutating: true,
    idempotencyKey: (input, context) =>
      idempotencyKeyFor({ tool: 'escalate_case', caseId: input.caseId, runId: context.runId }),
    summarize: summarizeExecution,
    handler: (input, context) => runExecution(input.caseId, 'escalate', context),
  });

  registry.register({
    name: 'close_recovery_case',
    description:
      'Stop working the case. The correct action whenever every remaining intervention has negative expected value — doing nothing costs nothing.',
    parameterSummary: '{ caseId: string, reason: string }',
    inputSchema: caseIdInput.extend({ reason: z.string().min(3).max(300) }),
    outputSchema: executionOutputSchema,
    scope: 'write:case',
    mutating: true,
    idempotencyKey: (input, context) =>
      idempotencyKeyFor({ tool: 'close_recovery_case', caseId: input.caseId, runId: context.runId }),
    summarize: summarizeExecution,
    handler: (input, context) => runExecution(input.caseId, 'stop_recovery', context),
  });

  // ------------------------------------------------------------ analytics tool

  registry.register({
    name: 'query_recovery_metrics',
    description:
      'Read live portfolio metrics: revenue at risk, recoverable and recovered revenue, recovery rate, leakage breakdown by failure reason and method, top opportunities, and a period-over-period comparison.',
    parameterSummary:
      '{ scope: "overview" | "leakage" | "opportunities" | "period_comparison" | "strategies" }',
    inputSchema: z.object({
      scope: z
        .enum(['overview', 'leakage', 'opportunities', 'period_comparison', 'strategies'])
        .default('overview'),
    }),
    outputSchema: z.object({
      scope: z.string(),
      data: z.unknown(),
    }),
    scope: 'read:analytics',
    mutating: false,
    summarize: (out) => `Loaded ${out.scope} metrics from live application data.`,
    handler: async (input, context) => {
      const merchantId = context.merchantId;
      switch (input.scope) {
        case 'leakage':
          return { scope: input.scope, data: await services.analytics.leakage(merchantId) };
        case 'opportunities':
          return { scope: input.scope, data: await services.analytics.opportunities(merchantId, 10) };
        case 'period_comparison':
          return { scope: input.scope, data: await services.analytics.periodComparison(merchantId) };
        case 'strategies':
          return {
            scope: input.scope,
            data: await services.analytics.strategyPerformance(merchantId),
          };
        default:
          return { scope: input.scope, data: await services.analytics.controlTower(merchantId) };
      }
    },
  });

  return registry;
}

/** Re-exported so callers can build a profile without importing the domain module. */
export { resolveCaseProfile };
