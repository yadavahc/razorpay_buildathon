import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, parseBody } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import { RECOVERY_STRATEGIES } from '@reclaim/core';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** False produces a recommendation and records it, but takes no action. */
  execute: z.boolean().default(true),
  /** Force a strategy. Still passes through the policy engine, which can refuse. */
  strategy: z.enum(RECOVERY_STRATEGIES).optional(),
  actor: z.enum(['user', 'agent']).default('user'),
});

/**
 * Run the decision pipeline for one case.
 *
 * This is the endpoint behind both "Investigate" (execute: false) and "Run recovery"
 * (execute: true) on the case screen. A forced strategy overrides the recommendation but
 * never the guardrails — a human can tell RECLAIM what to try, not what is permitted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const startedAt = Date.now();
  try {
    const { caseId } = await params;
    const body = await parseBody(request, bodySchema);
    const engine = await getEngine();

    const result = await engine.decisions.runCase(caseId, {
      execute: body.execute,
      ...(body.strategy ? { overrideStrategy: body.strategy } : {}),
      actor: { kind: body.actor, id: body.actor === 'user' ? 'user:dashboard' : 'agent:recovery_analyst' },
      trigger: body.strategy ? `manual_override:${body.strategy}` : 'dashboard_run',
    });

    const updatedCase = await engine.store.cases.get(caseId);

    return ok(
      {
        caseId,
        executed: result.executed,
        aiDecision: result.aiDecision,
        execution: result.execution,
        case: updatedCase,
        phases: result.phases,
        totalLatencyMs: result.totalLatencyMs,
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
