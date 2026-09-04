import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { newId, type Payment } from '@reclaim/core';
import { fail, ok, parseBody } from '@/lib/api';
import { getEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const bodySchema = z.object({
  issuer: z.string().min(1).default('HDFC Bank'),
  /** Failed payments to write into the detection window. */
  failures: z.number().int().min(1).max(400).default(45),
  method: z.enum(['card', 'upi', 'netbanking', 'wallet']).default('card'),
  /** Spread the burst across this many minutes so it looks like an outage, not one instant. */
  spreadMinutes: z.number().int().min(1).max(59).default(25),
  /** Write successful payments instead, which is what an issuer coming back looks like. */
  resolve: z.boolean().default(false),
});

/**
 * SIMULATED ISSUER OUTAGE — the Failure Lab for systemic incidents.
 *
 * The runtime fault injector makes provider *calls* fail. It cannot produce the thing the
 * incident detector looks at, which is a population of failed payments sharing a dimension
 * inside a time window. So this endpoint writes that population directly.
 *
 * Everything it writes is a real record in the real store, scored by the real detector —
 * nothing about the detection is staged. What is synthetic is the outage itself, which is
 * the only part that could not be demonstrated otherwise without waiting for a bank to
 * actually go down. Every payment it creates is tagged `providerRef: 'simulated_outage'` so it
 * can be told apart from corpus data, and the route refuses to run outside demo mode.
 *
 * `resolve: true` writes successful payments for the same issuer instead. That is how an
 * outage genuinely ends — the failure *rate* in the window falls — rather than by deleting
 * evidence, which would let the demo lie about what the detector can see.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await parseBody(request, bodySchema);
    const engine = await getEngine();

    if (engine.config.mode !== 'demo') {
      throw new Error('Outage simulation is only available in demo mode.');
    }

    const merchantId = engine.merchantId;
    const customers = await engine.store.customers.list({
      where: [{ field: 'merchantId', op: '==', value: merchantId }],
    });
    if (customers.length === 0) throw new Error('No customers to attribute the outage to.');

    const now = Date.now();
    const written: Payment[] = [];

    for (let i = 0; i < body.failures; i++) {
      const customer = customers[(i * 7919) % customers.length]!;
      const minutesAgo = Math.floor((i / body.failures) * body.spreadMinutes);
      const id = newId('pay');
      const payment = {
        id,
        merchantId,
        customerId: customer.id,
        // Spread of realistic ticket sizes so exposure is not a single repeated number.
        amountMinor: 50_000 + ((i * 137) % 45) * 10_000,
        currency: 'INR',
        method: body.method,
        issuer: body.issuer,
        network: body.method === 'card' ? 'visa' : null,
        status: body.resolve ? 'captured' : 'failed',
        source: 'checkout',
        failureReason: body.resolve ? null : 'bank_downtime',
        errorCode: body.resolve ? null : 'GATEWAY_ERROR',
        createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
        capturedAt: body.resolve ? new Date(now - minutesAgo * 60_000).toISOString() : null,
        subscriptionId: null,
        invoiceId: null,
        recoveryCaseId: null,
        idempotencyKey: `sim_${id}`,
        // Marks the record as simulator-written so it is distinguishable from corpus data.
        providerRef: 'simulated_outage',
      } as unknown as Payment;

      written.push(payment);
    }

    // One batched write rather than N round trips: on Firestore this is the difference
    // between a demo that feels instant and one that visibly crawls.
    await engine.store.payments.putMany(written);

    // Rescan immediately so the caller sees the detector's verdict on what it just wrote,
    // rather than having to guess whether the burst was large enough to register.
    const report = await engine.incidents.refresh(merchantId);
    engine.analytics.invalidate();

    const detected = report.incidents.find(
      (incident) => incident.dimension === 'issuer' && incident.value === body.issuer,
    );

    return ok(
      {
        wrote: written.length,
        mode: body.resolve ? 'resolve' : 'outage',
        issuer: body.issuer,
        exposureMinor: written.reduce((sum, p) => sum + p.amountMinor, 0),
        detected: detected
          ? {
              severity: detected.severity,
              windowFailures: detected.windowFailures,
              rateRatio: detected.rateRatio,
              zScore: detected.zScore,
              affectedCustomers: detected.affectedCustomers,
              suppressRetries: detected.suppressRetries,
              summary: detected.summary,
            }
          : null,
        suppressed: report.suppressed,
        activeIncidents: report.incidents.filter((i) => i.suppressRetries).length,
      },
      startedAt,
    );
  } catch (error) {
    return fail(error, startedAt);
  }
}
