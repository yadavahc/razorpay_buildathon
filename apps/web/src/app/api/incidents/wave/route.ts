import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { POLICY_REASON_CODES } from '@reclaim/core';
import { fail, ok, parseBody } from '@/lib/api';
import { getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

/**
 * COORDINATED RECOVERY WAVE.
 *
 * Releases the cases an incident was holding, once the incident has cleared.
 *
 * A case qualifies only if it was actually held — its most recent policy decision cited
 * SYSTEMIC_INCIDENT_ACTIVE — and the dimension that held it is no longer suppressed. That
 * pairing is the whole point: releasing on a timer would dump the queue back into an
 * issuer that may still be down, which is the failure this feature exists to prevent.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await parseBody(request, bodySchema);
    const engine = await getEngine();
    const merchantId = engine.merchantId;

    // Rescan first: the release decision must be made against the current picture, not a
    // snapshot taken before the issuer recovered.
    const report = await engine.incidents.refresh(merchantId);
    const stillSuppressed = new Set(report.suppressed.failureReasons);

    const decisions = await engine.store.policyDecisions.list({
      where: [{ field: 'merchantId', op: '==', value: merchantId }],
    });

    // Latest decision per case, so a case released earlier is not re-held by its history.
    const latestByCase = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      const existing = latestByCase.get(decision.caseId);
      if (!existing || decision.evaluatedAt > existing.evaluatedAt) {
        latestByCase.set(decision.caseId, decision);
      }
    }

    const heldCaseIds = [...latestByCase.values()]
      .filter((d) => d.reasonCodes.includes(POLICY_REASON_CODES.SYSTEMIC_INCIDENT_ACTIVE))
      .map((d) => d.caseId);

    const releasable: string[] = [];
    for (const caseId of heldCaseIds) {
      const recoveryCase = await engine.store.cases.get(caseId);
      if (!recoveryCase) continue;
      if (['recovered', 'stopped', 'unrecoverable'].includes(recoveryCase.status)) continue;
      if (recoveryCase.failureReason && stillSuppressed.has(recoveryCase.failureReason)) continue;
      releasable.push(caseId);
      if (releasable.length >= body.limit) break;
    }

    const result = await engine.decisions.runBatch(releasable, {
      execute: true,
      actor: { kind: 'system', id: 'incident_wave' },
      trigger: 'incident:coordinated_wave',
    });

    engine.analytics.invalidate();

    return ok(
      {
        held: heldCaseIds.length,
        released: releasable.length,
        stillHeld: heldCaseIds.length - releasable.length,
        activeIncidents: report.incidents.filter((i) => i.suppressRetries).length,
        processed: result.processed,
        recoveredMinor: result.recoveredMinor,
        recoveredCount: result.recoveredCount,
        blockedCount: result.blockedCount,
        durationMs: result.durationMs,
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
