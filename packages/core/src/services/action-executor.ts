import type { PolicyConfig } from '../config/index.js';
import { totalInterventionCost } from '../domain/intervention-economics.js';
import { toReclaimError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import { POLICY_REASON_CODES, evaluatePolicy, isAllowed } from '../policy/policy-engine.js';
import type { NotificationProvider, PaymentProvider } from '../providers/payment-provider.js';
import { CircuitRegistry, withRetry } from '../resilience/index.js';
import type { PolicyDecision, RecoveryAction, RecoveryOutcome } from '../types/decisions.js';
import type { Notification, PaymentLink, Payment } from '../types/entities.js';
import type { ActionStatus, OutcomeKind, RecoveryStrategy, RunMode } from '../types/enums.js';
import type { DataStore } from '../store/types.js';
import { idempotencyKeyFor } from '../util/hash.js';
import { newId } from '../util/id.js';
import { addHours, parseIso } from '../util/time.js';
import { renderNotification } from './notification-templates.js';
import type { CaseContext } from './context-service.js';
import { CaseService } from './case-service.js';
import type { IncidentService } from './incident-service.js';

/**
 * THE ACTION EXECUTOR
 *
 * This is the only component in RECLAIM permitted to cause a side effect that costs or
 * recovers money. Everything upstream produces recommendations; this produces facts.
 *
 * The order of operations is deliberate and never varies:
 *
 *   1. POLICY      — the deterministic engine authorises, denies, or routes to a human.
 *                    A denial is recorded as a blocked action, not swallowed.
 *   2. IDEMPOTENCY — the key is claimed BEFORE the provider is called. If the claim
 *                    fails, the action is recorded as a suppressed duplicate and no
 *                    provider call is made at all.
 *   3. EXECUTE     — the provider call runs behind a circuit breaker with bounded,
 *                    backoff-spaced retries. Only errors classified retryable are retried.
 *   4. RECORD      — action, outcome, case bookkeeping and audit entry are written
 *                    whatever the result. A failed action is as fully recorded as a
 *                    successful one.
 *   5. FALL BACK   — a denial or a hard failure consults the policy engine's suggested
 *                    alternative and re-enters at step 1 with a bounded depth. This is
 *                    where a meaningful share of recovered revenue actually comes from:
 *                    the retry that could not run becoming the link that could.
 */

export interface ExecuteActionRequest {
  context: CaseContext;
  strategy: RecoveryStrategy;
  /** Probability for this specific strategy, from the expected-value engine. */
  successProbability: number;
  expectedValueMinor: number;
  aiDecisionId: string | null;
  actor: { kind: 'agent' | 'user' | 'system' | 'scheduler' | 'simulator'; id: string };
  trigger: string;
  /** Disable to execute exactly one strategy, e.g. when a human picked it explicitly. */
  allowFallback?: boolean;
  maxFallbackDepth?: number;
}

export interface ExecutionStep {
  strategy: RecoveryStrategy;
  policyDecision: PolicyDecision;
  action: RecoveryAction | null;
  status: ActionStatus;
  error: string | null;
  fallbackReason: string | null;
}

export interface ExecutionResult {
  caseId: string;
  steps: ExecutionStep[];
  finalStrategy: RecoveryStrategy;
  finalStatus: ActionStatus;
  outcome: RecoveryOutcome | null;
  recoveredAmountMinor: number;
  blockedByPolicy: boolean;
  duplicatePrevented: boolean;
  escalated: boolean;
  fallbacksUsed: number;
  /** Human-readable trace shown in the Decision Inspector. */
  notes: string[];
}

export interface ActionExecutorOptions {
  store: DataStore;
  paymentProvider: PaymentProvider;
  notificationProvider: NotificationProvider;
  policyConfig: PolicyConfig;
  mode: RunMode;
  logger?: Logger;
  circuits?: CircuitRegistry;
  /** Injected so tests advance time instead of waiting on backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Supplies the live systemic-incident picture. Optional: without it the incident check
   * resolves permissively, which is the correct failure mode for a monitoring dependency.
   */
  incidents?: IncidentService;
}

/** Provider-failure fallbacks, distinct from the policy engine's denial alternatives. */
const FAILURE_FALLBACKS: Partial<Record<RecoveryStrategy, RecoveryStrategy>> = {
  immediate_retry: 'delayed_retry',
  delayed_retry: 'payment_link',
  payment_link: 'customer_notification',
  customer_notification: 'escalate',
};

const RETRY_STRATEGIES: ReadonlySet<RecoveryStrategy> = new Set(['immediate_retry', 'delayed_retry']);
const CONTACT_STRATEGIES: ReadonlySet<RecoveryStrategy> = new Set([
  'payment_link',
  'customer_notification',
]);

export class ActionExecutor {
  private readonly store: DataStore;
  private readonly payments: PaymentProvider;
  private readonly notifications: NotificationProvider;
  private readonly policyConfig: PolicyConfig;
  private readonly mode: RunMode;
  private readonly logger: Logger;
  private readonly circuits: CircuitRegistry;
  private readonly cases: CaseService;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  private readonly incidents: IncidentService | null;

  constructor(options: ActionExecutorOptions) {
    this.store = options.store;
    this.payments = options.paymentProvider;
    this.notifications = options.notificationProvider;
    this.policyConfig = options.policyConfig;
    this.mode = options.mode;
    this.logger = options.logger ?? noopLogger;
    this.circuits = options.circuits ?? new CircuitRegistry();
    this.cases = new CaseService(options.store);
    this.sleep = options.sleep;
    this.incidents = options.incidents ?? null;
  }

  get circuitRegistry(): CircuitRegistry {
    return this.circuits;
  }

  async execute(request: ExecuteActionRequest): Promise<ExecutionResult> {
    const allowFallback = request.allowFallback ?? true;
    const maxDepth = request.maxFallbackDepth ?? 3;

    const steps: ExecutionStep[] = [];
    const notes: string[] = [];
    const attempted = new Set<RecoveryStrategy>();

    let strategy = request.strategy;
    let successProbability = request.successProbability;
    let expectedValueMinor = request.expectedValueMinor;
    let outcome: RecoveryOutcome | null = null;
    let recoveredAmountMinor = 0;
    let blockedByPolicy = false;
    let duplicatePrevented = false;
    let escalated = false;
    let fallbacksUsed = 0;

    for (let depth = 0; depth <= maxDepth; depth++) {
      if (attempted.has(strategy)) {
        notes.push(`Stopped: ${label(strategy)} had already been attempted on this run.`);
        break;
      }
      attempted.add(strategy);

      // Re-read the case each iteration: an earlier step may have changed its state.
      const context = depth === 0 ? request.context : await this.refreshContext(request.context);

      const step = await this.executeOnce({
        ...request,
        context,
        strategy,
        successProbability,
        expectedValueMinor,
      });
      steps.push(step);

      if (step.status === 'skipped_duplicate') duplicatePrevented = true;
      else if (step.policyDecision.verdict === 'deny') blockedByPolicy = true;
      if (strategy === 'escalate' && step.status === 'succeeded') escalated = true;

      if (step.status === 'succeeded') {
        const recorded = await this.recordOutcome({
          context,
          strategy,
          action: step.action,
          successProbability,
          nowIso: context.nowIso,
        });
        outcome = recorded.outcome;
        recoveredAmountMinor = recorded.recoveredAmountMinor;
        notes.push(recorded.note);
        return this.finish({
          caseId: context.recoveryCase.id,
          steps,
          finalStrategy: strategy,
          finalStatus: step.status,
          outcome,
          recoveredAmountMinor,
          blockedByPolicy,
          duplicatePrevented,
          escalated,
          fallbacksUsed,
          notes,
        });
      }

      if (step.status === 'skipped_duplicate') {
        notes.push(
          `An identical ${label(strategy)} had already been executed for this case; the duplicate was suppressed before reaching the provider.`,
        );
        return this.finish({
          caseId: context.recoveryCase.id,
          steps,
          finalStrategy: strategy,
          finalStatus: step.status,
          outcome: null,
          recoveredAmountMinor: 0,
          blockedByPolicy,
          duplicatePrevented,
          escalated,
          fallbacksUsed,
          notes,
        });
      }

      // Decide whether to fall back, and to what.
      const nextStrategy = this.nextStrategy(step, strategy, allowFallback, attempted);
      if (!nextStrategy || depth === maxDepth) {
        if (step.status === 'blocked') {
          notes.push(
            `Blocked by policy (${step.policyDecision.reasonCodes.join(', ') || 'no reason code'}) with no permitted alternative remaining.`,
          );
        } else {
          notes.push(`No further fallback available after ${label(strategy)} ${step.status}.`);
        }
        const closingOutcome = await this.closeUnrecovered(
          context,
          strategy,
          step,
          successProbability,
        );
        return this.finish({
          caseId: context.recoveryCase.id,
          steps,
          finalStrategy: strategy,
          finalStatus: step.status,
          outcome: closingOutcome,
          recoveredAmountMinor: 0,
          blockedByPolicy,
          duplicatePrevented,
          escalated,
          fallbacksUsed,
          notes,
        });
      }

      notes.push(
        `${label(strategy)} ${step.status === 'blocked' ? 'was blocked' : 'failed'}; falling back to ${label(nextStrategy)}. ${step.fallbackReason ?? ''}`.trim(),
      );
      await this.cases.appendTimeline(context.recoveryCase.id, {
        at: context.nowIso,
        kind: 'fallback_taken',
        summary: `${label(strategy)} → ${label(nextStrategy)}: ${step.fallbackReason ?? step.error ?? 'policy denial'}`,
      });

      fallbacksUsed += 1;
      strategy = nextStrategy;
      // A fallback is a different, usually less effective action. Re-price conservatively
      // rather than carrying the original strategy's odds forward.
      successProbability = Math.max(0.02, successProbability * 0.8);
      expectedValueMinor = Math.round(
        context.recoveryCase.amountAtRiskMinor * successProbability -
          totalInterventionCost(strategy, context.recoveryCase.notificationCount),
      );
    }

    return this.finish({
      caseId: request.context.recoveryCase.id,
      steps,
      finalStrategy: strategy,
      finalStatus: steps.at(-1)?.status ?? 'failed',
      outcome,
      recoveredAmountMinor,
      blockedByPolicy,
      duplicatePrevented,
      escalated,
      fallbacksUsed,
      notes,
    });
  }

  private finish(result: ExecutionResult): ExecutionResult {
    return result;
  }

  private nextStrategy(
    step: ExecutionStep,
    current: RecoveryStrategy,
    allowFallback: boolean,
    attempted: ReadonlySet<RecoveryStrategy>,
  ): RecoveryStrategy | null {
    if (!allowFallback) return null;
    if (current === 'stop_recovery' || current === 'escalate') return null;

    let candidate: RecoveryStrategy | null = null;
    if (step.status === 'blocked') candidate = step.policyDecision.suggestedAlternative;
    else if (step.status === 'failed') candidate = FAILURE_FALLBACKS[current] ?? null;

    // A fallback chain must never revisit a strategy. Detecting the repeat here rather than
    // at the top of the loop matters for two reasons: the loop would otherwise have already
    // moved `strategy` onto the stale attempt, so the run would report a final strategy it
    // never actually re-evaluated; and breaking from the top skips `closeUnrecovered`, which
    // is what leaves a case sitting in `investigating` forever instead of reaching a
    // terminal state. Returning null routes into the proper closing branch below.
    if (!candidate || candidate === current || attempted.has(candidate)) return null;
    return candidate;
  }

  private async refreshContext(context: CaseContext): Promise<CaseContext> {
    const recoveryCase = await this.store.cases.get(context.recoveryCase.id);
    return recoveryCase ? { ...context, recoveryCase } : context;
  }

  /** One policy-gated, idempotent, circuit-broken attempt at a single strategy. */
  private async executeOnce(request: ExecuteActionRequest): Promise<ExecutionStep> {
    const { context, strategy } = request;
    const nowIso = context.nowIso;

    const idempotencyKey = idempotencyKeyFor({
      merchantId: context.recoveryCase.merchantId,
      caseId: context.recoveryCase.id,
      strategy,
      attempt: context.recoveryCase.attemptCount,
      contacts: context.recoveryCase.notificationCount,
      amount: context.recoveryCase.amountAtRiskMinor,
    });

    const existingClaim = await this.store.getIdempotency(idempotencyKey);

    const policyDecision = evaluatePolicy({
      merchantId: context.recoveryCase.merchantId,
      strategy,
      amountMinor: context.recoveryCase.amountAtRiskMinor,
      expectedValueMinor: request.expectedValueMinor,
      recoveryProbability: context.recoveryCase.recoveryProbability ?? request.successProbability,
      case: {
        id: context.recoveryCase.id,
        status: context.recoveryCase.status,
        sourceType: context.recoveryCase.sourceType,
        failureReason: context.recoveryCase.failureReason,
        attemptCount: context.recoveryCase.attemptCount,
        notificationCount: context.recoveryCase.notificationCount,
        cooldownUntil: context.recoveryCase.cooldownUntil,
        lastActionAt: context.recoveryCase.lastActionAt,
        detectedAt: context.recoveryCase.detectedAt,
        spentMinor: await this.spentOnCase(context.recoveryCase.id),
      },
      customer: {
        id: context.customer.id,
        contactOptOut: context.customer.contactOptOut,
        doNotRetry: context.customer.doNotRetry,
        chargebackCount: context.customer.chargebackCount,
        timezone: context.customer.timezone,
        hasContactChannel: Boolean(context.customer.email || context.customer.phone),
      },
      mandateActive: context.mandateActive,
      contactsInLast24h: context.contactsInLast24h,
      // Read synchronously from the last published snapshot. Empty when detection has not
      // run, which lets recovery proceed rather than holding it on a stale detector.
      suppressedDimensions: this.incidents?.current(),
      instrument: { issuer: context.issuer, method: null },
      idempotencyHit: existingClaim !== null,
      aiDecisionId: request.aiDecisionId,
      nowIso,
      config: this.policyConfig,
    });

    await this.store.policyDecisions.put(policyDecision);
    await this.cases.appendTimeline(context.recoveryCase.id, {
      at: nowIso,
      kind: 'policy_evaluated',
      summary: `${label(strategy)}: ${policyDecision.verdict}${
        policyDecision.reasonCodes.length ? ` (${policyDecision.reasonCodes.join(', ')})` : ''
      }`,
      refId: policyDecision.id,
    });

    if (!isAllowed(policyDecision)) {
      const requiresHuman = policyDecision.verdict === 'require_human';

      // A denial whose only cause is the idempotency ledger is a suppressed duplicate,
      // not a guardrail block. Both prevent the double-charge, but recording it as a
      // policy block would undercount "duplicates prevented" and overcount "blocked by
      // policy" — and those two numbers mean very different things to a merchant.
      const isDuplicate =
        policyDecision.reasonCodes.length === 1 &&
        policyDecision.reasonCodes[0] === POLICY_REASON_CODES.DUPLICATE_ACTION;

      const action = await this.persistAction({
        context,
        strategy,
        status: isDuplicate ? 'skipped_duplicate' : 'blocked',
        idempotencyKey,
        aiDecisionId: request.aiDecisionId,
        policyDecisionId: policyDecision.id,
        providerRef: null,
        attempts: 0,
        error: `policy ${policyDecision.verdict}: ${policyDecision.reasonCodes.join(', ')}`,
        errorCode: policyDecision.reasonCodes[0] ?? 'POLICY_DENIED',
        durationMs: policyDecision.durationMs,
        nowIso,
      });

      await this.store.appendAudit({
        merchantId: context.recoveryCase.merchantId,
        actor: request.actor,
        event: isDuplicate ? 'action.duplicate_prevented' : 'action.blocked',
        trigger: request.trigger,
        caseId: context.recoveryCase.id,
        customerId: context.customer.id,
        amountMinor: context.recoveryCase.amountAtRiskMinor,
        aiDecisionId: request.aiDecisionId,
        policyDecisionId: policyDecision.id,
        actionId: action.id,
        actionStatus: isDuplicate ? 'skipped_duplicate' : 'blocked',
        failure: policyDecision.reasonCodes.join(', '),
        fallback: policyDecision.suggestedAlternative,
        at: nowIso,
        metadata: { strategy, verdict: policyDecision.verdict, idempotencyKey },
      });

      if (requiresHuman) {
        await this.cases.transition(context.recoveryCase.id, 'escalated', {
          at: nowIso,
          summary: `Routed for human approval: ${policyDecision.reasonCodes.join(', ')}`,
          reason: policyDecision.reasonCodes.join(', '),
        });
      }

      return {
        strategy,
        policyDecision,
        action,
        status: isDuplicate ? 'skipped_duplicate' : 'blocked',
        error: action.error,
        fallbackReason: requiresHuman
          ? 'Amount or confidence requires human approval.'
          : `Denied: ${policyDecision.reasonCodes.join(', ')}.`,
      };
    }

    // Policy allowed. Claim the key before the side effect, never after.
    const claim = await this.store.claimIdempotency({
      key: idempotencyKey,
      merchantId: context.recoveryCase.merchantId,
      scope: `action:${strategy}`,
      actionId: `pending:${context.recoveryCase.id}`,
    });

    if (!claim.claimed) {
      const action = await this.persistAction({
        context,
        strategy,
        status: 'skipped_duplicate',
        idempotencyKey,
        aiDecisionId: request.aiDecisionId,
        policyDecisionId: policyDecision.id,
        providerRef: claim.record.resultRef,
        attempts: 0,
        error: 'duplicate action suppressed',
        errorCode: 'DUPLICATE_ACTION',
        durationMs: 0,
        nowIso,
      });
      await this.store.appendAudit({
        merchantId: context.recoveryCase.merchantId,
        actor: request.actor,
        event: 'action.duplicate_prevented',
        trigger: request.trigger,
        caseId: context.recoveryCase.id,
        customerId: context.customer.id,
        amountMinor: context.recoveryCase.amountAtRiskMinor,
        actionId: action.id,
        actionStatus: 'skipped_duplicate',
        at: nowIso,
        metadata: { strategy, idempotencyKey },
      });
      return {
        strategy,
        policyDecision,
        action,
        status: 'skipped_duplicate',
        error: null,
        fallbackReason: null,
      };
    }

    const action = await this.persistAction({
      context,
      strategy,
      status: 'executing',
      idempotencyKey,
      aiDecisionId: request.aiDecisionId,
      policyDecisionId: policyDecision.id,
      providerRef: null,
      attempts: 0,
      error: null,
      errorCode: null,
      durationMs: null,
      nowIso,
    });

    const started = Date.now();
    try {
      const result = await this.performSideEffect({ request, action, idempotencyKey });
      const durationMs = Date.now() - started;

      const completed = await this.store.actions.patch(action.id, {
        status: result.status,
        providerRef: result.providerRef,
        attempts: result.attempts,
        error: result.error,
        errorCode: result.errorCode,
        completedAt: nowIso,
        durationMs,
        scheduledFor: result.scheduledFor,
      });

      await this.store.settleIdempotency(idempotencyKey, result.status, result.providerRef);

      await this.cases.appendTimeline(context.recoveryCase.id, {
        at: nowIso,
        kind: result.status === 'succeeded' ? 'action_executed' : 'action_failed',
        summary: result.summary,
        refId: completed.id,
        amountMinor: context.recoveryCase.amountAtRiskMinor,
      });

      await this.store.appendAudit({
        merchantId: context.recoveryCase.merchantId,
        actor: request.actor,
        event: result.status === 'succeeded' ? 'action.executed' : 'action.failed',
        trigger: request.trigger,
        caseId: context.recoveryCase.id,
        customerId: context.customer.id,
        amountMinor: context.recoveryCase.amountAtRiskMinor,
        aiDecisionId: request.aiDecisionId,
        policyDecisionId: policyDecision.id,
        actionId: completed.id,
        actionStatus: result.status,
        failure: result.error,
        at: nowIso,
        metadata: {
          strategy,
          providerRef: result.providerRef,
          providerMode: this.mode,
          simulated: result.simulated,
          attempts: result.attempts,
        },
      });

      if (result.status === 'succeeded') {
        await this.cases.recordActionTaken(context.recoveryCase.id, {
          strategy,
          at: nowIso,
          cooldownHours: this.policyConfig.cooldownHours,
          isRetry: RETRY_STRATEGIES.has(strategy),
          isContact: CONTACT_STRATEGIES.has(strategy),
        });
      }

      return {
        strategy,
        policyDecision,
        action: completed,
        status: result.status,
        error: result.error,
        fallbackReason: result.error,
      };
    } catch (raw) {
      const error = toReclaimError(raw);
      const durationMs = Date.now() - started;

      const failed = await this.store.actions.patch(action.id, {
        status: 'failed',
        error: error.message,
        errorCode: error.code,
        completedAt: nowIso,
        durationMs,
      });
      await this.store.settleIdempotency(idempotencyKey, 'failed', null);

      await this.cases.appendTimeline(context.recoveryCase.id, {
        at: nowIso,
        kind: 'action_failed',
        summary: `${label(strategy)} failed: ${error.message}`,
        refId: failed.id,
      });

      await this.store.appendAudit({
        merchantId: context.recoveryCase.merchantId,
        actor: request.actor,
        event: 'action.failed',
        trigger: request.trigger,
        caseId: context.recoveryCase.id,
        customerId: context.customer.id,
        amountMinor: context.recoveryCase.amountAtRiskMinor,
        aiDecisionId: request.aiDecisionId,
        policyDecisionId: policyDecision.id,
        actionId: failed.id,
        actionStatus: 'failed',
        failure: `${error.code}: ${error.message}`,
        at: nowIso,
        metadata: { strategy, retryable: error.retryable },
      });

      this.logger.warn('action execution failed', {
        caseId: context.recoveryCase.id,
        strategy,
        code: error.code,
      });

      return {
        strategy,
        policyDecision,
        action: failed,
        status: 'failed',
        error: error.message,
        fallbackReason: `${error.code}: ${error.message}`,
      };
    }
  }

  /** Dispatch to the correct provider call for the strategy. */
  private async performSideEffect(input: {
    request: ExecuteActionRequest;
    action: RecoveryAction;
    idempotencyKey: string;
  }): Promise<{
    status: ActionStatus;
    providerRef: string | null;
    attempts: number;
    error: string | null;
    errorCode: string | null;
    summary: string;
    simulated: boolean;
    scheduledFor: string | null;
  }> {
    const { request, idempotencyKey } = input;
    const { context, strategy } = request;
    const breaker = this.circuits.get(`provider:${this.payments.identity.name}`, {
      failureThreshold: 4,
      resetTimeoutMs: 12_000,
    });

    switch (strategy) {
      case 'immediate_retry':
      case 'delayed_retry': {
        const delayHours = strategy === 'delayed_retry' ? context.profile.optimalDelayHours || 6 : 0;
        const { value, attempts } = await withRetry(
          () =>
            breaker.execute(() =>
              this.payments.retryPayment({
                idempotencyKey,
                caseId: context.recoveryCase.id,
                customerId: context.customer.id,
                customerEmail: context.customer.email,
                customerPhone: context.customer.phone,
                amountMinor: context.recoveryCase.amountAtRiskMinor,
                currency: 'INR',
                method: context.recoveryCase.method,
                issuer: context.issuer,
                originalFailureReason: context.recoveryCase.failureReason,
                successProbability: request.successProbability,
                description: `RECLAIM recovery for case ${context.recoveryCase.id}`,
              }),
            ),
          {
            label: `retry_payment:${context.recoveryCase.id}`,
            logger: this.logger,
            policy: { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1_200 },
            ...(this.sleep ? { sleep: this.sleep } : {}),
          },
        );

        await this.recordPaymentAttempt(context, value, strategy);

        if (value.status === 'captured') {
          return {
            status: 'succeeded',
            providerRef: value.providerRef,
            attempts,
            error: null,
            errorCode: null,
            summary: `${label(strategy)} captured ${(value.amountMinor / 100).toFixed(2)} INR via ${this.payments.identity.name}.`,
            simulated: value.simulated,
            scheduledFor: delayHours > 0 ? addHours(context.nowIso, delayHours) : null,
          };
        }
        return {
          status: 'failed',
          providerRef: value.providerRef,
          attempts,
          error: `provider declined: ${value.failureReason ?? 'unknown'}`,
          errorCode: value.errorCode,
          summary: `${label(strategy)} declined (${value.failureReason ?? 'unknown reason'}).`,
          simulated: value.simulated,
          scheduledFor: null,
        };
      }

      case 'payment_link': {
        const { value, attempts } = await withRetry(
          () =>
            breaker.execute(() =>
              this.payments.createPaymentLink({
                idempotencyKey,
                caseId: context.recoveryCase.id,
                customerId: context.customer.id,
                customerName: context.customer.name,
                customerEmail: context.customer.email,
                customerPhone: context.customer.phone,
                amountMinor: context.recoveryCase.amountAtRiskMinor,
                currency: 'INR',
                description: `Payment for your ${context.profile.label.toLowerCase()} — case ${context.recoveryCase.id}`,
                expiresInHours: 72,
                successProbability: request.successProbability,
              }),
            ),
          {
            label: `payment_link:${context.recoveryCase.id}`,
            logger: this.logger,
            policy: { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1_200 },
            ...(this.sleep ? { sleep: this.sleep } : {}),
          },
        );

        const link: PaymentLink = {
          id: newId('plink'),
          merchantId: context.recoveryCase.merchantId,
          caseId: context.recoveryCase.id,
          customerId: context.customer.id,
          amountMinor: value.amountMinor,
          shortUrl: value.shortUrl,
          status: 'created',
          createdAt: context.nowIso,
          expiresAt: value.expiresAt,
          paidAt: null,
          providerRef: value.providerRef,
        };
        await this.store.paymentLinks.put(link);
        await this.deliverNotification(context, 'payment_link', idempotencyKey, link.shortUrl);

        return {
          status: 'succeeded',
          providerRef: value.providerRef,
          attempts,
          error: null,
          errorCode: null,
          summary: `Payment link issued for ${(value.amountMinor / 100).toFixed(2)} INR, valid 72h.`,
          simulated: value.simulated,
          scheduledFor: null,
        };
      }

      case 'customer_notification': {
        const result = await this.deliverNotification(
          context,
          'customer_notification',
          idempotencyKey,
          null,
        );
        if (result.status === 'sent') {
          return {
            status: 'succeeded',
            providerRef: result.providerRef,
            attempts: 1,
            error: null,
            errorCode: null,
            summary: `Recovery notice sent via ${result.channel}.`,
            simulated: true,
            scheduledFor: null,
          };
        }
        return {
          status: 'failed',
          providerRef: result.providerRef,
          attempts: 1,
          error: result.error,
          errorCode: 'NOTIFICATION_FAILED',
          summary: `Notification via ${result.channel} failed: ${result.error}.`,
          simulated: true,
          scheduledFor: null,
        };
      }

      case 'escalate': {
        await this.cases.transition(context.recoveryCase.id, 'escalated', {
          at: context.nowIso,
          summary: 'Escalated to a human operator for review.',
          reason: 'expected value or risk profile requires human judgement',
        });
        return {
          status: 'succeeded',
          providerRef: null,
          attempts: 1,
          error: null,
          errorCode: null,
          summary: 'Case routed to a human operator.',
          simulated: false,
          scheduledFor: null,
        };
      }

      case 'stop_recovery': {
        await this.cases.transition(context.recoveryCase.id, 'stopped', {
          at: context.nowIso,
          summary: 'Recovery stopped: no remaining intervention has positive expected value.',
        });
        return {
          status: 'succeeded',
          providerRef: null,
          attempts: 1,
          error: null,
          errorCode: null,
          summary: 'Recovery stopped; further intervention would destroy value.',
          simulated: false,
          scheduledFor: null,
        };
      }
    }
  }

  private async recordPaymentAttempt(
    context: CaseContext,
    result: { providerRef: string; status: 'captured' | 'failed'; failureReason: unknown; latencyMs: number },
    strategy: RecoveryStrategy,
  ): Promise<void> {
    const payment: Payment = {
      id: newId('pay'),
      merchantId: context.recoveryCase.merchantId,
      customerId: context.customer.id,
      amountMinor: context.recoveryCase.amountAtRiskMinor,
      currency: 'INR',
      method: context.recoveryCase.method,
      issuer: context.issuer,
      network: null,
      status: result.status,
      source: 'recovery',
      failureReason: (result.failureReason as Payment['failureReason']) ?? null,
      errorCode: null,
      createdAt: context.nowIso,
      capturedAt: result.status === 'captured' ? context.nowIso : null,
      subscriptionId: null,
      invoiceId: null,
      recoveryCaseId: context.recoveryCase.id,
      idempotencyKey: result.providerRef,
      providerRef: result.providerRef,
    };
    await this.store.payments.put(payment);

    await this.store.paymentAttempts.put({
      id: newId('att'),
      merchantId: context.recoveryCase.merchantId,
      paymentId: payment.id,
      customerId: context.customer.id,
      attemptNumber: context.recoveryCase.attemptCount + 1,
      status: result.status,
      failureReason: (result.failureReason as Payment['failureReason']) ?? null,
      gatewayLatencyMs: Math.round(result.latencyMs),
      createdAt: context.nowIso,
      initiatedByRecovery: true,
    });

    this.logger.debug('recovery payment attempt recorded', {
      caseId: context.recoveryCase.id,
      strategy,
      status: result.status,
    });
  }

  private async deliverNotification(
    context: CaseContext,
    kind: 'payment_link' | 'customer_notification',
    idempotencyKey: string,
    linkUrl: string | null,
  ): Promise<{ status: 'sent' | 'failed'; providerRef: string; channel: string; error: string | null }> {
    const rendered = renderNotification({
      kind,
      customerName: context.customer.name,
      amountMinor: context.recoveryCase.amountAtRiskMinor,
      profile: context.profile,
      linkUrl,
      merchantName: 'your account',
    });

    const notification: Notification = {
      id: newId('ntf'),
      merchantId: context.recoveryCase.merchantId,
      caseId: context.recoveryCase.id,
      customerId: context.customer.id,
      channel: context.customer.contactPreference,
      template: rendered.template,
      subject: rendered.subject,
      body: rendered.body,
      status: 'queued',
      createdAt: context.nowIso,
      sentAt: null,
      suppressionReason: null,
    };
    await this.store.notifications.put(notification);

    const result = await this.notifications.send({
      idempotencyKey: `${idempotencyKey}:msg`,
      caseId: context.recoveryCase.id,
      customerId: context.customer.id,
      channel: context.customer.contactPreference,
      to: context.customer.contactPreference === 'sms' ? context.customer.phone : context.customer.email,
      subject: rendered.subject,
      body: rendered.body,
    });

    await this.store.notifications.patch(notification.id, {
      status: result.status === 'sent' ? 'sent' : 'failed',
      sentAt: result.status === 'sent' ? context.nowIso : null,
      suppressionReason: result.error,
    });

    return {
      status: result.status,
      providerRef: result.providerRef,
      channel: result.channel,
      error: result.error,
    };
  }

  /**
   * Record the measured result. This is where predicted probability meets reality, and
   * it is the row the calibration chart and the recovery-rate metric are computed from.
   */
  private async recordOutcome(input: {
    context: CaseContext;
    strategy: RecoveryStrategy;
    action: RecoveryAction | null;
    successProbability: number;
    nowIso: string;
  }): Promise<{ outcome: RecoveryOutcome; recoveredAmountMinor: number; note: string }> {
    const { context, strategy, nowIso } = input;

    // Only a captured payment recovers money. A link that was issued but not yet paid,
    // a message that was delivered, an escalation that was routed — none of these have
    // recovered anything yet, and recording them as revenue would be a lie.
    const recovered = RETRY_STRATEGIES.has(strategy);
    const recoveredAmountMinor = recovered ? context.recoveryCase.amountAtRiskMinor : 0;

    const outcomeKind: OutcomeKind = recovered
      ? 'recovered'
      : strategy === 'escalate'
        ? 'escalated_to_human'
        : strategy === 'stop_recovery'
          ? 'stopped'
          : 'awaiting_customer';

    const outcome: RecoveryOutcome = {
      id: newId('out'),
      merchantId: context.recoveryCase.merchantId,
      caseId: context.recoveryCase.id,
      actionId: input.action?.id ?? null,
      outcome: outcomeKind,
      recoveredAmountMinor,
      amountAtRiskMinor: context.recoveryCase.amountAtRiskMinor,
      strategy,
      predictedProbability: input.successProbability,
      timeToOutcomeMs: Math.max(0, parseIso(nowIso) - parseIso(context.recoveryCase.detectedAt)),
      recordedAt: nowIso,
    };
    await this.store.outcomes.put(outcome);

    if (recovered) {
      await this.cases.markRecovered(context.recoveryCase.id, recoveredAmountMinor, nowIso);
    } else if (outcomeKind === 'awaiting_customer') {
      const current = await this.store.cases.get(context.recoveryCase.id);
      if (current && CaseService.isActionable(current) && current.status !== 'in_progress') {
        await this.cases.transition(context.recoveryCase.id, 'in_progress', {
          at: nowIso,
          summary: `${label(strategy)} delivered; awaiting customer action.`,
        });
      }
    }

    await this.cases.appendTimeline(context.recoveryCase.id, {
      at: nowIso,
      kind: 'outcome_recorded',
      summary:
        outcomeKind === 'recovered'
          ? `Recovered ${(recoveredAmountMinor / 100).toFixed(2)} INR (predicted ${(input.successProbability * 100).toFixed(0)}%).`
          : `Outcome: ${outcomeKind.replace(/_/g, ' ')}.`,
      refId: outcome.id,
      amountMinor: recoveredAmountMinor,
    });

    await this.store.appendAudit({
      merchantId: context.recoveryCase.merchantId,
      actor: { kind: 'system', id: 'outcome_tracker' },
      event: 'outcome.recorded',
      trigger: `strategy:${strategy}`,
      caseId: context.recoveryCase.id,
      customerId: context.customer.id,
      amountMinor: recoveredAmountMinor,
      actionId: input.action?.id ?? null,
      finalOutcome: outcomeKind,
      at: nowIso,
      metadata: { predictedProbability: input.successProbability, strategy },
    });

    return {
      outcome,
      recoveredAmountMinor,
      note:
        outcomeKind === 'recovered'
          ? `Recovered ${(recoveredAmountMinor / 100).toFixed(2)} INR against a predicted ${(input.successProbability * 100).toFixed(0)}% chance.`
          : `Action completed; outcome recorded as ${outcomeKind.replace(/_/g, ' ')}.`,
    };
  }

  /**
   * Close out a case that exhausted its options without recovering.
   *
   * Returns the outcome it recorded. An earlier version wrote the row but returned
   * nothing, leaving `ExecutionResult.outcome` null — so a case stopped by a guardrail was
   * reported to the UI as "action failed", which is a different thing entirely.
   */
  private async closeUnrecovered(
    context: CaseContext,
    strategy: RecoveryStrategy,
    step: ExecutionStep,
    successProbability: number,
  ): Promise<RecoveryOutcome> {
    const nowIso = context.nowIso;
    const outcome: RecoveryOutcome = {
      id: newId('out'),
      merchantId: context.recoveryCase.merchantId,
      caseId: context.recoveryCase.id,
      actionId: step.action?.id ?? null,
      outcome: step.status === 'blocked' ? 'stopped' : 'action_failed',
      recoveredAmountMinor: 0,
      amountAtRiskMinor: context.recoveryCase.amountAtRiskMinor,
      strategy,
      predictedProbability: successProbability,
      timeToOutcomeMs: Math.max(0, parseIso(nowIso) - parseIso(context.recoveryCase.detectedAt)),
      recordedAt: nowIso,
    };
    await this.store.outcomes.put(outcome);

    // An unrecovered close is as much a financial event as a recovery, and the audit
    // trail has to say so. Recording the outcome row without an audit entry would leave
    // a case that quietly stopped with no explanation anywhere in the chain.
    await this.store.appendAudit({
      merchantId: context.recoveryCase.merchantId,
      actor: { kind: 'system', id: 'outcome_tracker' },
      event: 'outcome.recorded',
      trigger: `strategy:${strategy}`,
      caseId: context.recoveryCase.id,
      customerId: context.customer.id,
      amountMinor: 0,
      actionId: step.action?.id ?? null,
      policyDecisionId: step.policyDecision.id,
      failure: step.error,
      finalOutcome: outcome.outcome,
      at: nowIso,
      metadata: {
        strategy,
        predictedProbability: successProbability,
        blocked: step.status === 'blocked',
        reasonCodes: step.policyDecision.reasonCodes.join(',') || null,
      },
    });

    await this.cases.appendTimeline(context.recoveryCase.id, {
      at: nowIso,
      kind: 'outcome_recorded',
      summary:
        step.status === 'blocked'
          ? `No permitted action remained (${step.policyDecision.reasonCodes.join(', ') || 'policy denial'}).`
          : `Every available intervention was exhausted. Last failure: ${step.error ?? 'unknown'}.`,
      refId: outcome.id,
      amountMinor: 0,
    });

    const current = await this.store.cases.get(context.recoveryCase.id);
    if (current && CaseService.isActionable(current)) {
      const terminal = step.status === 'blocked' ? 'stopped' : 'unrecoverable';
      await this.cases.transition(context.recoveryCase.id, terminal, {
        at: nowIso,
        summary:
          step.status === 'blocked'
            ? `Stopped: policy left no permitted action (${step.policyDecision.reasonCodes.join(', ')}).`
            : `Exhausted every available intervention. Last failure: ${step.error ?? 'unknown'}.`,
      });
    }

    return outcome;
  }

  private async spentOnCase(caseId: string): Promise<number> {
    const actions = await this.store.actions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    return actions
      .filter((a) => a.status === 'succeeded' || a.status === 'failed')
      .reduce((sum, a) => sum + totalInterventionCost(a.strategy, 0), 0);
  }

  private async persistAction(input: {
    context: CaseContext;
    strategy: RecoveryStrategy;
    status: ActionStatus;
    idempotencyKey: string;
    aiDecisionId: string | null;
    policyDecisionId: string | null;
    providerRef: string | null;
    attempts: number;
    error: string | null;
    errorCode: string | null;
    durationMs: number | null;
    nowIso: string;
  }): Promise<RecoveryAction> {
    const action: RecoveryAction = {
      id: newId('act'),
      merchantId: input.context.recoveryCase.merchantId,
      caseId: input.context.recoveryCase.id,
      customerId: input.context.customer.id,
      strategy: input.strategy,
      amountMinor: input.context.recoveryCase.amountAtRiskMinor,
      status: input.status,
      idempotencyKey: input.idempotencyKey,
      aiDecisionId: input.aiDecisionId,
      policyDecisionId: input.policyDecisionId,
      providerRef: input.providerRef,
      providerMode: this.mode,
      attempts: input.attempts,
      error: input.error,
      errorCode: input.errorCode,
      fallbackOfActionId: null,
      scheduledFor: null,
      createdAt: input.nowIso,
      completedAt: input.status === 'executing' ? null : input.nowIso,
      durationMs: input.durationMs,
    };
    return this.store.actions.put(action);
  }
}

function label(strategy: RecoveryStrategy): string {
  return strategy.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function isRetryStrategy(strategy: RecoveryStrategy): boolean {
  return RETRY_STRATEGIES.has(strategy);
}

export function isContactStrategy(strategy: RecoveryStrategy): boolean {
  return CONTACT_STRATEGIES.has(strategy);
}

