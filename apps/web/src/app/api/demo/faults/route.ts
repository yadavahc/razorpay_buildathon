import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, parseBody, stringParam } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import { FAULT_DESCRIPTIONS, FAULT_KINDS, faultInjector } from '@reclaim/core';

export const dynamic = 'force-dynamic';

const armSchema = z.object({
  kind: z.enum(FAULT_KINDS),
  target: z.enum(['payments', 'llm', 'notifications', '*']).default('*'),
  count: z.number().int().min(1).max(20).default(1),
});

/** The Failure Lab catalogue, plus whatever is currently armed. */
export async function GET() {
  const startedAt = Date.now();
  try {
    const engine = await getEngine();
    return ok(
      {
        catalogue: FAULT_KINDS.map((kind) => ({
          kind,
          label: FAULT_DESCRIPTIONS[kind].label,
          expected: FAULT_DESCRIPTIONS[kind].expected,
        })),
        armed: faultInjector.armed(),
        events: faultInjector.events(30),
        circuits: engine.circuits.snapshots(),
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}

/**
 * Arm a fault.
 *
 * Faults are bounded — they fire a fixed number of times and disarm themselves — so an
 * armed fault cannot leak into the next demo. Every firing is logged and shown alongside
 * the circuit-breaker state it produced.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await parseBody(request, armSchema);
    const fault = faultInjector.arm({
      kind: body.kind,
      target: body.target,
      count: body.count,
    });

    const engine = await getEngine();
    await engine.store.appendAudit({
      merchantId: engine.merchantId,
      actor: { kind: 'user', id: 'user:failure_lab' },
      event: 'fault.armed',
      trigger: `failure_lab:${body.kind}`,
      metadata: {
        kind: fault.kind,
        target: fault.target,
        count: fault.remaining,
        faultId: fault.id,
      },
    });

    return ok({ fault, armed: faultInjector.armed() }, startedAt);
  } catch (error) {
    return fail(error, startedAt);
  }
}

/** Disarm one fault by id, or all of them. */
export async function DELETE(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const id = stringParam(request, 'id');
    if (id) faultInjector.disarm(id);
    else faultInjector.disarmAll();

    const engine = await getEngine();
    engine.circuits.resetAll();

    return ok({ armed: faultInjector.armed(), circuits: engine.circuits.snapshots() }, startedAt);
  } catch (error) {
    return fail(error, startedAt);
  }
}
