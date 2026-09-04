import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, parseBody } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  limit: z.number().int().min(10).max(2000).default(400),
  seed: z.number().int().default(424242),
});

/**
 * Run the case portfolio through every recovery policy and compare the results.
 *
 * All policies face the identical case set with identical random draws, seeded per case,
 * so any difference between them comes from the decision rather than from luck.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await parseBody(request, bodySchema);
    const engine = await getEngine();
    await ensureDetectionRun();

    const [report, floorSweep] = await Promise.all([
      engine.simulation.run(engine.merchantId, { limit: body.limit, seed: body.seed }),
      engine.simulation.valueFloorSweep(engine.merchantId, { limit: body.limit, seed: body.seed }),
    ]);

    return ok({ report, floorSweep }, startedAt);
  } catch (error) {
    return fail(error, startedAt);
  }
}
