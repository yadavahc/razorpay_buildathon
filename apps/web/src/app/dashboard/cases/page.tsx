'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  CASE_SOURCE_LABELS,
  CASE_STATUS_LABELS,
  CASE_STATUS_TONES,
  METHOD_LABELS,
  STRATEGY_LABELS,
  failureLabel,
  formatCount,
  formatMinorCompact,
  formatPercent,
  formatRelative,
} from '@reclaim/core/presentation';
import type { CaseSourceType, CaseStatus, FailureReason, PaymentMethod, RecoveryStrategy } from '@reclaim/core';
import { useApi } from '@/lib/use-api';
import { PageHeader } from '@/components/dashboard/metrics';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  Surface,
  cn,
} from '@/components/ui/primitives';

interface CaseRow {
  id: string;
  customerId: string;
  customerName: string;
  customerSegment: string | null;
  sourceType: CaseSourceType;
  status: CaseStatus;
  failureReason: FailureReason | null;
  method: PaymentMethod;
  amountAtRiskMinor: number;
  recoveredAmountMinor: number;
  recoveryProbability: number | null;
  expectedValueMinor: number | null;
  priorityScore: number | null;
  selectedStrategy: RecoveryStrategy | null;
  attemptCount: number;
  detectedAt: string;
  updatedAt: string;
}

interface CasesPayload {
  items: CaseRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: { all: number; open: number; recovered: number; escalated: number; stopped: number };
}

const STATUS_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'recovered', label: 'Recovered' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'resolved', label: 'Resolved' },
  { value: '', label: 'All' },
] as const;

const SORTS = [
  { value: 'priority', label: 'Priority' },
  { value: 'amount', label: 'Amount' },
  { value: 'probability', label: 'Recovery odds' },
  { value: 'newest', label: 'Newest' },
] as const;

const SOURCE_FILTERS: Array<{ value: '' | CaseSourceType; label: string }> = [
  { value: '', label: 'All sources' },
  { value: 'payment_failure', label: 'Payment failures' },
  { value: 'subscription_dunning', label: 'Subscription dunning' },
  { value: 'checkout_abandonment', label: 'Abandonment' },
  { value: 'overdue_invoice', label: 'Overdue invoices' },
];

/**
 * The work queue.
 *
 * Filters sit in one row above the table and scope everything below them; there are no
 * per-column filters, so what is on screen always corresponds to one stated slice.
 */
export default function CasesPage() {
  const [status, setStatus] = useState<string>('open');
  const [sourceType, setSourceType] = useState<string>('');
  const [sort, setSort] = useState<string>('priority');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ sort, page: String(page), pageSize: '25' });
  if (status) params.set('status', status);
  if (sourceType) params.set('sourceType', sourceType);
  if (query.trim()) params.set('q', query.trim());

  const { data, error, loading, refreshing, refresh, lastUpdated } = useApi<CasesPayload>(
    `/api/cases?${params.toString()}`,
    { pollMs: 30_000 },
  );

  const resetTo = (fn: () => void): void => {
    fn();
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Recovery cases"
        description="Every revenue-loss event RECLAIM has opened a case for, ranked by what it is worth to work now."
        lastUpdated={lastUpdated}
        refreshing={refreshing}
      />

      <Surface className="mb-5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] p-1">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => resetTo(() => setStatus(filter.value))}
                aria-pressed={status === filter.value}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  status === filter.value
                    ? 'bg-white/[0.08] text-silver-50'
                    : 'text-silver-500 hover:text-silver-200',
                )}
              >
                {filter.label}
                {data && filter.value === 'open' && (
                  <span className="ml-1.5 text-silver-600">{formatCount(data.counts.open)}</span>
                )}
              </button>
            ))}
          </div>

          <select
            value={sourceType}
            onChange={(event) => resetTo(() => setSourceType(event.target.value))}
            aria-label="Filter by loss channel"
            className="h-8 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-300 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
          >
            {SOURCE_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>

          <select
            value={sort}
            onChange={(event) => resetTo(() => setSort(event.target.value))}
            aria-label="Sort cases"
            className="h-8 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-300 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                Sort: {option.label}
              </option>
            ))}
          </select>

          <input
            type="search"
            value={query}
            onChange={(event) => resetTo(() => setQuery(event.target.value))}
            placeholder="Search customer, case id, failure reason"
            aria-label="Search cases"
            className="h-8 min-w-[16rem] flex-1 rounded-lg border border-white/[0.09] bg-ink-850 px-3 text-xs text-silver-200 placeholder:text-silver-600 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
          />

          <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing}>
            Refresh
          </Button>
        </div>
      </Surface>

      {error ? (
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      ) : loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <Surface>
          <EmptyState
            title="No cases match this filter"
            description="Try a different status or clear the search. If the queue is empty entirely, run detection from the demo screen to open cases from the seeded corpus."
            action={
              <Link href="/dashboard/demo">
                <Button size="sm" variant="secondary">
                  Go to demo mode
                </Button>
              </Link>
            }
          />
        </Surface>
      ) : (
        <>
          <Surface className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <caption className="sr-only">
                  Recovery cases, {data.total} matching the current filter
                </caption>
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th scope="col" className="px-5 py-3 text-left font-medium text-silver-500">
                      Customer
                    </th>
                    <th scope="col" className="px-3 py-3 text-left font-medium text-silver-500">
                      Cause
                    </th>
                    <th scope="col" className="px-3 py-3 text-left font-medium text-silver-500">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium text-silver-500">
                      At risk
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium text-silver-500">
                      Recovery
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium text-silver-500">
                      Expected
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium text-silver-500">
                      Detected
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.025]"
                    >
                      <td className="px-5 py-3">
                        <Link
                          href={`/dashboard/cases/${row.id}`}
                          className="block max-w-[15rem] truncate font-medium text-silver-100 hover:text-mint-400"
                        >
                          {row.customerName}
                        </Link>
                        <span className="text-2xs text-silver-600">
                          {CASE_SOURCE_LABELS[row.sourceType]} · {METHOD_LABELS[row.method]}
                          {row.customerSegment ? ` · ${row.customerSegment}` : ''}
                        </span>
                      </td>
                      <td className="max-w-[12rem] px-3 py-3">
                        <span className="block truncate text-silver-400">
                          {failureLabel(row.failureReason)}
                        </span>
                        {row.selectedStrategy && (
                          <span className="text-2xs text-silver-600">
                            {STRATEGY_LABELS[row.selectedStrategy]}
                            {row.attemptCount > 0 ? ` · ${row.attemptCount} attempts` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <Badge dot tone={CASE_STATUS_TONES[row.status]}>
                          {CASE_STATUS_LABELS[row.status]}
                        </Badge>
                      </td>
                      <td className="tnum px-3 py-3 text-right text-silver-200">
                        {formatMinorCompact(row.amountAtRiskMinor)}
                        {row.recoveredAmountMinor > 0 && (
                          <span className="block text-2xs text-mint-400">
                            +{formatMinorCompact(row.recoveredAmountMinor)} back
                          </span>
                        )}
                      </td>
                      <td className="tnum px-3 py-3 text-right">
                        {row.recoveryProbability === null ? (
                          <span className="text-silver-600">not scored</span>
                        ) : (
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
                        )}
                      </td>
                      <td className="tnum px-3 py-3 text-right text-silver-300">
                        {row.expectedValueMinor === null
                          ? '—'
                          : formatMinorCompact(row.expectedValueMinor)}
                      </td>
                      <td className="px-5 py-3 text-right text-silver-500">
                        {formatRelative(row.detectedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>

          <nav
            className="mt-4 flex items-center justify-between gap-4"
            aria-label="Case list pagination"
          >
            <p className="text-2xs text-silver-600">
              Showing {(data.page - 1) * data.pageSize + 1}–
              {Math.min(data.page * data.pageSize, data.total)} of {formatCount(data.total)}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="tnum text-2xs text-silver-500">
                {data.page} / {data.totalPages}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={data.page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </>
  );
}
