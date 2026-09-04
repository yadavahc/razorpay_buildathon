import { handler, ok } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/** Recovery rate as a function of when the retry lands, per failure reason. */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  await ensureDetectionRun();
  const timing = await engine.analytics.timing(engine.merchantId);
  return ok({ timing }, startedAt);
});
