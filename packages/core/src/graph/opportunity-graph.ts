import type {
  Customer,
  Invoice,
  Payment,
  PaymentAttempt,
  RecoveryCase,
  Subscription,
} from '../types/entities.js';
import type { RecoveryAction, RecoveryOutcome } from '../types/decisions.js';
import type { PaymentMethod } from '../types/enums.js';
import { daysBetween, hoursBetween, parseIso } from '../util/time.js';
import { clamp, round, unique } from '../util/collections.js';

/**
 * THE RECOVERY OPPORTUNITY GRAPH
 *
 * A failed payment is never an isolated row. A 9,999 rupee decline from a customer with
 * eight prior successful payments and a two-year subscription is a fundamentally different
 * object from the same decline on a first-time trial account, and treating them alike is
 * exactly how recovery engines waste money on the second and give up on the first.
 *
 * This module assembles the neighbourhood around a recovery case —
 *
 *   Customer -> Payments -> Failures -> Subscriptions -> Prior attempts
 *            -> Prior recoveries -> Interventions -> Outcomes
 *
 * — and does two things with it:
 *
 *   1. `deriveGraphFeatures` turns the neighbourhood into the relational features the
 *      probability model consumes. These are the features that cannot be read off the
 *      failed payment row alone, and they are where most of the model's lift comes from.
 *
 *   2. `buildCaseGraph` emits a typed node/edge projection that the case investigation
 *      screen renders, so a human sees the same evidence the model used.
 */

export type GraphNodeKind =
  | 'customer'
  | 'payment'
  | 'failure'
  | 'subscription'
  | 'invoice'
  | 'attempt'
  | 'case'
  | 'intervention'
  | 'outcome';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel: string;
  amountMinor: number | null;
  at: string | null;
  /** Drives node emphasis in the visualisation: 0 = context, 1 = focus. */
  weight: number;
  status: 'positive' | 'negative' | 'neutral' | 'focus';
  meta: Record<string, string | number | boolean | null>;
}

export type GraphEdgeKind =
  | 'made_payment'
  | 'failed_with'
  | 'subscribes_to'
  | 'billed_by'
  | 'attempted'
  | 'raised_case'
  | 'intervened_with'
  | 'resulted_in'
  | 'previously_recovered';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label: string;
  /** Edge strength in [0, 1]; the UI maps it to opacity and line weight. */
  strength: number;
}

export interface OpportunityGraph {
  focusNodeId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Plain-language reading of what the graph implies, shown above the visualisation. */
  narrative: string;
}

/** Everything the decisioning pipeline needs about one customer, assembled once. */
export interface CustomerContext {
  customer: Customer;
  payments: Payment[];
  attempts: PaymentAttempt[];
  subscriptions: Subscription[];
  invoices: Invoice[];
  priorCases: RecoveryCase[];
  priorActions: RecoveryAction[];
  priorOutcomes: RecoveryOutcome[];
}

export interface GraphFeatures {
  successfulPaymentCount: number;
  failedPaymentCount: number;
  successRatio: number;
  lifetimeValueMinor: number;
  distinctMethodCount: number;
  /** A method the customer has successfully paid with, other than the failing one. */
  hasAlternateSuccessfulMethod: boolean;
  alternateMethods: PaymentMethod[];
  daysSinceLastSuccess: number | null;
  daysSinceFirstPayment: number | null;
  priorRecoveryAttempts: number;
  priorRecoverySuccesses: number;
  priorRecoveryRate: number;
  /** Recovery rate on the same failure class for this specific customer. */
  sameReasonRecoveryRate: number | null;
  subscriptionAgeDays: number | null;
  isSubscriber: boolean;
  activeSubscriptionValueMinor: number;
  openInvoiceCount: number;
  overdueInvoiceValueMinor: number;
  consecutiveFailures: number;
  /** Payments in the last 30 days, a proxy for whether the account is still alive. */
  recentActivityCount: number;
}

const MAX_GRAPH_PAYMENTS = 12;

/**
 * Derive the relational features. Deliberately pure: it takes an already-assembled
 * context and a reference time, so training (which replays history) and serving (which
 * uses "now") go through exactly the same code.
 */
export function deriveGraphFeatures(
  context: CustomerContext,
  focus: { asOfIso: string; failingMethod: PaymentMethod; failureKey: string | null },
): GraphFeatures {
  const asOf = parseIso(focus.asOfIso);
  const history = context.payments.filter((p) => parseIso(p.createdAt) <= asOf);
  const successes = history.filter((p) => p.status === 'captured');
  const failures = history.filter((p) => p.status === 'failed');

  const successMethods = unique(successes.map((p) => p.method));
  const alternateMethods = successMethods.filter((m) => m !== focus.failingMethod);

  const lastSuccess = successes.at(-1) ?? null;
  const firstPayment = history[0] ?? null;

  const priorOutcomes = context.priorOutcomes.filter((o) => parseIso(o.recordedAt) <= asOf);
  const priorRecoverySuccesses = priorOutcomes.filter((o) => o.outcome === 'recovered').length;
  const priorRecoveryAttempts = priorOutcomes.length;

  const sameReasonCases = context.priorCases.filter(
    (c) => focus.failureKey !== null && c.failureReason === focus.failureKey,
  );
  const sameReasonResolved = sameReasonCases.filter((c) =>
    ['recovered', 'stopped', 'unrecoverable'].includes(c.status),
  );
  const sameReasonRecovered = sameReasonCases.filter((c) => c.status === 'recovered');

  const activeSubscriptions = context.subscriptions.filter((s) =>
    ['active', 'past_due'].includes(s.status),
  );
  const oldestSubscription = context.subscriptions
    .slice()
    .sort((a, b) => parseIso(a.startedAt) - parseIso(b.startedAt))[0];

  const overdueInvoices = context.invoices.filter((i) => i.status === 'overdue');

  // Consecutive failures counting back from the most recent payment.
  let consecutiveFailures = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.status === 'failed') consecutiveFailures++;
    else break;
  }

  const thirtyDaysAgo = asOf - 30 * 86_400_000;
  const recentActivityCount = history.filter((p) => parseIso(p.createdAt) >= thirtyDaysAgo).length;

  return {
    successfulPaymentCount: successes.length,
    failedPaymentCount: failures.length,
    successRatio: history.length === 0 ? 0 : round(successes.length / history.length),
    lifetimeValueMinor: successes.reduce((sum, p) => sum + p.amountMinor, 0),
    distinctMethodCount: unique(history.map((p) => p.method)).length,
    hasAlternateSuccessfulMethod: alternateMethods.length > 0,
    alternateMethods,
    daysSinceLastSuccess: lastSuccess
      ? round(Math.max(0, daysBetween(lastSuccess.createdAt, focus.asOfIso)), 2)
      : null,
    daysSinceFirstPayment: firstPayment
      ? round(Math.max(0, daysBetween(firstPayment.createdAt, focus.asOfIso)), 2)
      : null,
    priorRecoveryAttempts,
    priorRecoverySuccesses,
    priorRecoveryRate:
      priorRecoveryAttempts === 0 ? 0 : round(priorRecoverySuccesses / priorRecoveryAttempts),
    sameReasonRecoveryRate:
      sameReasonResolved.length === 0
        ? null
        : round(sameReasonRecovered.length / sameReasonResolved.length),
    subscriptionAgeDays: oldestSubscription
      ? round(Math.max(0, daysBetween(oldestSubscription.startedAt, focus.asOfIso)), 1)
      : null,
    isSubscriber: activeSubscriptions.length > 0,
    activeSubscriptionValueMinor: activeSubscriptions.reduce((s, sub) => s + sub.planAmountMinor, 0),
    openInvoiceCount: context.invoices.filter((i) => i.status === 'open').length,
    overdueInvoiceValueMinor: overdueInvoices.reduce((s, i) => s + i.amountMinor, 0),
    consecutiveFailures,
    recentActivityCount,
  };
}

/**
 * Build the visual projection of the neighbourhood. Bounded to the most recent
 * `MAX_GRAPH_PAYMENTS` payments so the rendered graph stays readable on a 27" screen and
 * on a laptop alike.
 */
export function buildCaseGraph(
  context: CustomerContext,
  recoveryCase: RecoveryCase,
  features: GraphFeatures,
): OpportunityGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const push = (node: GraphNode): string => {
    nodes.push(node);
    return node.id;
  };
  const link = (
    from: string,
    to: string,
    kind: GraphEdgeKind,
    label: string,
    strength = 0.5,
  ): void => {
    edges.push({ id: `${from}->${to}:${kind}`, from, to, kind, label, strength: round(strength, 3) });
  };

  const customerId = push({
    id: context.customer.id,
    kind: 'customer',
    label: context.customer.name,
    sublabel: `${context.customer.segment} · ${features.successfulPaymentCount} successful payments`,
    amountMinor: features.lifetimeValueMinor,
    at: context.customer.createdAt,
    weight: 0.9,
    status: 'neutral',
    meta: {
      segment: context.customer.segment,
      successRatio: features.successRatio,
      lifetimeValueMinor: features.lifetimeValueMinor,
    },
  });

  const caseId = push({
    id: recoveryCase.id,
    kind: 'case',
    label: 'Recovery case',
    sublabel: recoveryCase.sourceType.replace(/_/g, ' '),
    amountMinor: recoveryCase.amountAtRiskMinor,
    at: recoveryCase.detectedAt,
    weight: 1,
    status: 'focus',
    meta: {
      status: recoveryCase.status,
      probability: recoveryCase.recoveryProbability,
      failureReason: recoveryCase.failureReason,
    },
  });
  link(customerId, caseId, 'raised_case', 'revenue at risk', 1);

  const recentPayments = context.payments
    .slice()
    .sort((a, b) => parseIso(b.createdAt) - parseIso(a.createdAt))
    .slice(0, MAX_GRAPH_PAYMENTS);

  for (const payment of recentPayments) {
    const isSource = payment.id === recoveryCase.sourceId;
    const succeeded = payment.status === 'captured';
    const nodeId = push({
      id: payment.id,
      kind: succeeded ? 'payment' : 'failure',
      label: succeeded ? 'Payment captured' : 'Payment failed',
      sublabel: `${payment.method.toUpperCase()} · ${payment.issuer}`,
      amountMinor: payment.amountMinor,
      at: payment.createdAt,
      weight: isSource ? 1 : succeeded ? 0.55 : 0.7,
      status: isSource ? 'focus' : succeeded ? 'positive' : 'negative',
      meta: {
        status: payment.status,
        failureReason: payment.failureReason,
        method: payment.method,
        issuer: payment.issuer,
        source: payment.source,
      },
    });
    link(
      customerId,
      nodeId,
      succeeded ? 'made_payment' : 'failed_with',
      succeeded ? 'paid' : (payment.failureReason ?? 'failed'),
      succeeded ? 0.45 : 0.7,
    );
    if (isSource) link(nodeId, caseId, 'raised_case', 'triggered case', 1);
  }

  for (const subscription of context.subscriptions.slice(0, 4)) {
    const nodeId = push({
      id: subscription.id,
      kind: 'subscription',
      label: subscription.planName,
      sublabel: `${subscription.status} · ${subscription.completedCycles} cycles billed`,
      amountMinor: subscription.planAmountMinor,
      at: subscription.startedAt,
      weight: 0.65,
      status: subscription.status === 'active' ? 'positive' : 'negative',
      meta: {
        status: subscription.status,
        mandateActive: subscription.mandateActive,
        failedCycles: subscription.failedCycles,
        interval: subscription.interval,
      },
    });
    link(customerId, nodeId, 'subscribes_to', `${subscription.interval} plan`, 0.6);
    if (recoveryCase.sourceType === 'subscription_dunning' && recoveryCase.sourceId === subscription.id) {
      link(nodeId, caseId, 'raised_case', 'dunning', 1);
    }
  }

  for (const invoice of context.invoices.filter((i) => i.status !== 'paid').slice(0, 4)) {
    const nodeId = push({
      id: invoice.id,
      kind: 'invoice',
      label: `Invoice ${invoice.number}`,
      sublabel: invoice.status,
      amountMinor: invoice.amountMinor,
      at: invoice.dueAt,
      weight: 0.5,
      status: invoice.status === 'overdue' ? 'negative' : 'neutral',
      meta: { status: invoice.status, dueAt: invoice.dueAt },
    });
    link(customerId, nodeId, 'billed_by', invoice.status, 0.45);
    if (recoveryCase.sourceId === invoice.id) link(nodeId, caseId, 'raised_case', 'overdue', 1);
  }

  // Prior interventions and what they produced — the memory that makes the graph useful.
  const outcomeByAction = new Map(context.priorOutcomes.map((o) => [o.actionId ?? '', o]));
  for (const action of context.priorActions.slice(-6)) {
    const nodeId = push({
      id: action.id,
      kind: 'intervention',
      label: action.strategy.replace(/_/g, ' '),
      sublabel: action.status,
      amountMinor: action.amountMinor,
      at: action.createdAt,
      weight: 0.5,
      status: action.status === 'succeeded' ? 'positive' : 'neutral',
      meta: { strategy: action.strategy, status: action.status, caseId: action.caseId },
    });
    link(customerId, nodeId, 'intervened_with', action.strategy.replace(/_/g, ' '), 0.4);

    const outcome = outcomeByAction.get(action.id);
    if (outcome) {
      const outcomeId = push({
        id: outcome.id,
        kind: 'outcome',
        label: outcome.outcome.replace(/_/g, ' '),
        sublabel:
          outcome.outcome === 'recovered'
            ? 'money recovered'
            : `predicted ${(outcome.predictedProbability * 100).toFixed(0)}%`,
        amountMinor: outcome.recoveredAmountMinor,
        at: outcome.recordedAt,
        weight: 0.45,
        status: outcome.outcome === 'recovered' ? 'positive' : 'negative',
        meta: { outcome: outcome.outcome, strategy: outcome.strategy },
      });
      link(nodeId, outcomeId, 'resulted_in', outcome.outcome.replace(/_/g, ' '), 0.55);
      if (outcome.outcome === 'recovered') {
        link(outcomeId, caseId, 'previously_recovered', 'precedent', 0.8);
      }
    }
  }

  return {
    focusNodeId: caseId,
    nodes,
    edges,
    narrative: describeGraph(context, recoveryCase, features),
  };
}

/**
 * Turn the graph into one paragraph a merchant can act on. This is deterministic prose
 * assembled from measured quantities — no model is asked to invent numbers here.
 */
export function describeGraph(
  context: CustomerContext,
  recoveryCase: RecoveryCase,
  features: GraphFeatures,
): string {
  const parts: string[] = [];
  const name = context.customer.name;
  const inr = (minor: number): string =>
    (minor / 100).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    });

  parts.push(
    `${inr(recoveryCase.amountAtRiskMinor)} is at risk from ${recoveryCase.sourceType.replace(/_/g, ' ')}.`,
  );

  if (features.successfulPaymentCount === 0) {
    parts.push(
      `${name} has never completed a payment, so this loss has no positive precedent to lean on.`,
    );
  } else {
    parts.push(
      `${name} has completed ${features.successfulPaymentCount} payment${
        features.successfulPaymentCount === 1 ? '' : 's'
      } worth ${inr(features.lifetimeValueMinor)} in total, a ${(features.successRatio * 100).toFixed(0)}% lifetime success rate.`,
    );
  }

  if (features.isSubscriber && features.subscriptionAgeDays !== null) {
    parts.push(
      `They hold an active subscription ${Math.round(features.subscriptionAgeDays)} days old, so the relationship — not just this charge — is what is at risk.`,
    );
  }

  if (features.priorRecoveryAttempts > 0) {
    parts.push(
      `RECLAIM has worked ${features.priorRecoveryAttempts} earlier case${
        features.priorRecoveryAttempts === 1 ? '' : 's'
      } for this customer and recovered ${features.priorRecoverySuccesses} of them (${(
        features.priorRecoveryRate * 100
      ).toFixed(0)}%).`,
    );
  }

  if (features.hasAlternateSuccessfulMethod) {
    parts.push(
      `They have previously paid successfully with ${features.alternateMethods
        .map((m) => m.toUpperCase())
        .join(' and ')}, which gives a working route around the failing instrument.`,
    );
  }

  if (features.consecutiveFailures >= 3) {
    parts.push(
      `The last ${features.consecutiveFailures} attempts have all failed, which is a churn signal rather than a transient one.`,
    );
  }

  if (features.overdueInvoiceValueMinor > 0) {
    parts.push(
      `A further ${inr(features.overdueInvoiceValueMinor)} sits in overdue invoices on the same account.`,
    );
  }

  return parts.join(' ');
}

/**
 * Opportunity ranking: amount at risk, weighted by how likely it is to come back and how
 * quickly it decays. Used by the Recovery Opportunity Map to order the work queue.
 */
export function priorityScore(input: {
  amountAtRiskMinor: number;
  recoveryProbability: number;
  hoursSinceDetection: number;
  isSubscriber: boolean;
  lifetimeValueMinor: number;
}): number {
  const expected = input.amountAtRiskMinor * input.recoveryProbability;
  // Recoverability decays with a ~72h half-life; acting early is worth real money.
  const decay = Math.pow(0.5, input.hoursSinceDetection / 72);
  const relationshipMultiplier =
    1 + (input.isSubscriber ? 0.25 : 0) + clamp(input.lifetimeValueMinor / 50_000_000, 0, 0.25);
  return round((expected / 100) * decay * relationshipMultiplier, 2);
}

/** Hours since detection, clamped so stale cases do not produce absurd decay values. */
export function hoursSince(iso: string, nowIso: string): number {
  return clamp(hoursBetween(iso, nowIso), 0, 24 * 365);
}
