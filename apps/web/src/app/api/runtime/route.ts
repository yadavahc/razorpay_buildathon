import { handler, ok } from '@/lib/api';
import { ensureDetectionRun, getEngineBundle } from '@/lib/engine';

export const dynamic = 'force-dynamic';

/**
 * Capability and provenance for the whole app.
 *
 * The UI badges every screen with what is actually running — which reasoner, which
 * payment provider, which store, whether the model is trained — so a viewer never has to
 * guess whether they are looking at a live integration or an offline simulation.
 */
export const GET = handler(async (startedAt) => {
  const { engine, corpusStats, bootMs, bootedAt, warnings } = await getEngineBundle();
  const detected = await ensureDetectionRun();

  return ok(
    {
      runtime: engine.runtimeInfo(),
      corpus: corpusStats,
      boot: { ms: bootMs, at: bootedAt },
      detection: { casesOpenedOnBoot: detected },
      warnings,
    },
    startedAt,
  );
});
