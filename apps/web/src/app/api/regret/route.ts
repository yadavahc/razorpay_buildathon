import { handler, ok } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/**
 * What the guardrails cost, and what they bought.
 *
 * Reads nothing the control tower has not already loaded — the ledger is computed from the
 * same cached portfolio snapshot, so this route is free in document reads.
 */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  await ensureDetectionRun();

  const [ledger, overview] = await Promise.all([
    engine.analytics.regretLedger(engine.merchantId, engine.config.policy),
    engine.analytics.controlTower(engine.merchantId),
  ]);

  return ok({ ledger, overview, policy: engine.config.policy }, startedAt);
});
