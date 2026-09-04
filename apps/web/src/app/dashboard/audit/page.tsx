'use client';

import { useState } from 'react';
import type { AuditLog } from '@reclaim/core';
import {
  ACTION_STATUS_LABELS,
  OUTCOME_LABELS,
  formatCount,
  formatDateTime,
  formatMinorCompact,
} from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { Badge, Button, ErrorState, Panel, Skeleton, Surface, cn } from '@/components/ui/primitives';

interface AuditPayload {
  items: AuditLog[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  verification: { valid: boolean; checked: number; brokenAt: string | null; reason: string | null };
  chainLength: number;
  events: Array<{ name: string; count: number }>;
}

/**
 * THE AUDIT TRAIL
 *
 * Append-only and hash-chained: every record embeds the hash of its predecessor, so the
 * chain can be replayed and any alteration detected.
 *
 * The verification banner is recomputed on every request from the stored records rather
 * than read from a stored flag. A flag would be exactly as forgeable as the records it
 * vouches for.
 */
export default function AuditPage() {
  const [event, setEvent] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (event) params.set('event', event);

  const { data, error, loading, refreshing, refresh, lastUpdated } = useApi<AuditPayload>(
    `/api/audit?${params.toString()}`,
    { pollMs: 30_000 },
  );

  if (error) {
    return (
      <>
        <PageHeader title="Audit trail" description="Every financial action, hash-chained." />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every detection, decision, guardrail verdict, action and outcome — recorded in an append-only chain that is verified on read."
        lastUpdated={lastUpdated}
        refreshing={refreshing}
      />

      {data && (
        <div
          className={cn(
            'mb-6 rounded-xl border px-5 py-4',
            data.verification.valid
              ? 'border-mint-500/25 bg-mint-500/[0.05]'
              : 'border-loss-500/30 bg-loss-500/[0.06]',
          )}
          role="status"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge dot tone={data.verification.valid ? 'positive' : 'negative'} size="md">
              {data.verification.valid ? 'Chain verified' : 'Chain broken'}
            </Badge>
            <p className="text-xs text-silver-300">
              {data.verification.valid
                ? `${formatCount(data.verification.checked)} entries replayed. Every record's hash matches its content and links to its predecessor.`
                : `Verification failed at ${data.verification.brokenAt}: ${data.verification.reason}`}
            </p>
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-silver-500 text-pretty">
            The chain is re-derived from the stored records on every request. Each entry hashes its
            own content together with the previous entry&apos;s hash, so altering any historical
            record invalidates every entry after it — which is what makes tampering detectable
            rather than merely discouraged.
          </p>
        </div>
      )}

      {loading && !data ? (
        <MetricGrid columns={3}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
      ) : data ? (
        <>
          <MetricGrid columns={3}>
            <MetricTile
              label="Chain length"
              value={formatCount(data.chainLength)}
              definition="Total entries in this merchant's audit chain. Sequence numbers are assigned inside a transaction, so concurrent writers cannot fork it."
              tone="neutral"
            />
            <MetricTile
              label="Distinct events"
              value={formatCount(data.events.length)}
              definition="Kinds of event recorded, from case detection through to outcome measurement."
              tone="neutral"
            />
            <MetricTile
              label="Integrity"
              value={data.verification.valid ? 'Verified' : 'Broken'}
              definition="Result of replaying the entire chain and recomputing every hash on this request."
              tone={data.verification.valid ? 'positive' : 'negative'}
            />
          </MetricGrid>

          <Surface className="mt-6 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setEvent('');
                  setPage(1);
                }}
                aria-pressed={event === ''}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  event === '' ? 'bg-white/[0.08] text-silver-50' : 'text-silver-500 hover:text-silver-200',
                )}
              >
                All events
              </button>
              {data.events.slice(0, 10).map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  onClick={() => {
                    setEvent(entry.name);
                    setPage(1);
                  }}
                  aria-pressed={event === entry.name}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 font-mono text-2xs transition-colors',
                    event === entry.name
                      ? 'bg-white/[0.08] text-silver-50'
                      : 'text-silver-500 hover:text-silver-200',
                  )}
                >
                  {entry.name}
                  <span className="ml-1.5 text-silver-600">{entry.count}</span>
                </button>
              ))}
            </div>
          </Surface>

          <Panel className="mt-4" bodyClassName="p-0" title={`${formatCount(data.total)} entries`}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <caption className="sr-only">Audit trail entries, newest first</caption>
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th scope="col" className="px-5 py-2.5 text-right font-medium text-silver-500">
                      Seq
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                      Event
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                      Actor
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                      Trigger
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium text-silver-500">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                      Result
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium text-silver-500">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((entry) => (
                    <tr key={entry.id} className="border-b border-white/[0.04] last:border-0">
                      <td className="tnum px-5 py-2.5 text-right text-silver-600">{entry.seq}</td>
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-2xs text-silver-200">{entry.event}</span>
                        <span className="block max-w-[16rem] truncate font-mono text-[9px] text-silver-700">
                          {entry.hash.slice(0, 24)}…
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-2xs text-silver-400">{entry.actor.id}</span>
                        <span className="block text-[10px] text-silver-600">{entry.actor.kind}</span>
                      </td>
                      <td className="max-w-[14rem] px-3 py-2.5">
                        <span className="block truncate text-2xs text-silver-500">
                          {entry.trigger}
                        </span>
                        {entry.caseId && (
                          <a
                            href={`/dashboard/cases/${entry.caseId}`}
                            className="block truncate font-mono text-[10px] text-silver-600 hover:text-mint-400"
                          >
                            {entry.caseId}
                          </a>
                        )}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right text-silver-300">
                        {entry.amountMinor === null ? '—' : formatMinorCompact(entry.amountMinor)}
                      </td>
                      <td className="px-3 py-2.5">
                        {entry.finalOutcome ? (
                          <Badge tone={entry.finalOutcome === 'recovered' ? 'positive' : 'neutral'}>
                            {OUTCOME_LABELS[entry.finalOutcome]}
                          </Badge>
                        ) : entry.actionStatus ? (
                          <Badge
                            tone={
                              entry.actionStatus === 'succeeded'
                                ? 'positive'
                                : entry.actionStatus === 'blocked'
                                  ? 'warning'
                                  : entry.actionStatus === 'failed'
                                    ? 'negative'
                                    : 'neutral'
                            }
                          >
                            {ACTION_STATUS_LABELS[entry.actionStatus]}
                          </Badge>
                        ) : (
                          <span className="text-silver-700">—</span>
                        )}
                        {entry.failure && (
                          <span className="mt-0.5 block max-w-[14rem] truncate text-[10px] text-loss-400">
                            {entry.failure}
                          </span>
                        )}
                        {entry.fallback && (
                          <span className="mt-0.5 block text-[10px] text-risk-400">
                            → {entry.fallback.replace(/_/g, ' ')}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right text-2xs text-silver-600">
                        {formatDateTime(entry.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <nav className="mt-4 flex items-center justify-between gap-4" aria-label="Audit pagination">
            <p className="text-2xs text-silver-600">
              Page {data.page} of {data.totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Newer
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={data.page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Older
              </Button>
            </div>
          </nav>
        </>
      ) : null}
    </>
  );
}
