import { handler, ok } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/**
 * The Control Tower payload: the headline figures, the recovery funnel, the trend, the
 * ranked opportunity queue and system health, in one round trip.
 *
 * Every value is computed from stored records at request time. There is no metrics cache
 * to go stale and no constant standing in for a number.
 */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  await ensureDetectionRun();
  const merchantId = engine.merchantId;

  const [overview, funnel, trend, opportunities, strategies, health] = await Promise.all([
    engine.analytics.controlTower(merchantId),
    engine.analytics.funnel(merchantId),
    engine.analytics.trend(merchantId, 30),
    engine.analytics.opportunities(merchantId, 12),
    engine.analytics.strategyPerformance(merchantId),
    engine.analytics.systemHealth(merchantId),
  ]);

  return ok({ overview, funnel, trend, opportunities, strategies, health }, startedAt);
});
