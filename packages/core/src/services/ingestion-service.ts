import { getFailureProfile } from '../domain/failure-taxonomy.js';
import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { CheckoutSession, Invoice, Payment, Subscription } from '../types/entities.js';
import type { DataStore } from '../store/types.js';
import { daysBetween } from '../util/time.js';
import { CaseService } from './case-service.js';

/**
 * DETECTION
 *
 * Turns raw payment activity into recovery cases. Four distinct revenue-loss families are
 * detected, and treating them as one problem is exactly the mistake that leaves money on
 * the table — a declined subscription renewal and an abandoned cart need different
 * evidence, different economics and different interventions.
 *
 *   1. payment_failure       — a one-off charge was declined
 *   2. subscription_dunning  — a recurring renewal was declined; the relationship is at risk
 *   3. checkout_abandonment  — the customer left before authorising
 *   4. overdue_invoice       — a receivable passed its due date
 *
 * Detection is idempotent at the source-event level: re-running ingestion over the same
 * corpus opens no duplicate cases, because `CaseService.createCase` de-duplicates on
 * `(merchantId, sourceId)`.
 */

export interface IngestionSummary {
  scanned: {
    payments: number;
    subscriptions: number;
    checkoutSessions: number;
    invoices: number;
  };
  created: {
    paymentFailure: number;
    subscriptionDunning: number;
    checkoutAbandonment: number;
    overdueInvoice: number;
  };
  skippedExisting: number;
  totalAtRiskMinor: number;
  durationMs: number;
}

export interface IngestionOptions {
  /** Cap the number of new cases created; used by the demo to keep runs snappy. */
  maxCases?: number;
  /** Only consider events at or after this instant. */
  sinceIso?: string;
  /** Minimum amount worth opening a case for. Below this, the overhead exceeds the value. */
  minAmountMinor?: number;
  nowIso?: string;
}

export class IngestionService {
  private readonly cases: CaseService;

  constructor(
    private readonly store: DataStore,
    private readonly logger: Logger = noopLogger,
  ) {
    this.cases = new CaseService(store);
  }

  async ingest(merchantId: string, options: IngestionOptions = {}): Promise<IngestionSummary> {
    const started = Date.now();
    const nowIso = options.nowIso ?? new Date().toISOString();
    const minAmountMinor = options.minAmountMinor ?? 5_000;
    const maxCases = options.maxCases ?? Number.MAX_SAFE_INTEGER;

    const [payments, subscriptions, sessions, invoices] = await Promise.all([
      this.store.payments.list({ where: [{ field: 'merchantId', op: '==', value: merchantId }] }),
      this.store.subscriptions.list({ where: [{ field: 'merchantId', op: '==', value: merchantId }] }),
      this.store.checkoutSessions.list({
        where: [{ field: 'merchantId', op: '==', value: merchantId }],
      }),
      this.store.invoices.list({ where: [{ field: 'merchantId', op: '==', value: merchantId }] }),
    ]);

    const created = {
      paymentFailure: 0,
      subscriptionDunning: 0,
      checkoutAbandonment: 0,
      overdueInvoice: 0,
    };
    let skippedExisting = 0;
    let totalAtRiskMinor = 0;
    let budget = maxCases;

    const after = (iso: string): boolean => !options.sinceIso || iso >= options.sinceIso;

    // --- 1 & 2. Declined payments -------------------------------------------
    // Only the most recent failure per customer-instrument pair opens a case: an older
    // decline that was already followed by a success is not revenue at risk.
    const failures = payments
      .filter((p) => p.status === 'failed' && after(p.createdAt) && p.amountMinor >= minAmountMinor)
      .filter((p) => p.source !== 'recovery')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    const supersededBySuccess = this.buildSupersededSet(payments);
    const subscriptionById = new Map(subscriptions.map((s) => [s.id, s]));

    for (const payment of failures) {
      if (budget <= 0) break;
      if (supersededBySuccess.has(payment.id)) continue;

      const isSubscriptionRenewal =
        payment.subscriptionId !== null && subscriptionById.has(payment.subscriptionId);

      const result = await this.openCase({
        merchantId,
        customerId: payment.customerId,
        sourceType: isSubscriptionRenewal ? 'subscription_dunning' : 'payment_failure',
        sourceId: payment.id,
        amountAtRiskMinor: payment.amountMinor,
        method: payment.method,
        failureReason: payment.failureReason,
        detectedAt: payment.createdAt,
        summary: this.describePaymentFailure(payment, isSubscriptionRenewal),
      });

      if (result.created) {
        budget -= 1;
        totalAtRiskMinor += payment.amountMinor;
        if (isSubscriptionRenewal) created.subscriptionDunning += 1;
        else created.paymentFailure += 1;
      } else {
        skippedExisting += 1;
      }
    }

    // --- 3. Abandoned checkouts ---------------------------------------------
    for (const session of sessions) {
      if (budget <= 0) break;
      if (session.convertedPaymentId !== null) continue;
      if (!after(session.abandonedAt)) continue;
      if (session.cartValueMinor < minAmountMinor) continue;

      const result = await this.openCase({
        merchantId,
        customerId: session.customerId,
        sourceType: 'checkout_abandonment',
        sourceId: session.id,
        amountAtRiskMinor: session.cartValueMinor,
        method: session.method ?? 'upi',
        failureReason: null,
        detectedAt: session.abandonedAt,
        summary: this.describeAbandonment(session),
      });

      if (result.created) {
        budget -= 1;
        totalAtRiskMinor += session.cartValueMinor;
        created.checkoutAbandonment += 1;
      } else {
        skippedExisting += 1;
      }
    }

    // --- 4. Overdue receivables ---------------------------------------------
    for (const invoice of invoices) {
      if (budget <= 0) break;
      if (invoice.status !== 'overdue') continue;
      if (!after(invoice.dueAt)) continue;
      if (invoice.amountMinor < minAmountMinor) continue;

      const result = await this.openCase({
        merchantId,
        customerId: invoice.customerId,
        sourceType: 'overdue_invoice',
        sourceId: invoice.id,
        amountAtRiskMinor: invoice.amountMinor,
        method: 'netbanking',
        failureReason: null,
        detectedAt: invoice.dueAt,
        summary: this.describeOverdue(invoice, nowIso),
      });

      if (result.created) {
        budget -= 1;
        totalAtRiskMinor += invoice.amountMinor;
        created.overdueInvoice += 1;
      } else {
        skippedExisting += 1;
      }
    }

    const summary: IngestionSummary = {
      scanned: {
        payments: payments.length,
        subscriptions: subscriptions.length,
        checkoutSessions: sessions.length,
        invoices: invoices.length,
      },
      created,
      skippedExisting,
      totalAtRiskMinor,
      durationMs: Date.now() - started,
    };

    this.logger.info('ingestion complete', {
      merchantId,
      created:
        created.paymentFailure +
        created.subscriptionDunning +
        created.checkoutAbandonment +
        created.overdueInvoice,
      skippedExisting,
      durationMs: summary.durationMs,
    });

    return summary;
  }

  /**
   * A failure followed by a later success on the same customer+instrument has already
   * self-resolved. Opening a case for it would inflate "revenue at risk" with money that
   * came back on its own.
   */
  private buildSupersededSet(payments: readonly Payment[]): Set<string> {
    const superseded = new Set<string>();
    const byKey = new Map<string, Payment[]>();

    for (const payment of payments) {
      const key = `${payment.customerId}:${payment.method}`;
      const list = byKey.get(key);
      if (list) list.push(payment);
      else byKey.set(key, [payment]);
    }

    for (const group of byKey.values()) {
      const ordered = [...group].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (let i = 0; i < ordered.length; i++) {
        const current = ordered[i]!;
        if (current.status !== 'failed') continue;
        const laterSuccess = ordered
          .slice(i + 1)
          .some((p) => p.status === 'captured' && p.amountMinor === current.amountMinor);
        if (laterSuccess) superseded.add(current.id);
      }
    }
    return superseded;
  }

  private async openCase(input: Parameters<CaseService['createCase']>[0]) {
    return this.cases.createCase(input);
  }

  private describePaymentFailure(payment: Payment, isSubscription: boolean): string {
    const reason = payment.failureReason ? getFailureProfile(payment.failureReason).label : 'unknown reason';
    const amount = (payment.amountMinor / 100).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    });
    return isSubscription
      ? `Subscription renewal of ${amount} declined on ${payment.method.toUpperCase()} via ${payment.issuer}: ${reason}.`
      : `Payment of ${amount} declined on ${payment.method.toUpperCase()} via ${payment.issuer}: ${reason}.`;
  }

  private describeAbandonment(session: CheckoutSession): string {
    const amount = (session.cartValueMinor / 100).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    });
    return `Checkout of ${amount} abandoned at the ${session.stage.replace(/_/g, ' ')} stage.`;
  }

  private describeOverdue(invoice: Invoice, nowIso: string): string {
    const amount = (invoice.amountMinor / 100).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    });
    const days = Math.max(0, Math.round(daysBetween(invoice.dueAt, nowIso)));
    return `Invoice ${invoice.number} for ${amount} is ${days} day${days === 1 ? '' : 's'} overdue.`;
  }

  /**
   * Ingest a single freshly-observed failed payment. This is the path a live webhook or
   * the demo's "generate a failure" button takes, as opposed to the batch scan above.
   */
  async ingestPayment(payment: Payment, subscription?: Subscription | null): Promise<string | null> {
    if (payment.status !== 'failed') return null;

    const isSubscriptionRenewal = Boolean(payment.subscriptionId && subscription);
    const result = await this.cases.createCase({
      merchantId: payment.merchantId,
      customerId: payment.customerId,
      sourceType: isSubscriptionRenewal ? 'subscription_dunning' : 'payment_failure',
      sourceId: payment.id,
      amountAtRiskMinor: payment.amountMinor,
      method: payment.method,
      failureReason: payment.failureReason,
      detectedAt: payment.createdAt,
      summary: this.describePaymentFailure(payment, isSubscriptionRenewal),
    });

    return result.created ? result.recoveryCase.id : result.recoveryCase.id;
  }
}
