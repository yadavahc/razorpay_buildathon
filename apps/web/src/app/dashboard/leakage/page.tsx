'use client';

import type { ControlTowerMetrics, LeakageBreakdown } from '@reclaim/core';
import {
  formatCount,
  formatMinorCompact,
  formatPercent,
  formatSignedPercent,
} from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { LeakageBreakdownChart } from '@/components/charts/charts';
import { ErrorState, Panel, Skeleton, cn } from '@/components/ui/primitives';

interface PeriodComparison {
  current: { leakedMinor: number; recoveredMinor: number; failures: number };
  previous: { leakedMinor: number; recoveredMinor: number; failures: number };
  deltas: { leakedMinor: number; recoveredMinor: number; failures: number; leakedPct: number };
  topRegressions: Array<{ label: string; deltaMinor: number; currentMinor: number }>;
}

interface LeakagePayload {
  breakdown: LeakageBreakdown;
  comparison: PeriodComparison;
  overview: ControlTowerMetrics;
}

/**
 * REVENUE LEAKAGE INTELLIGENCE
 *
 * Where the money goes, sliced every way a merchant can act on: the failure that caused
 * it, the instrument it was on, the bank that declined it, the customer segment it came
 * from, the size of the transaction, and the hour of day.
 *
 * Each breakdown is a single-series magnitude chart. Colouring the bars by value would
 * re-encode length as hue and buy nothing.
 */
export default function LeakagePage() {
  const { data, error, loading, refreshing, refresh, lastUpdated } = useApi<LeakagePayload>(
    '/api/leakage',
    { pollMs: 60_000 },
  );

  if (error) {
    return (
      <>
        <PageHeader title="Revenue leakage intelligence" description="Where the money goes." />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Revenue leakage intelligence" description="Where the money goes." />
        <MetricGrid columns={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      </>
    );
  }

  if (!data) return null;

  const { breakdown, comparison, overview } = data;
  const worstHour = breakdown.byHour.reduce((a, b) => (b.lostAmountMinor > a.lostAmountMinor ? b : a));

  return (
    <>
      <PageHeader
        title="Revenue leakage intelligence"
        description="Every failed payment, attributed across the dimensions a merchant can actually do something about."
        lastUpdated={lastUpdated}
        refreshing={refreshing}
      />

      <MetricGrid columns={4}>
        <MetricTile
          label="Total leakage"
          value={formatMinorCompact(overview.leakedRevenueMinor)}
          definition="Gross value of every failed payment in the corpus, before any recovery work."
          hint={`${formatPercent(overview.leakageRate)} of all processed volume`}
          tone="negative"
        />
        <MetricTile
          label="Last 7 days"
          value={formatMinorCompact(comparison.current.leakedMinor)}
          definition="Leakage in the trailing 7-day window, against the 7 days immediately before it."
          hint={`${formatCount(comparison.current.failures)} failed payments`}
          tone="warning"
          delta={{
            value: formatSignedPercent(comparison.deltas.leakedPct),
            tone: comparison.deltas.leakedMinor > 0 ? 'negative' : 'positive',
          }}
        />
        <MetricTile
          label="Recovered in window"
          value={formatMinorCompact(comparison.current.recoveredMinor)}
          definition="Money captured back during the same trailing 7-day window."
          hint={`vs ${formatMinorCompact(comparison.previous.recoveredMinor)} the week before`}
          tone="positive"
        />
        <MetricTile
          label="Worst hour"
          value={`${String(worstHour.hour).padStart(2, '0')}:00 UTC`}
          definition="The hour of day with the highest total value of failed payments across the whole corpus."
          hint={`${formatMinorCompact(worstHour.lostAmountMinor)} lost · ${formatCount(worstHour.count)} failures`}
          tone="neutral"
        />
      </MetricGrid>

      {comparison.topRegressions.length > 0 && (
        <Panel
          className="mt-6"
          title="What got worse this week"
          description="Failure classes whose leakage grew against the previous 7 days. This is the answer to 'why did revenue drop?'"
        >
          <ul className="space-y-2.5">
            {comparison.topRegressions.map((row) => (
              <li key={row.label} className="flex items-baseline justify-between gap-4">
                <span className="min-w-0 truncate text-xs text-silver-200">{row.label}</span>
                <span className="shrink-0 text-2xs">
                  <span className="tnum text-silver-400">
                    {formatMinorCompact(row.currentMinor)}
                  </span>
                  <span className="tnum ml-3 text-loss-400">
                    +{formatMinorCompact(row.deltaMinor)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <LeakageBreakdownChart
          buckets={breakdown.byFailureReason}
          title="By failure reason"
          description="The bank or gateway condition that caused each decline."
          definition="Lost value grouped by the failure code returned by the provider. The recovery rate on each is measured from outcomes recorded against cases opened for those payments."
        />
        <LeakageBreakdownChart
          buckets={breakdown.byMethod}
          title="By payment method"
          description="Which instruments are leaking."
          definition="Lost value grouped by the payment instrument used. Method mix matters because a failure that is fatal on one instrument may be trivially recoverable on another."
        />
        <LeakageBreakdownChart
          buckets={breakdown.byIssuer}
          title="By bank and provider"
          description="Where declines cluster. A spike here usually means an outage, not customer intent."
          definition="Lost value grouped by the issuing bank, UPI handle or wallet. Clustered failures at one issuer within a short window are the signature of downtime rather than a real decline."
          limit={8}
        />
        <LeakageBreakdownChart
          buckets={breakdown.bySegment}
          title="By customer segment"
          description="Which kinds of customer are losing you money."
          definition="Lost value grouped by the customer's segment. Enterprise failures are fewer and far larger, so a segment view separates volume problems from value problems."
        />
        <LeakageBreakdownChart
          buckets={breakdown.byAmountBand}
          title="By transaction size"
          description="Whether the problem is many small failures or a few large ones."
          definition="Lost value grouped into transaction-size bands. This is what determines whether a fixed intervention cost is worth paying at all."
        />
        <LeakageBreakdownChart
          buckets={breakdown.bySourceType}
          title="By loss channel"
          description="Declines, dunning, abandonment and receivables side by side."
          definition="Amount at risk grouped by how the revenue was lost. Only the first two produce a bank error code; abandonment and overdue invoices need entirely different interventions."
        />
      </div>

      <Panel
        className="mt-6"
        title="Failures by hour of day"
        description="Distribution of leakage across the 24-hour clock, in UTC."
        bodyClassName="p-5"
      >
        <div
          className="flex h-32 items-end gap-1"
          role="img"
          aria-label="Failed payment value by hour of day"
        >
          {breakdown.byHour.map((hour) => {
            const max = Math.max(1, ...breakdown.byHour.map((h) => h.lostAmountMinor));
            const height = (hour.lostAmountMinor / max) * 100;
            const isWorst = hour.hour === worstHour.hour;
            return (
              <div key={hour.hour} className="group flex flex-1 flex-col items-center gap-1.5">
                <div className="flex w-full flex-1 items-end">
                  <div
                    className={cn(
                      'w-full rounded-t-[3px] transition-colors',
                      isWorst ? 'bg-loss-500' : 'bg-white/[0.12] group-hover:bg-white/[0.2]',
                    )}
                    style={{ height: `${Math.max(2, height)}%` }}
                    title={`${String(hour.hour).padStart(2, '0')}:00 — ${formatMinorCompact(hour.lostAmountMinor)} across ${hour.count} failures`}
                  />
                </div>
                <span className="tnum text-[8px] text-silver-700">
                  {hour.hour % 3 === 0 ? String(hour.hour).padStart(2, '0') : ''}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
    </>
  );
}
