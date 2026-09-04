import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, parseBody } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import {
  errors,
  failureReasonsForMethod,
  formatMinor,
  getFailureProfile,
  idempotencyKeyFor,
  newId,
  type FailureReason,
  type Payment,
} from '@reclaim/core';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Generate a brand-new failure rather than picking up an existing open case. */
  generateFailure: z.boolean().default(true),
  /** Pin the failure class so a demo can be rehearsed. */
  failureReason: z.string().optional(),
  /** Work an existing case instead. */
  caseId: z.string().optional(),
});

/**
 * RUN LIVE RECOVERY — the one-click story.
 *
 * Ingests a fresh payment failure, detects it, investigates it, scores it, prices every
 * strategy, runs the policy engine, executes, and measures the outcome — returning a
 * step-by-step trace the demo screen animates.
 *
 * Nothing here is staged. The steps are the actual pipeline phases, the probabilities are
 * the actual model output, and the recovered amount is whatever the provider actually
 * returned. A run can and sometimes does end with the money not recovered, which is the
 * point: a demo that always succeeds is not showing you a system, it is showing you a
 * video.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await parseBody(request, bodySchema);
    const engine = await getEngine();
    const merchantId = engine.merchantId;

    const steps: Array<{
      key: string;
      label: string;
      detail: string;
      at: string;
      ms: number;
      status: 'ok' | 'blocked' | 'failed';
    }> = [];
    let cursor = Date.now();
    const step = (
      key: string,
      label: string,
      detail: string,
      status: 'ok' | 'blocked' | 'failed' = 'ok',
    ): void => {
      const now = Date.now();
      steps.push({ key, label, detail, at: new Date().toISOString(), ms: now - cursor, status });
      cursor = now;
    };

    // ---- 1. Get a case to work -------------------------------------------
    let caseId: string;
    let generatedPayment: Payment | null = null;

    if (body.caseId) {
      caseId = body.caseId;
      const existing = await engine.store.cases.get(caseId);
      if (!existing) throw errors.notFound('recovery_case', caseId);
      step('detect', 'Case selected', `Working existing case ${caseId}.`);
    } else if (body.generateFailure) {
      generatedPayment = await generateFailedPayment(engine, body.failureReason as FailureReason | undefined);
      const created = await engine.ingestion.ingestPayment(generatedPayment);
      if (!created) throw errors.internal('failed to open a case for the generated failure');
      caseId = created;
      step(
        'detect',
        'Revenue loss detected',
        `${formatMinor(generatedPayment.amountMinor, { whole: true })} declined on ${generatedPayment.method.toUpperCase()} via ${generatedPayment.issuer} — ${getFailureProfile(generatedPayment.failureReason!).label}.`,
      );
    } else {
      const queue = await engine.cases.listWorkQueue(merchantId, { limit: 1 });
      const next = queue[0];
      if (!next) {
        throw errors.invalidState(
          'No open cases to work. Enable "generate a failure" or run detection first.',
        );
      }
      caseId = next.id;
      step('detect', 'Case selected', `Picked the highest-priority open case, ${caseId}.`);
    }

    // ---- 2..6 the pipeline ------------------------------------------------
    const result = await engine.decisions.runCase(caseId, {
      execute: true,
      actor: { kind: 'agent', id: 'agent:recovery_analyst' },
      trigger: 'demo:run_live_recovery',
    });

    const decision = result.aiDecision;
    const execution = result.execution;

    step(
      'investigate',
      'Analyst agent investigated',
      `${decision.toolCalls.length} evidence tools called. ${decision.diagnosis.headline}`,
    );
    step(
      'predict',
      'Recovery probability scored',
      `${(decision.recoveryProbability * 100).toFixed(1)}% recoverable per ${decision.modelVersion}. Top signal: ${decision.signals[0]?.label ?? 'n/a'}.`,
    );
    step(
      'strategise',
      'Strategies priced',
      `${decision.candidates.filter((c) => c.eligible).length} of ${decision.candidates.length} options available. Best expected value: ${decision.recommendedStrategy.replace(/_/g, ' ')} at ${formatMinor(decision.expectedValueMinor)}.`,
    );

    const firstPolicy = execution?.steps[0]?.policyDecision;
    step(
      'policy',
      'Guardrails evaluated',
      firstPolicy
        ? `${firstPolicy.checks.filter((c) => c.result === 'pass').length} checks passed, verdict ${firstPolicy.verdict}${firstPolicy.reasonCodes.length ? ` (${firstPolicy.reasonCodes.join(', ')})` : ''}.`
        : 'No policy decision recorded.',
      firstPolicy?.verdict === 'deny' ? 'blocked' : 'ok',
    );

    if (execution) {
      step(
        'execute',
        'Action executed',
        `${execution.finalStrategy.replace(/_/g, ' ')} → ${execution.finalStatus}${execution.fallbacksUsed > 0 ? ` after ${execution.fallbacksUsed} fallback${execution.fallbacksUsed === 1 ? '' : 's'}` : ''}. Provider: ${engine.paymentProvider.identity.name}.`,
        execution.finalStatus === 'succeeded'
          ? 'ok'
          : execution.blockedByPolicy
            ? 'blocked'
            : 'failed',
      );

      // An issued payment link that the customer has not paid yet is not a failure — it
      // is the expected state of a working intervention. Only an action that could not be
      // taken, or one whose money will never arrive, is reported as failed.
      const outcomeKind = execution.outcome?.outcome ?? 'action_failed';
      const measureStatus: 'ok' | 'blocked' | 'failed' =
        execution.recoveredAmountMinor > 0 || outcomeKind === 'awaiting_customer'
          ? 'ok'
          : outcomeKind === 'escalated_to_human' || outcomeKind === 'stopped'
            ? 'blocked'
            : 'failed';

      step(
        'measure',
        execution.recoveredAmountMinor > 0
          ? 'Revenue recovered'
          : outcomeKind === 'awaiting_customer'
            ? 'Awaiting the customer'
            : 'Outcome recorded',
        execution.recoveredAmountMinor > 0
          ? `${formatMinor(execution.recoveredAmountMinor, { whole: true })} captured and booked against the case.`
          : outcomeKind === 'awaiting_customer'
            ? 'The intervention was delivered. Nothing is booked as recovered until the customer actually pays — a link that has been sent is not revenue.'
            : `Outcome: ${outcomeKind.replace(/_/g, ' ')}. ${execution.notes.at(-1) ?? ''}`,
        measureStatus,
      );
    }

    const auditEntries = await engine.store.auditLogs.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    step('audit', 'Audit trail written', `${auditEntries.length} hash-chained entries recorded for this case.`);

    engine.analytics.invalidate();
    const [updatedCase, overview] = await Promise.all([
      engine.store.cases.get(caseId),
      engine.analytics.controlTower(merchantId),
    ]);

    return ok(
      {
        caseId,
        steps,
        aiDecision: decision,
        execution,
        case: updatedCase,
        audit: auditEntries.sort((a, b) => a.seq - b.seq),
        overview,
        recoveredAmountMinor: execution?.recoveredAmountMinor ?? 0,
        provider: engine.paymentProvider.identity,
        reasoner: decision.reasoner,
        totalMs: Date.now() - startedAt,
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}

/**
 * Synthesise a brand-new failed payment for an existing customer.
 *
 * It is attached to a real customer with real history, so the case that follows has a
 * genuine opportunity graph rather than an empty one.
 */
async function generateFailedPayment(
  engine: Awaited<ReturnType<typeof getEngine>>,
  forcedReason?: FailureReason,
): Promise<Payment> {
  const customers = await engine.store.customers.list({
    where: [{ field: 'merchantId', op: '==', value: engine.merchantId }],
  });
  if (customers.length === 0) {
    throw errors.invalidState('No customers in the corpus. Run "npm run seed" first.');
  }

  // Prefer a customer with a real payment history so the graph has something to show.
  const withHistory = customers.filter((c) => c.successfulPaymentCount >= 3 && !c.doNotRetry);
  const pool = withHistory.length > 0 ? withHistory : customers;
  const customer = pool[Math.floor(Math.random() * pool.length)]!;

  const history = await engine.store.payments.list({
    where: [{ field: 'customerId', op: '==', value: customer.id }],
  });
  const template = history.at(-1);

  const method = template?.method ?? customer.preferredMethod;

  // The failure must be possible on the instrument. A card-expired decline on a UPI
  // payment is nonsense, and shipping nonsense into the demo would undermine every
  // explanation the diagnosis engine then produces about it.
  const validReasons = failureReasonsForMethod(method).map((profile) => profile.reason);
  const reason: FailureReason =
    forcedReason && validReasons.includes(forcedReason)
      ? forcedReason
      : validReasons[Math.floor(Math.random() * validReasons.length)]!;

  const nowIso = new Date().toISOString();
  const amountMinor = template?.amountMinor ?? 249_900;

  const payment: Payment = {
    id: newId('pay'),
    merchantId: engine.merchantId,
    customerId: customer.id,
    amountMinor,
    currency: 'INR',
    method,
    issuer: template?.issuer ?? 'HDFC Bank',
    network: template?.network ?? null,
    status: 'failed',
    source: 'checkout',
    failureReason: reason,
    errorCode: getFailureProfile(reason).errorCode,
    createdAt: nowIso,
    capturedAt: null,
    subscriptionId: null,
    invoiceId: null,
    recoveryCaseId: null,
    idempotencyKey: idempotencyKeyFor({ demo: 'live_run', customer: customer.id, at: nowIso }),
    providerRef: null,
  };

  await engine.store.payments.put(payment);
  return payment;
}
