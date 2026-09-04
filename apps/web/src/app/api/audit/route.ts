import type { NextRequest } from 'next/server';
import { fail, ok, intParam, stringParam } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import { verifyAuditChain } from '@reclaim/core';

export const dynamic = 'force-dynamic';

/**
 * The audit trail, plus a live verification of its hash chain.
 *
 * The chain is re-derived from the stored records on every request rather than trusting a
 * stored "valid" flag — a flag would be exactly as forgeable as the records it vouches
 * for. `verifyAuditChain` recomputes each entry's hash and checks it links to its
 * predecessor, so tampering is detectable rather than merely discouraged.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const engine = await getEngine();

    const caseId = stringParam(request, 'caseId');
    const event = stringParam(request, 'event');
    const page = Math.max(1, intParam(request, 'page', 1));
    const pageSize = Math.min(200, Math.max(10, intParam(request, 'pageSize', 50)));

    const all = await engine.store.auditLogs.list({
      where: [{ field: 'merchantId', op: '==', value: engine.merchantId }],
    });

    // Verification always runs over the complete chain, never the filtered page: a
    // partial chain would fail to link and report a false alarm.
    const verification = verifyAuditChain(all);

    let filtered = all;
    if (caseId) filtered = filtered.filter((entry) => entry.caseId === caseId);
    if (event) filtered = filtered.filter((entry) => entry.event.startsWith(event));

    const ordered = [...filtered].sort((a, b) => b.seq - a.seq);
    const total = ordered.length;
    const items = ordered.slice((page - 1) * pageSize, page * pageSize);

    const eventCounts = new Map<string, number>();
    for (const entry of all) {
      eventCounts.set(entry.event, (eventCounts.get(entry.event) ?? 0) + 1);
    }

    return ok(
      {
        items,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        verification,
        chainLength: all.length,
        events: [...eventCounts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
