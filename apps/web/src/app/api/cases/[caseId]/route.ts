import type { NextRequest } from 'next/server';
import { fail, ok } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import { errors, evaluateStrategies } from '@reclaim/core';

export const dynamic = 'force-dynamic';

/**
 * Everything the case investigation screen needs, in one round trip: the case, the
 * customer, the opportunity graph, the priced strategy table, every AI and policy
 * decision recorded against it, the actions taken and the outcomes measured.
 *
 * Assembled server-side rather than as six client fetches, because the screen is
 * meaningless until all of it has arrived.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const startedAt = Date.now();
  try {
    const { caseId } = await params;
    const engine = await getEngine();

    const recoveryCase = await engine.store.cases.get(caseId);
    if (!recoveryCase) throw errors.notFound('recovery_case', caseId);

    const context = await engine.context.buildContextForCase(recoveryCase);
    const graph = engine.context.buildGraph(context);

    const probability =
      recoveryCase.recoveryProbability ?? engine.prediction.predict(context.modelInput).probability;
    const prediction = engine.prediction.predict(context.modelInput);

    const strategies = evaluateStrategies({
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

    const [aiDecisions, policyDecisions, actions, outcomes, notifications, links] = await Promise.all([
      engine.store.aiDecisions.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
      engine.store.policyDecisions.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
      engine.store.actions.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
      engine.store.outcomes.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
      engine.store.notifications.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
      engine.store.paymentLinks.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
    ]);

    const auditEntries = await engine.store.auditLogs.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });

    return ok(
      {
        case: recoveryCase,
        customer: {
          id: context.customer.id,
          name: context.customer.name,
          email: context.customer.email,
          phone: context.customer.phone,
          segment: context.customer.segment,
          timezone: context.customer.timezone,
          contactPreference: context.customer.contactPreference,
          contactOptOut: context.customer.contactOptOut,
          doNotRetry: context.customer.doNotRetry,
          chargebackCount: context.customer.chargebackCount,
          createdAt: context.customer.createdAt,
        },
        profile: context.profile,
        features: context.features,
        prediction: {
          probability: prediction.probability,
          threshold: prediction.threshold,
          aboveThreshold: prediction.aboveThreshold,
          modelVersion: prediction.modelVersion,
          degraded: prediction.degraded,
          degradedReason: prediction.degradedReason,
          drivers: prediction.drivers.slice(0, 8),
        },
        strategies: strategies.candidates,
        recommended: strategies.best,
        graph,
        mandateActive: context.mandateActive,
        contactsInLast24h: context.contactsInLast24h,
        aiDecisions: aiDecisions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        policyDecisions: policyDecisions.sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1)),
        actions: actions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        outcomes: outcomes.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)),
        notifications,
        paymentLinks: links,
        audit: auditEntries.sort((a, b) => a.seq - b.seq),
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
