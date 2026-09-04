import { handler, ok } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/** Revenue leakage attributed across every dimension a merchant can act on. */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  await ensureDetectionRun();
  const merchantId = engine.merchantId;

  const [breakdown, comparison, overview] = await Promise.all([
    engine.analytics.leakage(merchantId),
    engine.analytics.periodComparison(merchantId, 7),
    engine.analytics.controlTower(merchantId),
  ]);

  return ok({ breakdown, comparison, overview }, startedAt);
});
