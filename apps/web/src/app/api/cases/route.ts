import type { NextRequest } from 'next/server';
import { fail, ok, intParam, stringParam } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';
import type { CaseStatus } from '@reclaim/core';

export const dynamic = 'force-dynamic';

const SORTS = {
  priority: (a: { priorityScore: number | null }, b: { priorityScore: number | null }) =>
    (b.priorityScore ?? 0) - (a.priorityScore ?? 0),
  amount: (a: { amountAtRiskMinor: number }, b: { amountAtRiskMinor: number }) =>
    b.amountAtRiskMinor - a.amountAtRiskMinor,
  newest: (a: { detectedAt: string }, b: { detectedAt: string }) =>
    a.detectedAt < b.detectedAt ? 1 : -1,
  probability: (a: { recoveryProbability: number | null }, b: { recoveryProbability: number | null }) =>
    (b.recoveryProbability ?? 0) - (a.recoveryProbability ?? 0),
} as const;

/**
 * Paginated case list with server-side filtering and sorting.
 *
 * Pagination is offset-based here rather than cursor-based because the sort keys are
 * derived (priority score changes as cases age) and a cursor over a moving sort key would
 * silently skip or repeat rows.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const engine = await getEngine();
    await ensureDetectionRun();

    const status = stringParam(request, 'status');
    const sourceType = stringParam(request, 'sourceType');
    const search = stringParam(request, 'q')?.toLowerCase().trim() ?? '';
    const sortKey = (stringParam(request, 'sort') ?? 'priority') as keyof typeof SORTS;
    const page = Math.max(1, intParam(request, 'page', 1));
    const pageSize = Math.min(100, Math.max(5, intParam(request, 'pageSize', 25)));

    const all = await engine.store.cases.list({
      where: [{ field: 'merchantId', op: '==', value: engine.merchantId }],
    });

    const customers = await engine.store.customers.list({
      where: [{ field: 'merchantId', op: '==', value: engine.merchantId }],
    });
    const customerById = new Map(customers.map((c) => [c.id, c]));

    const openStatuses: CaseStatus[] = ['detected', 'investigating', 'awaiting_action', 'in_progress'];

    let filtered = all;
    if (status === 'open') filtered = filtered.filter((c) => openStatuses.includes(c.status));
    else if (status === 'resolved') {
      filtered = filtered.filter((c) => ['recovered', 'stopped', 'unrecoverable'].includes(c.status));
    } else if (status) filtered = filtered.filter((c) => c.status === status);

    if (sourceType) filtered = filtered.filter((c) => c.sourceType === sourceType);

    if (search) {
      filtered = filtered.filter((c) => {
        const customer = customerById.get(c.customerId);
        return (
          c.id.toLowerCase().includes(search) ||
          (customer?.name.toLowerCase().includes(search) ?? false) ||
          (customer?.email.toLowerCase().includes(search) ?? false) ||
          (c.failureReason?.toLowerCase().includes(search) ?? false)
        );
      });
    }

    const sorted = [...filtered].sort(SORTS[sortKey] ?? SORTS.priority);
    const total = sorted.length;
    const items = sorted.slice((page - 1) * pageSize, page * pageSize).map((c) => {
      const customer = customerById.get(c.customerId);
      return {
        id: c.id,
        customerId: c.customerId,
        customerName: customer?.name ?? 'Unknown customer',
        customerSegment: customer?.segment ?? null,
        sourceType: c.sourceType,
        status: c.status,
        failureReason: c.failureReason,
        method: c.method,
        amountAtRiskMinor: c.amountAtRiskMinor,
        recoveredAmountMinor: c.recoveredAmountMinor,
        recoveryProbability: c.recoveryProbability,
        expectedValueMinor: c.expectedValueMinor,
        priorityScore: c.priorityScore,
        selectedStrategy: c.selectedStrategy,
        attemptCount: c.attemptCount,
        detectedAt: c.detectedAt,
        updatedAt: c.updatedAt,
      };
    });

    return ok(
      {
        items,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        counts: {
          all: all.length,
          open: all.filter((c) => openStatuses.includes(c.status)).length,
          recovered: all.filter((c) => c.status === 'recovered').length,
          escalated: all.filter((c) => c.status === 'escalated').length,
          stopped: all.filter((c) => c.status === 'stopped' || c.status === 'unrecoverable').length,
        },
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
