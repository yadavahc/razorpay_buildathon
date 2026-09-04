'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CASE_SOURCE_LABELS,
  STRATEGY_LABELS,
  failureLabel,
  formatCount,
  formatDuration,
  formatMinorCompact,
  formatPercent,
  formatRelative,
} from '@reclaim/core/presentation';
import type {
  ControlTowerMetrics,
  FunnelStage,
  OpportunityRow,
  StrategyPerformance,
  SystemHealthMetrics,
  TrendPoint,
} from '@reclaim/core';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import {
  OpportunityMapChart,
  RecoveryFunnelChart,
  RecoveryTrendChart,
  StrategyPerformanceChart,
} from '@/components/charts/charts';
import { Badge, Button, ErrorState, Panel, Skeleton, cn } from '@/components/ui/primitives';

interface MetricsPayload {
  overview: ControlTowerMetrics;
  funnel: FunnelStage[];
  trend: TrendPoint[];
  opportunities: OpportunityRow[];
  strategies: StrategyPerformance[];
  health: SystemHealthMetrics;
}

/**
 * THE CONTROL TOWER
 *
 * The single screen that answers: how much are we losing, how much of it can come back,
 * how much already has, and what should be worked next.
 *
 * The metric definitions are not decoration. "Revenue at risk" and "recoverable revenue"
 * are different quantities that differ by a factor of the model's probability, and a
 * dashboard that shows both without saying which is which is not measuring anything.
 */
export default function ControlTowerPage() {
  const router = useRouter();
  const { data, error, loading, refreshing, refresh, lastUpdated } = useApi<MetricsPayload>(
    '/api/metrics',
    { pollMs: 20_000 },
  );

  if (error) {
    return (
      <>
        <PageHeader
          title="Revenue Recovery Control Tower"
          description="Live view of revenue at risk, what is recoverable, and what has been recovered."
        />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader
          title="Revenue Recovery Control Tower"
          description="Live view of revenue at risk, what is recoverable, and what has been recovered."
        />
        <MetricGrid columns={5}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-[340px] rounded-xl" />
          <Skeleton className="h-[340px] rounded-xl" />
        </div>
      </>
    );
  }

  if (!data) return null;

  const { overview, funnel, trend, opportunities, strategies, health } = data;
  const recoveredShare =
    overview.revenueAtRiskMinor + overview.recoveredRevenueMinor === 0
      ? 0
      : overview.recoveredRevenueMinor /
        (overview.revenueAtRiskMinor + overview.recoveredRevenueMinor);

  return (
    <>
      <PageHeader
        title="Revenue Recovery Control Tower"
        description="Live view of revenue at risk, what the model believes is recoverable, and what has actually been captured back."
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        actions={
          <Link href="/dashboard/demo">
            <Button size="sm" variant="primary">
              Run recovery
            </Button>
          </Link>
        }
      />

      <MetricGrid columns={5}>
        <MetricTile
          label="Revenue at risk"
          value={formatMinorCompact(overview.revenueAtRiskMinor)}
          definition="Total amount on recovery cases that have not yet reached a terminal state. This is exposure, not a forecast."
          hint={`${formatCount(overview.activeCases)} open cases · ${formatCount(overview.customersAffected)} customers`}
          tone="warning"
        />
        <MetricTile
          label="Recoverable"
          value={formatMinorCompact(overview.recoverableRevenueMinor)}
          definition="Amount at risk weighted by each case's predicted recovery probability. This is what the model expects to come back if every case is worked well."
          hint={`${formatPercent(overview.revenueAtRiskMinor === 0 ? 0 : overview.recoverableRevenueMinor / overview.revenueAtRiskMinor)} of exposure`}
          tone="accent"
        />
        <MetricTile
          label="Recovered"
          value={formatMinorCompact(overview.recoveredRevenueMinor)}
          definition="Money actually captured by a recovery action, summed from recorded outcomes. A payment link that has been sent but not paid is not counted here."
          hint={`${formatPercent(recoveredShare)} of all money that entered recovery`}
          tone="positive"
          emphasis
        />
        <MetricTile
          label="Recovery rate"
          value={formatPercent(overview.recoveryRate)}
          definition="Recovered value divided by the amount at risk on cases that reached a conclusion. Open cases are excluded from the denominator so early runs are not understated."
          hint={`${formatCount(overview.resolvedCases)} cases resolved`}
          tone="positive"
        />
        <MetricTile
          label="Net expected value"
          value={formatMinorCompact(overview.expectedRecoveryValueMinor)}
          definition="Sum of the best available expected value across open cases, after subtracting intervention and goodwill costs. What working the queue is worth today."
          hint={`Avg case ${formatMinorCompact(overview.averageCaseValueMinor)}`}
          tone="neutral"
        />
      </MetricGrid>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <RecoveryTrendChart data={trend} />
        </div>
        <div className="lg:col-span-2">
          <RecoveryFunnelChart stages={funnel} />
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <OpportunityMapChart
            points={opportunities.map((o) => ({
              caseId: o.caseId,
              customerName: o.customerName,
              amountAtRiskMinor: o.amountAtRiskMinor,
              recoveryProbability: o.recoveryProbability,
              expectedValueMinor: o.expectedValueMinor,
              priorityScore: o.priorityScore,
              hoursOpen: o.hoursOpen,
            }))}
            onSelect={(caseId) => router.push(`/dashboard/cases/${caseId}`)}
          />
        </div>
        <div className="lg:col-span-2">
          <StrategyPerformanceChart
            rows={strategies.map((s) => ({
              strategy: s.strategy,
              label: STRATEGY_LABELS[s.strategy],
              attempts: s.attempts,
              succeeded: s.succeeded,
              recoveredMinor: s.recoveredMinor,
              successRate: s.successRate,
              averagePredicted: s.averagePredicted,
              calibrationGap: s.calibrationGap,
            }))}
          />
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <PriorityQueue rows={opportunities} />
        </div>
        <div className="lg:col-span-2">
          <SafetyPanel health={health} overview={overview} />
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function PriorityQueue({ rows }: { rows: OpportunityRow[] }) {
  return (
    <Panel
      title="Priority queue"
      description="Open cases ranked by amount at risk × recovery probability, decayed for how long they have been waiting."
      bodyClassName="p-0"
      actions={
        <Link href="/dashboard/cases">
          <Button size="sm" variant="ghost">
            All cases
          </Button>
        </Link>
      }
    >
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-silver-500">
          No open cases. Run detection from the demo screen to populate the queue.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th scope="col" className="px-5 py-2.5 text-left font-medium text-silver-500">
                  Customer
                </th>
                <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                  Cause
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium text-silver-500">
                  At risk
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium text-silver-500">
                  Recovery
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium text-silver-500">
                  Expected
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 10).map((row) => (
                <tr
                  key={row.caseId}
                  className="border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.025]"
                >
                  <td className="px-5 py-2.5">
                    <Link
                      href={`/dashboard/cases/${row.caseId}`}
                      className="block max-w-[13rem] truncate text-silver-200 hover:text-mint-400"
                    >
                      {row.customerName}
                    </Link>
                    <span className="text-2xs text-silver-600">
                      {CASE_SOURCE_LABELS[row.sourceType]} · {formatRelative(row.detectedAt)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-silver-400">{failureLabel(row.failureReason)}</span>
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-silver-200">
                    {formatMinorCompact(row.amountAtRiskMinor)}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right">
                    <span
                      className={cn(
                        row.recoveryProbability >= 0.6
                          ? 'text-mint-400'
                          : row.recoveryProbability >= 0.3
                            ? 'text-risk-400'
                            : 'text-loss-400',
                      )}
                    >
                      {formatPercent(row.recoveryProbability, 0)}
                    </span>
                  </td>
                  <td className="tnum px-5 py-2.5 text-right text-silver-300">
                    {formatMinorCompact(row.expectedValueMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SafetyPanel({
  health,
  overview,
}: {
  health: SystemHealthMetrics;
  overview: ControlTowerMetrics;
}) {
  const rows: Array<{ label: string; value: string; definition: string; tone: string }> = [
    {
      label: 'Actions executed',
      value: formatCount(health.actionsExecuted),
      definition: 'Interventions that reached the provider and succeeded.',
      tone: 'text-mint-400',
    },
    {
      label: 'Blocked by policy',
      value: formatCount(health.actionsBlocked),
      definition: 'Actions the guardrail engine refused. Each one is recorded with its reason codes.',
      tone: 'text-risk-400',
    },
    {
      label: 'Duplicates prevented',
      value: formatCount(health.duplicatesPrevented),
      definition:
        'Repeat requests stopped by the idempotency ledger before reaching the payment provider.',
      tone: 'text-mint-400',
    },
    {
      label: 'Action failures',
      value: formatCount(health.actionsFailed),
      definition: 'Provider errors, timeouts and declines after the retry budget was exhausted.',
      tone: 'text-loss-400',
    },
    {
      label: 'Escalated to a human',
      value: formatCount(health.escalations),
      definition: 'Cases routed for human judgement rather than resolved by automation.',
      tone: 'text-silver-200',
    },
    {
      label: 'Average recovery time',
      value: formatDuration(overview.averageRecoveryTimeMs),
      definition: 'Median wall-clock time from detection to the money being captured.',
      tone: 'text-silver-200',
    },
    {
      label: 'Audit entries',
      value: formatCount(health.auditEntries),
      definition: 'Hash-chained records. The chain is re-verified on every read of the audit page.',
      tone: 'text-silver-200',
    },
  ];

  return (
    <Panel
      title="Safety & throughput"
      description="What the guardrails did, not just what the engine attempted."
      bodyClassName="p-0"
      actions={
        <Link href="/dashboard/policy">
          <Button size="sm" variant="ghost">
            Guardrails
          </Button>
        </Link>
      }
    >
      <dl className="divide-y divide-white/[0.04]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 px-5 py-2.5"
            title={row.definition}
          >
            <dt className="text-xs text-silver-500">{row.label}</dt>
            <dd className={cn('tnum text-xs font-medium', row.tone)}>{row.value}</dd>
          </div>
        ))}
      </dl>

      {health.policyDenialsByCode.length > 0 && (
        <div className="border-t border-white/[0.06] px-5 py-4">
          <p className="label-eyebrow">Top denial reasons</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {health.policyDenialsByCode.slice(0, 5).map((entry) => (
              <Badge key={entry.code} tone="warning">
                {entry.code.replace(/_/g, ' ').toLowerCase()} · {entry.count}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
