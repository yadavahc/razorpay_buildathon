import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, parseBody } from '@/lib/api';
import { ensureDetectionRun, getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  question: z.string().min(3).max(500),
});

/**
 * The merchant copilot.
 *
 * The agent classifies the question, runs the analytics queries it needs, computes the
 * answer, and only then asks the reasoner to word it. The `citations` returned are the
 * computed figures themselves, so every number in the answer can be checked against the
 * dashboard.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const { question } = await parseBody(request, bodySchema);
    const engine = await getEngine();
    await ensureDetectionRun();

    const answer = await engine.copilot.ask(engine.merchantId, question);
    return ok(answer, startedAt);
  } catch (error) {
    return fail(error, startedAt);
  }
}

/** Suggested prompts, shown as starting points on an empty copilot screen. */
export async function GET() {
  const startedAt = Date.now();
  return ok(
    {
      suggestions: [
        'How much revenue is currently at risk?',
        'Why did revenue drop this week?',
        'What is our biggest recovery opportunity?',
        'Which payment failures should we prioritise?',
        'How is our recovery rate trending?',
        'Which failure reason is leaking the most money?',
        'Which recovery strategy is producing the best return?',
      ],
    },
    startedAt,
  );
}
