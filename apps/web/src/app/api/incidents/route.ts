import { handler, ok } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/**
 * The current systemic-incident picture.
 *
 * Rescans on every request rather than serving the policy engine's cached snapshot: this
 * route is for a human deciding whether to intervene, and a stale answer there is worse
 * than a slow one. The authorisation path keeps using the cached snapshot.
 */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  await ensureDetectionRun();

  const report = await engine.incidents.refresh(engine.merchantId);

  // How many open cases are currently being held by each active incident.
  const cases = await engine.store.cases.list({
    where: [{ field: 'merchantId', op: '==', value: engine.merchantId }],
  });
  const open = cases.filter((c) => !['recovered', 'stopped', 'unrecoverable'].includes(c.status));

  const heldByReason = new Map<string, number>();
  for (const reason of report.suppressed.failureReasons) {
    heldByReason.set(reason, open.filter((c) => c.failureReason === reason).length);
  }

  return ok(
    {
      report,
      held: {
        byFailureReason: [...heldByReason.entries()].map(([reason, count]) => ({ reason, count })),
        openCases: open.length,
      },
    },
    startedAt,
  );
});
