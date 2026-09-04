'use client';

import { useState } from 'react';
import type { TimingProfile, TimingReport } from '@reclaim/core';
import { formatCount, formatPercent } from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { Badge, ErrorState, Panel, Skeleton, cn } from '@/components/ui/primitives';

interface TimingPayload {
  timing: TimingReport;
}

/**
 * RECOVERY TIMING
 *
 * The rest of the product decides what to do. This page is about when.
 *
 * The heatmap is a two-way grid, so most cells are thin — and a thin cell is drawn as
 * explicitly empty rather than as a pale colour, because a colour invites the eye to read
 * a trend across cells that hold three observations each. Only cells that cleared the
 * sample floor are painted at all.
 */
export default function TimingPage() {
  const { data, error, loading, refresh } = useApi<TimingPayload>('/api/timing', {
    pollMs: 120_000,
  });
  const [selected, setSelected] = useState<string | null>(null);

  const header = (
    <PageHeader
      title="Recovery timing"
      description="When a retry lands changes whether it works. Learned from realised outcomes, per failure reason."
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        {header}
        <MetricGrid columns={3}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
        <Skeleton className="mt-6 h-[420px] rounded-xl" />
      </>
    );
  }

  if (!data) return null;

  const { timing } = data;
  const actionable = timing.profiles.filter((p) => p.recommendation !== null);
  const cyclical = timing.profiles.filter((p) => p.cyclical);
  const active = selected
    ? timing.profiles.find((p) => p.failureReason === selected)
    : (cyclical[0] ?? actionable[0] ?? timing.profiles[0]);

  return (
    <>
      {header}

      <MetricGrid columns={3}>
        <MetricTile
          label="Failures with a timing edge"
          value={`${formatCount(actionable.length)} of ${formatCount(timing.profiles.length)}`}
          definition="Failure reasons where the best timing window beats the reason's own average by more than 3 points, on a sample large enough to quote."
          hint={`${formatCount(timing.totalOutcomes)} outcomes analysed`}
          tone="accent"
        />
        <MetricTile
          label="Cyclical failures"
          value={formatCount(cyclical.length)}
          definition="Failure reasons whose recovery rate varies meaningfully with the day of the month — a liquidity pattern, not a technical one."
          hint="pay-cycle sensitive"
          tone={cyclical.length > 0 ? 'positive' : 'neutral'}
          emphasis={cyclical.length > 0}
        />
        <MetricTile
          label="Timing-insensitive"
          value={formatCount(timing.profiles.length - actionable.length)}
          definition="Failure reasons where no window beats the average. Deferring these buys nothing — which is itself a useful finding."
          tone="neutral"
        />
      </MetricGrid>

      <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs leading-relaxed text-silver-500">
        <span className="text-silver-300">On the synthetic corpus:</span> the generator models
        Indian salary-cycle liquidity, because real subscription dunning data shows it. The timing
        engine is <em>not</em> told this — it recovers the pattern from outcomes alone, which is
        how we check the engine works. Read the cycle below as a validated detector, not as a
        discovery about real payments.
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-4">
        <Panel
          className="lg:col-span-1"
          title="Failure reasons"
          description="Sorted by the size of the timing edge."
        >
          <ul className="divide-y divide-white/[0.04]">
            {timing.profiles.map((profile) => {
              const isActive = active?.failureReason === profile.failureReason;
              return (
                <li key={profile.failureReason}>
                  <button
                    type="button"
                    onClick={() => setSelected(profile.failureReason)}
                    className={cn(
                      'w-full px-4 py-3 text-left transition-colors',
                      isActive ? 'bg-white/[0.05]' : 'hover:bg-white/[0.025]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-sm',
                          isActive ? 'text-silver-100' : 'text-silver-300',
                        )}
                      >
                        {profile.failureReason.replace(/_/g, ' ')}
                      </span>
                      {profile.cyclical && <Badge tone="positive">cyclical</Badge>}
                    </div>
                    <div className="mt-0.5 flex gap-3 text-[11px] text-silver-600">
                      <span>n {formatCount(profile.observations)}</span>
                      <span>base {formatPercent(profile.baselineRate)}</span>
                      {profile.best && profile.recommendation && (
                        <span className="text-mint-400">
                          +{(profile.best.liftOverBaseline * 100).toFixed(1)}pt
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>

        {active ? <ProfileDetail profile={active} /> : null}
      </div>
    </>
  );
}

function ProfileDetail({ profile }: { profile: TimingProfile }) {
  const delayBuckets = [...new Set(profile.cells.map((c) => c.delayBucket))];
  const dayBuckets = [...new Set(profile.cells.map((c) => c.dayBucket))];

  const rated = profile.cells.filter(
    (c): c is (typeof profile.cells)[number] & { shrunkRate: number } => c.shrunkRate !== null,
  );
  const lo = rated.length ? Math.min(...rated.map((c) => c.shrunkRate)) : 0;
  const hi = rated.length ? Math.max(...rated.map((c) => c.shrunkRate)) : 1;

  return (
    <div className="min-w-0 lg:col-span-3">
      <Panel
        title={profile.failureReason.replace(/_/g, ' ')}
        description={`${formatCount(profile.observations)} realised outcomes · baseline ${formatPercent(profile.baselineRate)}`}
      >
        <div className="px-5 py-4">
          {profile.recommendation ? (
            <div className="rounded-lg border border-mint-500/20 bg-mint-500/[0.06] px-4 py-3 text-sm leading-relaxed text-silver-200">
              {profile.recommendation}
            </div>
          ) : (
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm leading-relaxed text-silver-400">
              No timing window beats this failure&rsquo;s average by enough to act on. For a
              technical decline that is the expected result — waiting does not repair an expired
              card.
            </div>
          )}

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[560px] border-separate border-spacing-1 text-xs">
              <thead>
                <tr>
                  <th className="w-20 px-1 py-1 text-left font-medium text-silver-600">
                    delay \ day
                  </th>
                  {dayBuckets.map((day) => (
                    <th key={day} className="px-1 py-1 text-center font-medium text-silver-500">
                      {day}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {delayBuckets.map((delay) => (
                  <tr key={delay}>
                    <th className="px-1 py-1 text-left font-medium text-silver-500">{delay}</th>
                    {dayBuckets.map((day) => {
                      const cell = profile.cells.find(
                        (c) => c.delayBucket === delay && c.dayBucket === day,
                      );
                      const rate = cell?.shrunkRate ?? null;
                      const isBest =
                        profile.best?.delayBucket === delay && profile.best?.dayBucket === day;
                      return (
                        <td key={day} className="p-0">
                          <div
                            title={
                              cell
                                ? `${formatCount(cell.observations)} outcomes${rate !== null ? ` · ${formatPercent(rate)}` : ' · below the sample floor'}`
                                : 'no data'
                            }
                            className={cn(
                              'flex h-11 items-center justify-center rounded border text-[11px] tabular-nums',
                              rate === null
                                ? 'border-white/[0.04] bg-white/[0.015] text-silver-700'
                                : 'border-transparent text-ink-950',
                              isBest && 'ring-2 ring-mint-400',
                            )}
                            style={
                              rate === null
                                ? undefined
                                : { backgroundColor: heat(rate, lo, hi), color: '#0b0b0f' }
                            }
                          >
                            {rate === null ? '·' : `${Math.round(rate * 100)}`}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-silver-600">
            Values are recovery rate after shrinkage toward this failure&rsquo;s average, so a
            small cell is pulled most of the way back to the mean rather than believed. A dot
            means the cell held fewer than the minimum observations and carries no estimate.
          </p>

          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Marginal
              title="By delay"
              spread={profile.delaySpread}
              rows={profile.byDelay}
              baseline={profile.baselineRate}
            />
            <Marginal
              title="By day of month"
              spread={profile.daySpread}
              rows={profile.byDay}
              baseline={profile.baselineRate}
            />
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Marginal({
  title,
  spread,
  rows,
  baseline,
}: {
  title: string;
  spread: number;
  rows: Array<{ bucket: string; observations: number; rate: number | null }>;
  baseline: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wider text-silver-400">{title}</h4>
        <span className="text-[11px] tabular-nums text-silver-600">
          spread {(spread * 100).toFixed(1)}pt
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li key={row.bucket} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 shrink-0 text-silver-500">{row.bucket}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-white/[0.03]">
              {row.rate !== null && (
                <>
                  <div
                    className={cn(
                      'h-full rounded',
                      row.rate >= baseline ? 'bg-mint-500/50' : 'bg-loss-500/45',
                    )}
                    style={{ width: `${Math.max(2, row.rate * 100)}%` }}
                  />
                  <div
                    className="absolute inset-y-0 w-px bg-silver-500/50"
                    style={{ left: `${baseline * 100}%` }}
                    title={`baseline ${formatPercent(baseline)}`}
                  />
                </>
              )}
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-silver-300">
              {row.rate === null ? '—' : formatPercent(row.rate, 0)}
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-silver-600">
              {formatCount(row.observations)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Sequential ramp for an ordinal quantity. Single-hue by design: rate has a direction, and
 * a diverging or multi-hue scale would imply categories that are not there.
 */
function heat(rate: number, lo: number, hi: number): string {
  const t = hi > lo ? (rate - lo) / (hi - lo) : 0.5;
  const light = 26 + t * 46;
  const sat = 32 + t * 38;
  return `hsl(168 ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}
