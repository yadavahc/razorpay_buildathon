import { type CaseProfile, resolveCaseProfile } from '../domain/case-profiles.js';
import { errors } from '../errors/index.js';
import {
  type CustomerContext,
  type GraphFeatures,
  type OpportunityGraph,
  buildCaseGraph,
  deriveGraphFeatures,
} from '../graph/opportunity-graph.js';
import type { RecoveryFeatureInput } from '../ml/features.js';
import type { Customer, RecoveryCase } from '../types/entities.js';
import type { DataStore } from '../store/types.js';
import { daysBetween, hoursBetween, localClock } from '../util/time.js';
import { clamp } from '../util/collections.js';

/**
 * Assembles everything the decisioning pipeline knows about a case, in one place.
 *
 * Every consumer — the model, the strategy engine, the policy engine, the agents, the UI —
 * reads from the object this service produces. Building it once, from one set of queries,
 * is what guarantees the number the model scored is the same number the merchant sees on
 * the case screen.
 */

export interface CaseContext {
  recoveryCase: RecoveryCase;
  customer: Customer;
  customerContext: CustomerContext;
  features: GraphFeatures;
  profile: CaseProfile;
  modelInput: RecoveryFeatureInput;
  /** Hours between the loss event and now, used everywhere decay is applied. */
  hoursSinceEvent: number;
  /** Contact events for this customer in the trailing 24 hours. */
  contactsInLast24h: number;
  mandateActive: boolean | null;
  issuer: string;
  nowIso: string;
}

export class ContextService {
  constructor(private readonly store: DataStore) {}

  async loadCustomerContext(customerId: string): Promise<CustomerContext> {
    const customer = await this.store.customers.get(customerId);
    if (!customer) throw errors.notFound('customer', customerId);

    const [payments, subscriptions, invoices, priorCases] = await Promise.all([
      this.store.payments.list({ where: [{ field: 'customerId', op: '==', value: customerId }] }),
      this.store.subscriptions.list({ where: [{ field: 'customerId', op: '==', value: customerId }] }),
      this.store.invoices.list({ where: [{ field: 'customerId', op: '==', value: customerId }] }),
      this.store.cases.list({ where: [{ field: 'customerId', op: '==', value: customerId }] }),
    ]);

    const [attempts, priorActions, priorOutcomes] = await Promise.all([
      this.store.paymentAttempts.list({
        where: [{ field: 'customerId', op: '==', value: customerId }],
      }),
      this.store.actions.list({ where: [{ field: 'customerId', op: '==', value: customerId }] }),
      this.loadOutcomesForCases(priorCases.map((c) => c.id)),
    ]);

    return {
      customer,
      payments: payments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
      attempts,
      subscriptions,
      invoices,
      priorCases,
      priorActions: priorActions.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
      priorOutcomes,
    };
  }

  private async loadOutcomesForCases(caseIds: readonly string[]) {
    if (caseIds.length === 0) return [];
    const groups = await Promise.all(
      caseIds.map((caseId) =>
        this.store.outcomes.list({ where: [{ field: 'caseId', op: '==', value: caseId }] }),
      ),
    );
    return groups.flat();
  }

  /**
   * Build the full context for a case. `asOfIso` defaults to now but can be pinned to a
   * historical instant, which is how the training pipeline reconstructs the exact
   * information a decision would have had at the time it was made.
   */
  async buildCaseContext(caseId: string, asOfIso?: string): Promise<CaseContext> {
    const recoveryCase = await this.store.cases.get(caseId);
    if (!recoveryCase) throw errors.notFound('recovery_case', caseId);
    return this.buildContextForCase(recoveryCase, asOfIso);
  }

  async buildContextForCase(recoveryCase: RecoveryCase, asOfIso?: string): Promise<CaseContext> {
    const nowIso = asOfIso ?? new Date().toISOString();
    const customerContext = await this.loadCustomerContext(recoveryCase.customerId);

    const sourcePayment =
      recoveryCase.sourceType === 'payment_failure' || recoveryCase.sourceType === 'subscription_dunning'
        ? await this.store.payments.get(recoveryCase.sourceId)
        : null;

    const checkoutSession =
      recoveryCase.sourceType === 'checkout_abandonment'
        ? await this.store.checkoutSessions.get(recoveryCase.sourceId)
        : null;

    const invoice =
      recoveryCase.sourceType === 'overdue_invoice'
        ? await this.store.invoices.get(recoveryCase.sourceId)
        : null;

    const daysOverdue = invoice ? Math.max(0, daysBetween(invoice.dueAt, nowIso)) : null;

    const profile = resolveCaseProfile({
      sourceType: recoveryCase.sourceType,
      failureReason: recoveryCase.failureReason,
      abandonmentStage: checkoutSession?.stage ?? null,
      daysOverdue,
    });

    const features = deriveGraphFeatures(customerContext, {
      asOfIso: nowIso,
      failingMethod: recoveryCase.method,
      failureKey: recoveryCase.failureReason,
    });

    const subscription =
      sourcePayment?.subscriptionId != null
        ? (customerContext.subscriptions.find((s) => s.id === sourcePayment.subscriptionId) ?? null)
        : recoveryCase.sourceType === 'subscription_dunning'
          ? (customerContext.subscriptions.find((s) => s.id === recoveryCase.sourceId) ?? null)
          : null;

    const hoursSinceEvent = clamp(hoursBetween(recoveryCase.detectedAt, nowIso), 0, 24 * 365);
    const contactsInLast24h = await this.countRecentContacts(recoveryCase.customerId, nowIso);
    const issuer = sourcePayment?.issuer ?? customerContext.payments.at(-1)?.issuer ?? 'unknown';

    const clock = localClock(nowIso, customerContext.customer.timezone);
    const isBusinessHours = clock.hour >= 9 && clock.hour < 19 && !clock.isWeekend;

    const modelInput: RecoveryFeatureInput = {
      amountMinor: recoveryCase.amountAtRiskMinor,
      profileKey: profile.key,
      baseRecoverability: profile.baseRecoverability,
      selfResolving: profile.selfResolving,
      customerActionRequired: profile.customerActionRequired,
      method: recoveryCase.method,
      issuer,
      segment: customerContext.customer.segment,
      sourceType: recoveryCase.sourceType,
      customerSuccessCount: features.successfulPaymentCount,
      customerFailureCount: features.failedPaymentCount,
      customerLifetimeValueMinor: features.lifetimeValueMinor,
      priorRecoveryAttempts: features.priorRecoveryAttempts,
      priorRecoverySuccesses: features.priorRecoverySuccesses,
      hoursSinceFailure: hoursSinceEvent,
      daysSinceLastSuccess: features.daysSinceLastSuccess,
      subscriptionAgeDays: features.subscriptionAgeDays,
      isSubscription: features.isSubscriber,
      attemptNumber: recoveryCase.attemptCount,
      hasAlternateSuccessfulMethod: features.hasAlternateSuccessfulMethod,
      isBusinessHours,
      bankDowntimeCluster: recoveryCase.failureReason === 'bank_downtime',
    };

    return {
      recoveryCase,
      customer: customerContext.customer,
      customerContext,
      features,
      profile,
      modelInput,
      hoursSinceEvent,
      contactsInLast24h,
      mandateActive: subscription ? subscription.mandateActive : null,
      issuer,
      nowIso,
    };
  }

  /** Outbound messages to this customer in the trailing 24 hours, across all cases. */
  async countRecentContacts(customerId: string, nowIso: string): Promise<number> {
    const notifications = await this.store.notifications.list({
      where: [{ field: 'customerId', op: '==', value: customerId }],
    });
    const cutoff = Date.parse(nowIso) - 24 * 60 * 60 * 1000;
    return notifications.filter(
      (n) => n.status === 'sent' && Date.parse(n.createdAt) >= cutoff,
    ).length;
  }

  buildGraph(context: CaseContext): OpportunityGraph {
    return buildCaseGraph(context.customerContext, context.recoveryCase, context.features);
  }
}
