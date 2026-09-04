'use client';

import { useState } from 'react';
import type { Incident, IncidentReport } from '@reclaim/core';
import { formatCount, formatMinorCompact, formatPercent } from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import {
  Badge,
  Button,
  ErrorState,
  Panel,
  Skeleton,
  Spinner,
  cn,
} from '@/components/ui/primitives';

interface IncidentPayload {
  report: IncidentReport;
  held: { byFailureReason: Array<{ reason: string; count: number }>; openCases: number };
}

interface WaveResult {
  held: number;
  released: number;
  stillHeld: number;
  activeIncidents: number;
  processed: number;
  recoveredMinor: number;
  recoveredCount: number;
  durationMs: number;
}

const SEVERITY_TONE = {
  critical: 'negative',
  elevated: 'warning',
  watch: 'neutral',
} as const;

/**
 * SYSTEMIC INCIDENTS
 *
 * The page that changes the unit of decision from a payment to a population.
 *
 * Everything shown is measured: the failure counts are counts, the baseline is that
 * dimension's own trailing rate, and the sigma figure is a binomial deviation. The
 * detector's refusals matter as much as its findings, so the empty state says what it
 * looked at rather than just "nothing to show".
 */
export default function IncidentsPage() {
  const { data, error, loading, refresh } = useApi<IncidentPayload>('/api/incidents', {
    pollMs: 30_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [wave, setWave] = useState<WaveResult | null>(null);

  async function post(path: string, body: unknown, key: string) {
    setBusy(key);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (key === 'wave' && json.ok) setWave(json.data as WaveResult);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <PageHeader
      title="Systemic incidents"
      description="When failures are correlated, the right unit of decision is the cohort, not the payment."
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
        <MetricGrid columns={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
        <Skeleton className="mt-6 h-[300px] rounded-xl" />
      </>
    );
  }

  if (!data) return null;

  const { report } = data;
  const active = report.incidents.filter((i) => i.suppressRetries);
  const exposure = active.reduce((sum, i) => sum + i.exposureMinor, 0);
  const customers = active.reduce((sum, i) => sum + i.affectedCustomers, 0);

  return (
    <>
      {header}

      <MetricGrid columns={4}>
        <MetricTile
          label="Active incidents"
          value={formatCount(active.length)}
          definition="Dimensions failing far enough above their own baseline to hold retries. A 'watch' is reported but does not suppress."
          hint={`${report.incidents.length} total detected`}
          tone={active.length > 0 ? 'negative' : 'positive'}
          emphasis={active.length > 0}
        />
        <MetricTile
          label="Customers affected"
          value={formatCount(customers)}
          definition="Distinct customers whose payments failed inside an active incident window."
          tone={customers > 0 ? 'warning' : 'neutral'}
        />
        <MetricTile
          label="Exposure in incidents"
          value={formatMinorCompact(exposure)}
          definition="Money on the failed payments attributed to active incidents."
          tone="warning"
        />
        <MetricTile
          label="Retries held"
          value={active.length > 0 ? 'Yes' : 'None'}
          definition="Whether the policy engine is currently refusing retries into an affected route. Contact strategies are never suppressed."
          hint={`${formatCount(data.held.openCases)} open cases`}
          tone={active.length > 0 ? 'negative' : 'positive'}
        />
      </MetricGrid>

      <Panel
        className="mt-6"
        title="Incident console"
        description="Simulate an issuer outage, watch detection fire, then release the held cohort as one wave."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                void post('/api/incidents/simulate', { issuer: 'HDFC Bank', failures: 60 }, 'inject')
              }
              disabled={busy !== null}
            >
              {busy === 'inject' ? <Spinner className="mr-2" /> : null}
              Simulate HDFC outage
            </Button>
            <Button
              onClick={() =>
                void post(
                  '/api/incidents/simulate',
                  { issuer: 'HDFC Bank', failures: 120, resolve: true },
                  'resolve',
                )
              }
              disabled={busy !== null}
            >
              {busy === 'resolve' ? <Spinner className="mr-2" /> : null}
              Issuer recovers
            </Button>
            <Button
              onClick={() => void post('/api/incidents/wave', { limit: 100 }, 'wave')}
              disabled={busy !== null}
            >
              {busy === 'wave' ? <Spinner className="mr-2" /> : null}
              Release recovery wave
            </Button>
          </div>
        }
      >
        <div className="px-5 py-4 text-xs leading-relaxed text-silver-500">
          The outage is synthetic — it writes real failed payments into the store so the real
          detector can score them. Detection, suppression and release are not staged. Recovery is
          the honest inverse: it writes <em>successful</em> payments for the same issuer so the
          window failure rate falls, rather than deleting the evidence the detector saw.
        </div>

        {wave && (
          <div className="mx-5 mb-5 rounded-lg border border-mint-500/20 bg-mint-500/[0.06] px-4 py-3 text-sm">
            <div className="font-medium text-mint-400">Coordinated wave complete</div>
            <div className="mt-1 text-silver-300">
              {formatCount(wave.released)} of {formatCount(wave.held)} held cases released ·{' '}
              {formatCount(wave.recoveredCount)} recovered ·{' '}
              {formatMinorCompact(wave.recoveredMinor)} captured in {(wave.durationMs / 1000).toFixed(1)}s
              {wave.stillHeld > 0 && (
                <> · {formatCount(wave.stillHeld)} still held by a live incident</>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel
        className="mt-6"
        title="Detected incidents"
        description={`Window ${report.windowMinutes} minutes against a ${Math.round(report.baselineHours / 24)}-day baseline · ${formatCount(report.sampleSize)} payments considered.`}
      >
        {report.incidents.length === 0 ? (
          <div className="px-5 py-8 text-sm leading-relaxed text-silver-400">
            No dimension is failing above its own baseline. The detector examined{' '}
            {formatCount(report.sampleSize)} payments and found nothing anomalous — which is the
            expected reading for a healthy portfolio, not an absence of data.
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {report.incidents.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function IncidentRow({ incident }: { incident: Incident }) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-silver-100">{incident.value}</span>
            <Badge tone={SEVERITY_TONE[incident.severity]}>{incident.severity}</Badge>
            <span className="text-[11px] uppercase tracking-wider text-silver-600">
              {incident.dimension.replace(/_/g, ' ')}
            </span>
            {incident.suppressRetries && (
              <Badge tone="negative" dot>
                retries held
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-sm text-silver-400">{incident.summary}</p>
        </div>

        <dl className="grid shrink-0 grid-cols-4 gap-x-6 gap-y-1 text-right text-xs">
          <Stat label="failures" value={formatCount(incident.windowFailures)} />
          <Stat
            label="vs baseline"
            value={
              Number.isFinite(incident.rateRatio) ? `${incident.rateRatio.toFixed(1)}x` : 'n/a'
            }
            tone="negative"
          />
          <Stat label="customers" value={formatCount(incident.affectedCustomers)} />
          <Stat label="exposure" value={formatMinorCompact(incident.exposureMinor)} />
        </dl>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-silver-600">
        <span>
          window {formatPercent(incident.windowFailureRate)} vs baseline{' '}
          {formatPercent(incident.baselineFailureRate)}
        </span>
        <span>σ {incident.zScore.toFixed(1)}</span>
        <span>n {formatCount(incident.baselineSample)}</span>
        {incident.dominantFailureReason && (
          <span>mostly {incident.dominantFailureReason.replace(/_/g, ' ')}</span>
        )}
      </div>
    </li>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'negative';
}) {
  return (
    <div>
      <dd
        className={cn(
          'tabular-nums font-medium',
          tone === 'negative' ? 'text-loss-400' : 'text-silver-100',
        )}
      >
        {value}
      </dd>
      <dt className="text-[10px] uppercase tracking-wider text-silver-600">{label}</dt>
    </div>
  );
}
