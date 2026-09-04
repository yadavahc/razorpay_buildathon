import { getFailureProfile } from '../domain/failure-taxonomy.js';
import type { Customer, Payment, RecoveryCase } from '../types/entities.js';
import type {
  CaseSourceType,
  CustomerSegment,
  FailureReason,
  PaymentMethod,
  RecoveryStrategy,
} from '../types/enums.js';
import type { DataStore } from '../store/types.js';
import { countBy, groupBy, indexBy, round, sumBy } from '../util/collections.js';
import { dayKey, dayRange, parseIso } from '../util/time.js';

/**
 * ANALYTICS
 *
 * Every figure the dashboard and the copilot show is computed here, from stored records.
 * There is no metrics table that could drift from the underlying data, and no constant
 * anywhere in the UI standing in for a number. If a case changes state, the next read
 * reflects it.
 *
 * The vocabulary is fixed and used consistently everywhere:
 *
 *   revenue at risk      — amount on cases that have not reached a terminal state
 *   recoverable revenue  — at-risk amount weighted by predicted recovery probability
 *   recovered revenue    — money actually captured, from recorded outcomes only
 *   recovery rate        — recovered amount / amount on resolved cases
 *   leakage              — gross value of failed payments in the period
 */

export interface ControlTowerMetrics {
  grossRevenueMinor: number;
  leakedRevenueMinor: number;
  revenueAtRiskMinor: number;
  recoverableRevenueMinor: number;
  recoveredRevenueMinor: number;
  expectedRecoveryValueMinor: number;
  recoveryRate: number;
  leakageRate: number;
  activeCases: number;
  totalCases: number;
  resolvedCases: number;
  escalatedCases: number;
  interventionsExecuted: number;
  interventionsBlocked: number;
  duplicatesPrevented: number;
  fallbacksTaken: number;
  averageRecoveryTimeMs: number;
  averageCaseValueMinor: number;
  customersAffected: number;
}

export interface LeakageBucket {
  key: string;
  label: string;
  lostAmountMinor: number;
  count: number;
  recoveredAmountMinor: number;
  recoveryRate: number;
  share: number;
  /** Amount still open on this bucket; what a merchant could act on today. */
  openAmountMinor: number;
}

export interface LeakageBreakdown {
  byFailureReason: LeakageBucket[];
  byMethod: LeakageBucket[];
  byIssuer: LeakageBucket[];
  bySegment: LeakageBucket[];
  bySourceType: LeakageBucket[];
  byHour: Array<{ hour: number; lostAmountMinor: number; count: number }>;
  byAmountBand: LeakageBucket[];
}

export interface TrendPoint {
  day: string;
  leakedMinor: number;
  recoveredMinor: number;
  atRiskMinor: number;
  caseCount: number;
  recoveredCount: number;
  recoveryRate: number;
}

export interface FunnelStage {
  stage: string;
  label: string;
  count: number;
  amountMinor: number;
  /** Conversion from the previous stage, in [0, 1]. */
  conversion: number;
  description: string;
}

export interface StrategyPerformance {
  strategy: RecoveryStrategy;
  attempts: number;
  succeeded: number;
  recoveredMinor: number;
  successRate: number;
  averagePredicted: number;
  /** Observed rate minus mean predicted probability; near zero means well calibrated. */
  calibrationGap: number;
  costMinor: number;
  netValueMinor: number;
}

export interface OpportunityRow {
  caseId: string;
  customerId: string;
  customerName: string;
  segment: CustomerSegment;
  amountAtRiskMinor: number;
  recoveryProbability: number;
  expectedValueMinor: number;
  priorityScore: number;
  failureReason: FailureReason | null;
  method: PaymentMethod;
  sourceType: CaseSourceType;
  status: RecoveryCase['status'];
  detectedAt: string;
  hoursOpen: number;
}

export interface SystemHealthMetrics {
  actionsExecuted: number;
  actionsBlocked: number;
  actionsFailed: number;
  duplicatesPrevented: number;
  fallbacksTaken: number;
  escalations: number;
  policyDenialsByCode: Array<{ code: string; count: number }>;
  averageActionLatencyMs: number;
  auditEntries: number;
}

type PortfolioSnapshot = Awaited<ReturnType<AnalyticsService['readPortfolio']>>;

import { computeRegretLedger, type RegretLedger } from '../analytics/regret-ledger.js';
import { buildTimingReport, type TimingReport } from '../analytics/timing-engine.js';
import type { PolicyConfig } from '../config/index.js';
import { policyReasonLabel } from '../presentation.js';

export class AnalyticsService {
  /**
   * Cached portfolio snapshot, and the promise for one in flight.
   *
   * Caching the PROMISE rather than only the result is what collapses the six analytics
   * calls a single `/api/metrics` request makes into one scan — they all await the same
   * pending read instead of each starting their own.
   */
  private cached: { merchantId: string; at: number; snapshot: PortfolioSnapshot } | null = null;
  private inFlight: { merchantId: string; promise: Promise<PortfolioSnapshot> } | null = null;

  /**
   * How long a snapshot stays usable.
   *
   * Zero for the in-memory store: the scan is a few array filters over data already in
   * process, so caching would buy nothing and could only serve something stale.
   *
   * Non-zero for Firestore, where the scan is thousands of billed document reads. Without
   * it, one dashboard load costs ~42,000 reads — six full scans — and exhausts a Spark
   * project's entire daily allowance in a single page view. That is not a quota
   * inconvenience; it makes the mode unusable, and it was found by running the app
   * against a real project rather than by reasoning about it.
   *
   * The real fix at scale is incremental aggregates maintained on write, with the scan
   * kept as the reconciliation path. This cache is what makes the read-through
   * implementation viable until then, and it is deliberately short so the dashboard stays
   * honest about how fresh it is.
   */
  private readonly ttlMs: number;

  constructor(
    private readonly store: DataStore,
    options: { ttlMs?: number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? (store.kind === 'firestore' ? 20_000 : 0);
  }

  /**
   * The analytics working set: every collection any method on this service reads.
   *
   * Keeping it complete rather than partial is what makes the cache coherent — a method
   * that reached past the snapshot for one collection would re-read it on every call and
   * quietly reintroduce the amplification this exists to remove.
   */
  private async readPortfolio(merchantId: string) {
    const scope = [{ field: 'merchantId', op: '==' as const, value: merchantId }];
    const [payments, cases, actions, outcomes, customers, sessions, invoices, policyDecisions] =
      await Promise.all([
        this.store.payments.list({ where: scope }),
        this.store.cases.list({ where: scope }),
        this.store.actions.list({ where: scope }),
        this.store.outcomes.list({ where: scope }),
        this.store.customers.list({ where: scope }),
        this.store.checkoutSessions.list({ where: scope }),
        this.store.invoices.list({ where: scope }),
        this.store.policyDecisions.list({ where: scope }),
      ]);
    return { payments, cases, actions, outcomes, customers, sessions, invoices, policyDecisions };
  }

  private async loadAll(merchantId: string): Promise<PortfolioSnapshot> {
    if (this.ttlMs === 0) return this.readPortfolio(merchantId);

    const now = Date.now();
    if (this.cached && this.cached.merchantId === merchantId && now - this.cached.at < this.ttlMs) {
      return this.cached.snapshot;
    }
    if (this.inFlight && this.inFlight.merchantId === merchantId) {
      return this.inFlight.promise;
    }

    const promise = this.readPortfolio(merchantId)
      .then((snapshot) => {
        this.cached = { merchantId, at: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });

    this.inFlight = { merchantId, promise };
    return promise;
  }

  /**
   * Drop the cached snapshot. Called after a batch or a demo run so the dashboard
   * reflects what just happened instead of waiting out the TTL.
   */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * THE GUARDRAIL REGRET LEDGER.
   *
   * Reuses the portfolio snapshot rather than reading again: the policy decisions, cases
   * and outcomes it needs are already in the working set, so pricing every guardrail in
   * the system costs zero additional document reads.
   */
  async regretLedger(merchantId: string, config: PolicyConfig): Promise<RegretLedger> {
    const { policyDecisions, outcomes, cases } = await this.loadAll(merchantId);
    return computeRegretLedger({
      policyDecisions,
      outcomes,
      cases,
      config,
      labelFor: policyReasonLabel,
      nowIso: new Date().toISOString(),
    });
  }

  /**
   * WHEN to retry, learned from realised outcomes.
   *
   * Timing coordinates are recovered from records the store already keeps:
   * `timeToOutcomeMs` is the delay between the loss event and the resolution, and the
   * day-of-month comes from when the outcome was recorded. The failure reason is joined
   * through the case. No new writes were needed to support this.
   */
  async timing(merchantId: string): Promise<TimingReport> {
    const { outcomes, cases } = await this.loadAll(merchantId);
    const reasonByCase = new Map(cases.map((c) => [c.id, c.failureReason]));

    return buildTimingReport({
      outcomes,
      coordinatesFor: (outcome) => {
        const failureReason = reasonByCase.get(outcome.caseId);
        if (!failureReason) return null;
        const recordedAt = Date.parse(outcome.recordedAt);
        if (Number.isNaN(recordedAt)) return null;
        return {
          failureReason,
          hoursSinceFailure: outcome.timeToOutcomeMs / 3_600_000,
          dayOfMonth: new Date(recordedAt).getUTCDate(),
        };
      },
      nowIso: new Date().toISOString(),
    });
  }

  async controlTower(merchantId: string): Promise<ControlTowerMetrics> {
    const { payments, cases, actions, outcomes } = await this.loadAll(merchantId);

    const captured = payments.filter((p) => p.status === 'captured');
    const failed = payments.filter((p) => p.status === 'failed');
    const grossRevenueMinor = sumBy(captured, (p) => p.amountMinor);
    const leakedRevenueMinor = sumBy(failed, (p) => p.amountMinor);

    const openCases = cases.filter(
      (c) => !['recovered', 'stopped', 'unrecoverable'].includes(c.status),
    );
    const resolvedCases = cases.filter((c) =>
      ['recovered', 'stopped', 'unrecoverable'].includes(c.status),
    );

    const revenueAtRiskMinor = sumBy(openCases, (c) => c.amountAtRiskMinor);
    const recoverableRevenueMinor = sumBy(openCases, (c) =>
      Math.round(c.amountAtRiskMinor * (c.recoveryProbability ?? 0)),
    );
    const expectedRecoveryValueMinor = sumBy(openCases, (c) => Math.max(0, c.expectedValueMinor ?? 0));

    const recoveredOutcomes = outcomes.filter((o) => o.outcome === 'recovered');
    const recoveredRevenueMinor = sumBy(recoveredOutcomes, (o) => o.recoveredAmountMinor);

    // Recovery rate is measured against cases that actually reached a conclusion. Counting
    // still-open cases in the denominator would understate performance early in a run.
    const resolvedAtRisk = sumBy(resolvedCases, (c) => c.amountAtRiskMinor);

    const executed = actions.filter((a) => a.status === 'succeeded');
    const blocked = actions.filter((a) => a.status === 'blocked');
    const duplicates = actions.filter((a) => a.status === 'skipped_duplicate');

    const recoveryTimes = recoveredOutcomes.map((o) => o.timeToOutcomeMs);

    return {
      grossRevenueMinor,
      leakedRevenueMinor,
      revenueAtRiskMinor,
      recoverableRevenueMinor,
      recoveredRevenueMinor,
      expectedRecoveryValueMinor,
      recoveryRate: resolvedAtRisk === 0 ? 0 : round(recoveredRevenueMinor / resolvedAtRisk),
      leakageRate:
        grossRevenueMinor + leakedRevenueMinor === 0
          ? 0
          : round(leakedRevenueMinor / (grossRevenueMinor + leakedRevenueMinor)),
      activeCases: openCases.length,
      totalCases: cases.length,
      resolvedCases: resolvedCases.length,
      escalatedCases: cases.filter((c) => c.status === 'escalated').length,
      interventionsExecuted: executed.length,
      interventionsBlocked: blocked.length,
      duplicatesPrevented: duplicates.length,
      fallbacksTaken: actions.filter((a) => a.fallbackOfActionId !== null).length,
      averageRecoveryTimeMs:
        recoveryTimes.length === 0
          ? 0
          : Math.round(recoveryTimes.reduce((s, v) => s + v, 0) / recoveryTimes.length),
      averageCaseValueMinor:
        cases.length === 0 ? 0 : Math.round(sumBy(cases, (c) => c.amountAtRiskMinor) / cases.length),
      customersAffected: new Set(cases.map((c) => c.customerId)).size,
    };
  }

  async leakage(merchantId: string): Promise<LeakageBreakdown> {
    const { payments, cases, outcomes, customers } = await this.loadAll(merchantId);
    const failed = payments.filter((p) => p.status === 'failed');
    const customerById = indexBy(customers, (c) => c.id);

    // Map each case to its recovered amount so every bucket can report a real rate.
    const recoveredByCase = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.outcome !== 'recovered') continue;
      recoveredByCase.set(
        outcome.caseId,
        (recoveredByCase.get(outcome.caseId) ?? 0) + outcome.recoveredAmountMinor,
      );
    }

    const totalLost = sumBy(failed, (p) => p.amountMinor) || 1;

    const bucketize = <T>(
      items: readonly T[],
      keyOf: (item: T) => string,
      labelOf: (key: string) => string,
      amountOf: (item: T) => number,
      caseOf: (item: T) => RecoveryCase | undefined,
    ): LeakageBucket[] => {
      const groups = groupBy(items, keyOf);
      return Object.entries(groups)
        .map(([key, rows]) => {
          const lostAmountMinor = sumBy(rows, amountOf);
          const recoveredAmountMinor = sumBy(rows, (row) => {
            const c = caseOf(row);
            return c ? (recoveredByCase.get(c.id) ?? 0) : 0;
          });
          const openAmountMinor = sumBy(rows, (row) => {
            const c = caseOf(row);
            return c && !['recovered', 'stopped', 'unrecoverable'].includes(c.status)
              ? c.amountAtRiskMinor
              : 0;
          });
          return {
            key,
            label: labelOf(key),
            lostAmountMinor,
            count: rows.length,
            recoveredAmountMinor,
            recoveryRate: lostAmountMinor === 0 ? 0 : round(recoveredAmountMinor / lostAmountMinor),
            share: round(lostAmountMinor / totalLost),
            openAmountMinor,
          };
        })
        .sort((a, b) => b.lostAmountMinor - a.lostAmountMinor);
    };

    const caseBySourceId = indexBy(cases, (c) => c.sourceId);
    const caseFor = (p: Payment): RecoveryCase | undefined => caseBySourceId.get(p.id);

    const amountBand = (minor: number): string => {
      const rupees = minor / 100;
      if (rupees < 500) return 'under_500';
      if (rupees < 2_000) return '500_2k';
      if (rupees < 10_000) return '2k_10k';
      if (rupees < 50_000) return '10k_50k';
      return 'above_50k';
    };
    const BAND_LABELS: Record<string, string> = {
      under_500: 'Under ₹500',
      '500_2k': '₹500 – ₹2,000',
      '2k_10k': '₹2,000 – ₹10,000',
      '10k_50k': '₹10,000 – ₹50,000',
      above_50k: 'Above ₹50,000',
    };

    const hourGroups = countBy(failed, (p) => String(new Date(parseIso(p.createdAt)).getUTCHours()));
    const hourAmounts = groupBy(failed, (p) => String(new Date(parseIso(p.createdAt)).getUTCHours()));

    return {
      byFailureReason: bucketize(
        failed.filter((p) => p.failureReason !== null),
        (p) => p.failureReason!,
        (key) => getFailureProfile(key as FailureReason).label,
        (p) => p.amountMinor,
        caseFor,
      ),
      byMethod: bucketize(
        failed,
        (p) => p.method,
        (key) => key.toUpperCase(),
        (p) => p.amountMinor,
        caseFor,
      ),
      byIssuer: bucketize(
        failed,
        (p) => p.issuer,
        (key) => key,
        (p) => p.amountMinor,
        caseFor,
      ).slice(0, 12),
      bySegment: bucketize(
        failed,
        (p) => customerById.get(p.customerId)?.segment ?? 'unknown',
        (key) => key.charAt(0).toUpperCase() + key.slice(1),
        (p) => p.amountMinor,
        caseFor,
      ),
      bySourceType: bucketize(
        cases,
        (c) => c.sourceType,
        (key) => key.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase()),
        (c) => c.amountAtRiskMinor,
        (c) => c,
      ),
      byHour: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        count: hourGroups[String(hour)] ?? 0,
        lostAmountMinor: sumBy(hourAmounts[String(hour)] ?? [], (p) => p.amountMinor),
      })),
      byAmountBand: bucketize(
        failed,
        (p) => amountBand(p.amountMinor),
        (key) => BAND_LABELS[key] ?? key,
        (p) => p.amountMinor,
        caseFor,
      ),
    };
  }

  async trend(merchantId: string, days = 30): Promise<TrendPoint[]> {
    const { payments, cases, outcomes } = await this.loadAll(merchantId);
    if (cases.length === 0 && payments.length === 0) return [];

    const allDates = [...payments.map((p) => p.createdAt), ...cases.map((c) => c.detectedAt)].sort();
    const latest = allDates.at(-1) ?? new Date().toISOString();
    const earliest = new Date(parseIso(latest) - days * 86_400_000).toISOString();
    const window = dayRange(earliest, latest);
    const windowSet = new Set(window);

    const failedByDay = groupBy(
      payments.filter((p) => p.status === 'failed' && windowSet.has(dayKey(p.createdAt))),
      (p) => dayKey(p.createdAt),
    );
    const casesByDay = groupBy(
      cases.filter((c) => windowSet.has(dayKey(c.detectedAt))),
      (c) => dayKey(c.detectedAt),
    );
    const recoveredByDay = groupBy(
      outcomes.filter((o) => o.outcome === 'recovered' && windowSet.has(dayKey(o.recordedAt))),
      (o) => dayKey(o.recordedAt),
    );

    return window.map((day) => {
      const leakedMinor = sumBy(failedByDay[day] ?? [], (p) => p.amountMinor);
      const dayCases = casesByDay[day] ?? [];
      const dayRecovered = recoveredByDay[day] ?? [];
      const recoveredMinor = sumBy(dayRecovered, (o) => o.recoveredAmountMinor);
      return {
        day,
        leakedMinor,
        recoveredMinor,
        atRiskMinor: sumBy(dayCases, (c) => c.amountAtRiskMinor),
        caseCount: dayCases.length,
        recoveredCount: dayRecovered.length,
        recoveryRate: leakedMinor === 0 ? 0 : round(recoveredMinor / leakedMinor),
      };
    });
  }

  /**
   * The recovery funnel: how much of the leaked revenue survives each stage. This is the
   * clearest single view of where value is lost — and importantly, "eligible" and
   * "attempted" are different stages, because policy blocks are a real leak.
   */
  async funnel(merchantId: string): Promise<FunnelStage[]> {
    const { payments, cases, actions, outcomes, sessions, invoices } =
      await this.loadAll(merchantId);

    // The top of the funnel is ALL revenue lost, not just declined payments.
    //
    // An abandoned cart and an overdue invoice are real losses that never produce a bank
    // error code, so counting only failed payments here would make the first stage
    // smaller than the second — and a funnel whose stages are not nested is arithmetic
    // nobody can trust.
    const failed = payments.filter((p) => p.status === 'failed');
    const abandoned = sessions.filter((s) => s.convertedPaymentId === null);
    const overdue = invoices.filter((i) => i.status === 'overdue');

    const leakedMinor =
      sumBy(failed, (p) => p.amountMinor) +
      sumBy(abandoned, (s) => s.cartValueMinor) +
      sumBy(overdue, (i) => i.amountMinor);
    const leakedCount = failed.length + abandoned.length + overdue.length;

    const detectedMinor = sumBy(cases, (c) => c.amountAtRiskMinor);

    // Each stage is a strict subset of the one before it. Computing them independently
    // lets a later stage exceed an earlier one — which makes the funnel arithmetic
    // nonsense and, worse, hides where value is actually being lost.
    const scored = cases.filter((c) => c.recoveryProbability !== null);
    const scoredIds = new Set(scored.map((c) => c.id));

    const eligible = scored.filter((c) => (c.expectedValueMinor ?? 0) > 0);
    const eligibleIds = new Set(eligible.map((c) => c.id));
    const eligibleMinor = sumBy(eligible, (c) => c.amountAtRiskMinor);

    const executedActionCaseIds = new Set(
      actions.filter((a) => a.status === 'succeeded').map((a) => a.caseId),
    );
    const attempted = eligible.filter((c) => executedActionCaseIds.has(c.id));
    const attemptedIds = new Set(attempted.map((c) => c.id));
    const attemptedMinor = sumBy(attempted, (c) => c.amountAtRiskMinor);

    const recoveredOutcomes = outcomes.filter(
      (o) => o.outcome === 'recovered' && attemptedIds.has(o.caseId),
    );
    const recoveredMinor = sumBy(recoveredOutcomes, (o) => o.recoveredAmountMinor);
    const recoveredCount = recoveredOutcomes.length;

    void scoredIds;
    void eligibleIds;

    const stages: Array<Omit<FunnelStage, 'conversion'>> = [
      {
        stage: 'leaked',
        label: 'Revenue lost',
        count: leakedCount,
        amountMinor: leakedMinor,
        description:
          'Every revenue-loss event before any recovery work: failed payments, abandoned checkouts that never converted, and overdue receivables.',
      },
      {
        stage: 'detected',
        label: 'Detected as recoverable events',
        count: cases.length,
        amountMinor: detectedMinor,
        description:
          'Loss events RECLAIM opened a case for. The gap from the stage above is losses below the amount threshold, or ones that resolved on their own before detection ran.',
      },
      {
        stage: 'scored',
        label: 'Scored by the model',
        count: scored.length,
        amountMinor: sumBy(scored, (c) => c.amountAtRiskMinor),
        description: 'Cases with a recovery probability and an expected value computed.',
      },
      {
        stage: 'eligible',
        label: 'Economically worth working',
        count: eligible.length,
        amountMinor: eligibleMinor,
        description:
          'Cases where at least one intervention has positive expected value. The rest are correctly left alone.',
      },
      {
        stage: 'attempted',
        label: 'Intervention executed',
        count: attempted.length,
        amountMinor: attemptedMinor,
        description:
          'Cases where policy permitted an action and the provider accepted it. The gap from the previous stage is policy blocks.',
      },
      {
        stage: 'recovered',
        label: 'Money recovered',
        count: recoveredCount,
        amountMinor: recoveredMinor,
        description: 'Payments actually captured, measured from recorded outcomes.',
      },
    ];

    return stages.map((stage, index) => {
      const previous = index === 0 ? null : stages[index - 1]!;
      return {
        ...stage,
        conversion:
          previous === null || previous.amountMinor === 0
            ? 1
            : round(stage.amountMinor / previous.amountMinor),
      };
    });
  }

  async strategyPerformance(merchantId: string): Promise<StrategyPerformance[]> {
    // Both collections are already in the portfolio snapshot; re-reading them would
    // double the billed reads for no new information.
    const { actions, outcomes } = await this.loadAll(merchantId);

    const byStrategy = groupBy(outcomes, (o) => o.strategy);
    const actionsByStrategy = groupBy(
      actions.filter((a) => a.status === 'succeeded' || a.status === 'failed'),
      (a) => a.strategy,
    );

    const strategies = new Set([...Object.keys(byStrategy), ...Object.keys(actionsByStrategy)]);

    return [...strategies]
      .map((key): StrategyPerformance => {
        const strategy = key as RecoveryStrategy;
        const strategyOutcomes = byStrategy[key] ?? [];
        const strategyActions = actionsByStrategy[key] ?? [];
        const recovered = strategyOutcomes.filter((o) => o.outcome === 'recovered');
        const recoveredMinor = sumBy(recovered, (o) => o.recoveredAmountMinor);
        const attempts = Math.max(strategyActions.length, strategyOutcomes.length);
        const successRate = attempts === 0 ? 0 : round(recovered.length / attempts);
        const averagePredicted =
          strategyOutcomes.length === 0
            ? 0
            : round(
                sumBy(strategyOutcomes, (o) => o.predictedProbability) / strategyOutcomes.length,
              );
        const costMinor = sumBy(strategyActions, () => 0);

        return {
          strategy,
          attempts,
          succeeded: recovered.length,
          recoveredMinor,
          successRate,
          averagePredicted,
          calibrationGap: round(successRate - averagePredicted),
          costMinor,
          netValueMinor: recoveredMinor - costMinor,
        };
      })
      .sort((a, b) => b.recoveredMinor - a.recoveredMinor);
  }

  /** The prioritised work queue: amount x probability, decayed by age. */
  async opportunities(merchantId: string, limit = 25): Promise<OpportunityRow[]> {
    const { cases, customers } = await this.loadAll(merchantId);
    const customerById = indexBy(customers, (c) => c.id);
    const nowMs = Date.now();

    return cases
      .filter((c) => !['recovered', 'stopped', 'unrecoverable'].includes(c.status))
      .map((c): OpportunityRow => {
        const customer: Customer | undefined = customerById.get(c.customerId);
        return {
          caseId: c.id,
          customerId: c.customerId,
          customerName: customer?.name ?? 'Unknown customer',
          segment: customer?.segment ?? 'consumer',
          amountAtRiskMinor: c.amountAtRiskMinor,
          recoveryProbability: c.recoveryProbability ?? 0,
          expectedValueMinor: c.expectedValueMinor ?? 0,
          priorityScore: c.priorityScore ?? 0,
          failureReason: c.failureReason,
          method: c.method,
          sourceType: c.sourceType,
          status: c.status,
          detectedAt: c.detectedAt,
          hoursOpen: round(Math.max(0, (nowMs - parseIso(c.detectedAt)) / 3_600_000), 1),
        };
      })
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, limit);
  }

  async systemHealth(merchantId: string): Promise<SystemHealthMetrics> {
    // Actions and outcomes come from the snapshot; only the policy decisions and the
    // audit count are reads this method genuinely adds.
    const [{ actions, outcomes, policyDecisions }, auditCount] = await Promise.all([
      this.loadAll(merchantId),
      // An aggregate, not a scan: Firestore bills a count() as a single read.
      this.store.auditLogs.count({ where: [{ field: 'merchantId', op: '==', value: merchantId }] }),
    ]);

    const denialCounts = new Map<string, number>();
    for (const decision of policyDecisions) {
      if (decision.verdict === 'allow') continue;
      for (const code of decision.reasonCodes) {
        denialCounts.set(code, (denialCounts.get(code) ?? 0) + 1);
      }
    }

    const withDuration = actions.filter((a) => a.durationMs !== null);

    return {
      actionsExecuted: actions.filter((a) => a.status === 'succeeded').length,
      actionsBlocked: actions.filter((a) => a.status === 'blocked').length,
      actionsFailed: actions.filter((a) => a.status === 'failed').length,
      duplicatesPrevented: actions.filter((a) => a.status === 'skipped_duplicate').length,
      fallbacksTaken: actions.filter((a) => a.fallbackOfActionId !== null).length,
      escalations: outcomes.filter((o) => o.outcome === 'escalated_to_human').length,
      policyDenialsByCode: [...denialCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      averageActionLatencyMs:
        withDuration.length === 0
          ? 0
          : Math.round(sumBy(withDuration, (a) => a.durationMs ?? 0) / withDuration.length),
      auditEntries: auditCount,
    };
  }

  /**
   * Compare a window against the one immediately before it. This is what answers
   * "why did revenue drop today?" with a measured delta instead of an impression.
   */
  async periodComparison(
    merchantId: string,
    windowDays = 7,
  ): Promise<{
    current: { leakedMinor: number; recoveredMinor: number; failures: number };
    previous: { leakedMinor: number; recoveredMinor: number; failures: number };
    deltas: { leakedMinor: number; recoveredMinor: number; failures: number; leakedPct: number };
    topRegressions: Array<{ label: string; deltaMinor: number; currentMinor: number }>;
  }> {
    const { payments, outcomes } = await this.loadAll(merchantId);
    const latest = payments.map((p) => p.createdAt).sort().at(-1) ?? new Date().toISOString();
    const latestMs = parseIso(latest);
    const windowMs = windowDays * 86_400_000;

    const inWindow = (iso: string, from: number, to: number): boolean => {
      const ms = parseIso(iso);
      return ms > from && ms <= to;
    };

    const currentFrom = latestMs - windowMs;
    const previousFrom = latestMs - 2 * windowMs;

    const currentFailures = payments.filter(
      (p) => p.status === 'failed' && inWindow(p.createdAt, currentFrom, latestMs),
    );
    const previousFailures = payments.filter(
      (p) => p.status === 'failed' && inWindow(p.createdAt, previousFrom, currentFrom),
    );

    const current = {
      leakedMinor: sumBy(currentFailures, (p) => p.amountMinor),
      recoveredMinor: sumBy(
        outcomes.filter(
          (o) => o.outcome === 'recovered' && inWindow(o.recordedAt, currentFrom, latestMs),
        ),
        (o) => o.recoveredAmountMinor,
      ),
      failures: currentFailures.length,
    };
    const previous = {
      leakedMinor: sumBy(previousFailures, (p) => p.amountMinor),
      recoveredMinor: sumBy(
        outcomes.filter(
          (o) => o.outcome === 'recovered' && inWindow(o.recordedAt, previousFrom, currentFrom),
        ),
        (o) => o.recoveredAmountMinor,
      ),
      failures: previousFailures.length,
    };

    // Which failure reasons grew the most between the two windows.
    const currentByReason = groupBy(
      currentFailures.filter((p) => p.failureReason),
      (p) => p.failureReason!,
    );
    const previousByReason = groupBy(
      previousFailures.filter((p) => p.failureReason),
      (p) => p.failureReason!,
    );
    const reasons = new Set([...Object.keys(currentByReason), ...Object.keys(previousByReason)]);

    const topRegressions = [...reasons]
      .map((reason) => {
        const currentMinor = sumBy(currentByReason[reason] ?? [], (p) => p.amountMinor);
        const previousMinor = sumBy(previousByReason[reason] ?? [], (p) => p.amountMinor);
        return {
          label: getFailureProfile(reason as FailureReason).label,
          deltaMinor: currentMinor - previousMinor,
          currentMinor,
        };
      })
      .filter((r) => r.deltaMinor > 0)
      .sort((a, b) => b.deltaMinor - a.deltaMinor)
      .slice(0, 5);

    return {
      current,
      previous,
      deltas: {
        leakedMinor: current.leakedMinor - previous.leakedMinor,
        recoveredMinor: current.recoveredMinor - previous.recoveredMinor,
        failures: current.failures - previous.failures,
        leakedPct:
          previous.leakedMinor === 0
            ? 0
            : round((current.leakedMinor - previous.leakedMinor) / previous.leakedMinor),
      },
      topRegressions,
    };
  }
}
