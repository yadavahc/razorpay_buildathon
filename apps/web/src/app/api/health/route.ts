import { handler, ok } from '@/lib/api';
import { getEngineBundle } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/** Liveness and dependency health, including circuit-breaker state and armed faults. */
export const GET = handler(async (startedAt) => {
  const { engine, bootMs, bootedAt, warnings } = await getEngineBundle();
  const health = await engine.health();

  const degraded =
    !health.payments.healthy || health.model.degraded || health.circuits.some((c) => c.state === 'open');

  return ok(
    {
      status: degraded ? 'degraded' : 'healthy',
      ...health,
      boot: { ms: bootMs, at: bootedAt },
      warnings,
      logs: engine.logSink.records.slice(-40).map((record) => ({
        level: record.level,
        message: record.message,
        time: record.time,
        context: record.context,
      })),
    },
    startedAt,
  );
});
