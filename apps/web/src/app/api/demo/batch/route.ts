import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, parseBody } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z.object({
  limit: z.number().int().min(1).max(1000).default(150),
  /** Run detection first so the queue is full before the batch starts. */
  detectFirst: z.boolean().default(true),
});

/**
 * RUN BATCH — process the open queue and report what was actually recovered.
 *
 * The batch is sequential rather than parallel, deliberately: the policy engine reads
 * per-customer contact counts and per-case cooldowns that earlier iterations mutate.
 * Running concurrently would let two cases for the same customer each observe "no contact
 * yet today" and both message them — a race that produces exactly the behaviour the
 * guardrails exist to prevent.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await parseBody(request, bodySchema);
    const engine = await getEngine();
    const merchantId = engine.merchantId;

    let detected = 0;
    if (body.detectFirst) {
      await ensureDetectionRun();
      const summary = await engine.ingestion.ingest(merchantId, { maxCases: body.limit });
      detected =
        summary.created.paymentFailure +
        summary.created.subscriptionDunning +
        summary.created.checkoutAbandonment +
        summary.created.overdueInvoice;
    }

    const before = await engine.analytics.controlTower(merchantId);

    const queue = await engine.cases.listWorkQueue(merchantId, { limit: body.limit });
    const result = await engine.decisions.runBatch(
      queue.map((c) => c.id),
      { execute: true, actor: { kind: 'system', id: 'batch_runner' }, trigger: 'demo:run_batch' },
    );

    // The batch just changed the portfolio; drop the cached snapshot so the "after"
    // figures below and the next dashboard load reflect it rather than the TTL window.
    engine.analytics.invalidate();
    const after = await engine.analytics.controlTower(merchantId);
    const strategies = await engine.analytics.strategyPerformance(merchantId);

    // Per-strategy tally for this run specifically, not lifetime.
    const runStrategyMix = new Map<string, number>();
    for (const decision of result.results) {
      const strategy = decision.execution?.finalStrategy;
      if (strategy) runStrategyMix.set(strategy, (runStrategyMix.get(strategy) ?? 0) + 1);
    }

    return ok(
      {
        detected,
        queued: queue.length,
        processed: result.processed,
        recoveredMinor: result.recoveredMinor,
        recoveredCount: result.recoveredCount,
        blockedCount: result.blockedCount,
        escalatedCount: result.escalatedCount,
        duplicatesPrevented: result.duplicatesPrevented,
        failedCount: result.failedCount,
        errors: result.errors.slice(0, 10),
        durationMs: result.durationMs,
        throughputPerSecond:
          result.durationMs === 0 ? 0 : Number((result.processed / (result.durationMs / 1000)).toFixed(1)),
        strategyMix: [...runStrategyMix.entries()]
          .map(([strategy, count]) => ({ strategy, count }))
          .sort((a, b) => b.count - a.count),
        before: {
          revenueAtRiskMinor: before.revenueAtRiskMinor,
          recoveredRevenueMinor: before.recoveredRevenueMinor,
          activeCases: before.activeCases,
          recoveryRate: before.recoveryRate,
        },
        after: {
          revenueAtRiskMinor: after.revenueAtRiskMinor,
          recoveredRevenueMinor: after.recoveredRevenueMinor,
          activeCases: after.activeCases,
          recoveryRate: after.recoveryRate,
        },
        deltaRecoveredMinor: after.recoveredRevenueMinor - before.recoveredRevenueMinor,
        strategies,
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
