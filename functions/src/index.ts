import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';

import {
  createRecoveryEngine,
  loadConfig,
  verifyAuditChain,
  type Payment,
  type RecoveryEngine,
} from '@reclaim/core';
import { createFirestoreDataStore, readModelArtifact } from '@reclaim/core/node';

/**
 * RECLAIM — Firebase Cloud Functions
 *
 * The server-side workflows that should not depend on a browser being open:
 *
 *   - `onPaymentFailure`  a Firestore trigger that opens a recovery case the moment a
 *                         failed payment is written, so detection is event-driven rather
 *                         than a polling job.
 *   - `runRecoverySweep`  a scheduled worker that processes the open queue on a cadence.
 *   - `razorpayWebhook`   receives Razorpay events, verifies the signature, and ingests.
 *   - `verifyAuditTrail`  a scheduled integrity check over the hash chain.
 *
 * All four construct the same `RecoveryEngine` the web application uses. There is no
 * second implementation of the recovery logic here — a Cloud Function is a different
 * trigger for the same engine, not a different engine.
 */

setGlobalOptions({
  region: 'asia-south1',
  maxInstances: 10,
  memory: '512MiB',
  timeoutSeconds: 300,
});

const merchantId = defineString('RECLAIM_MERCHANT_ID', { default: 'merch_reclaim_demo' });
const razorpayWebhookSecret = defineSecret('RAZORPAY_WEBHOOK_SECRET');

/**
 * The engine is built once per container and reused across invocations. Cold starts pay
 * for it; warm invocations do not.
 */
let enginePromise: Promise<RecoveryEngine> | null = null;

function getEngine(): Promise<RecoveryEngine> {
  enginePromise ??= (async () => {
    const config = loadConfig({
      ...process.env,
      RECLAIM_STORE: 'firestore',
      RECLAIM_MERCHANT_ID: merchantId.value(),
    });

    const store = await createFirestoreDataStore(config.firebase);

    // The model artifact ships with the function bundle. If it is missing the engine
    // still runs, on the taxonomy prior, and says so on every prediction.
    const modelArtifact = readModelArtifact(config.dataDir);
    if (!modelArtifact) {
      logger.warn('No model artifact in the function bundle; predictions will be degraded.');
    }

    return createRecoveryEngine({ config, store, modelArtifact });
  })();
  return enginePromise;
}

/* -------------------------------------------------------------------------- */
/* Event-driven detection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Open a recovery case the instant a failed payment lands in Firestore.
 *
 * The handler is idempotent by construction: `createCase` de-duplicates on
 * `(merchantId, sourceId)`, so Firestore's at-least-once delivery cannot produce two
 * cases competing to recover the same rupees.
 */
export const onPaymentFailure = onDocumentCreated('payments/{paymentId}', async (event) => {
  const payment = event.data?.data() as Payment | undefined;
  if (!payment || payment.status !== 'failed') return;

  // A payment produced by our own recovery attempt must not open a fresh case.
  if (payment.source === 'recovery') return;

  const engine = await getEngine();
  const subscription = payment.subscriptionId
    ? await engine.store.subscriptions.get(payment.subscriptionId)
    : null;

  const caseId = await engine.ingestion.ingestPayment(payment, subscription);

  logger.info('payment failure ingested', {
    paymentId: payment.id,
    caseId,
    amountMinor: payment.amountMinor,
    failureReason: payment.failureReason,
  });
});

/* -------------------------------------------------------------------------- */
/* Scheduled recovery sweep                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Work the open queue on a schedule.
 *
 * Sequential by design: the policy engine reads per-customer contact counts and per-case
 * cooldowns that earlier iterations mutate. Running concurrently would let two cases for
 * the same customer each observe "no contact yet today" and both message them.
 */
export const runRecoverySweep = onSchedule(
  { schedule: 'every 60 minutes', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const engine = await getEngine();

    const detection = await engine.ingestion.ingest(engine.merchantId, { maxCases: 200 });
    const queue = await engine.cases.listWorkQueue(engine.merchantId, { limit: 100 });

    const result = await engine.decisions.runBatch(
      queue.map((c) => c.id),
      {
        execute: true,
        actor: { kind: 'scheduler', id: 'runRecoverySweep' },
        trigger: 'scheduled_sweep',
      },
    );

    logger.info('recovery sweep complete', {
      detected:
        detection.created.paymentFailure +
        detection.created.subscriptionDunning +
        detection.created.checkoutAbandonment +
        detection.created.overdueInvoice,
      processed: result.processed,
      recoveredMinor: result.recoveredMinor,
      blocked: result.blockedCount,
      escalated: result.escalatedCount,
      duplicatesPrevented: result.duplicatesPrevented,
      failed: result.failedCount,
      durationMs: result.durationMs,
    });
  },
);

/* -------------------------------------------------------------------------- */
/* Audit integrity                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Replay the hash chain on a schedule and shout if it does not verify.
 *
 * An integrity check that only runs when someone opens a page is not an integrity check.
 */
export const verifyAuditTrail = onSchedule({ schedule: 'every 24 hours' }, async () => {
  const engine = await getEngine();
  const logs = await engine.store.auditLogs.list({
    where: [{ field: 'merchantId', op: '==', value: engine.merchantId }],
  });

  const result = verifyAuditChain(logs);
  if (result.valid) {
    logger.info('audit chain verified', { entries: result.checked });
    return;
  }

  logger.error('AUDIT CHAIN VERIFICATION FAILED', {
    brokenAt: result.brokenAt,
    reason: result.reason,
    entriesChecked: result.checked,
  });
});

/* -------------------------------------------------------------------------- */
/* Razorpay webhook                                                            */
/* -------------------------------------------------------------------------- */

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        method?: string;
        error_code?: string | null;
        error_description?: string | null;
        notes?: Record<string, string>;
        created_at?: number;
      };
    };
  };
}

/**
 * Receive Razorpay events.
 *
 * The signature is verified before the body is trusted, using a timing-safe comparison —
 * an ordinary string compare leaks information about the expected digest through its
 * early-exit behaviour, which is enough to forge a signature given enough attempts.
 */
export const razorpayWebhook = onRequest(
  { secrets: [razorpayWebhookSecret], cors: false },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }

    const signature = request.get('x-razorpay-signature');
    const secret = razorpayWebhookSecret.value();

    if (!signature || !secret) {
      logger.warn('razorpay webhook rejected: missing signature or secret');
      response.status(401).json({ ok: false, error: 'unauthorised' });
      return;
    }

    const { createHmac, timingSafeEqual } = await import('node:crypto');
    const rawBody = request.rawBody?.toString('utf-8') ?? JSON.stringify(request.body);
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    const provided = Buffer.from(signature, 'utf-8');
    const computed = Buffer.from(expected, 'utf-8');
    const valid =
      provided.length === computed.length && timingSafeEqual(provided, computed);

    if (!valid) {
      logger.warn('razorpay webhook rejected: signature mismatch');
      response.status(401).json({ ok: false, error: 'invalid signature' });
      return;
    }

    const body = request.body as RazorpayWebhookBody;
    const entity = body.payload?.payment?.entity;

    // Only failure events open a case; captures are handled by the outcome tracker.
    if (body.event !== 'payment.failed' || !entity?.id) {
      response.status(200).json({ ok: true, ignored: true, event: body.event ?? null });
      return;
    }

    try {
      const engine = await getEngine();
      const customerId = entity.notes?.reclaim_customer_id;

      if (!customerId) {
        logger.warn('razorpay webhook: payment has no reclaim_customer_id note', {
          paymentId: entity.id,
        });
        response.status(200).json({ ok: true, ignored: true, reason: 'no customer reference' });
        return;
      }

      const payment: Payment = {
        id: entity.id,
        merchantId: engine.merchantId,
        customerId,
        amountMinor: entity.amount ?? 0,
        currency: 'INR',
        method: (entity.method as Payment['method']) ?? 'card',
        issuer: 'razorpay',
        network: null,
        status: 'failed',
        source: 'checkout',
        // The engine's own taxonomy classifies the failure; the raw code is kept alongside.
        failureReason: null,
        errorCode: entity.error_code ?? null,
        createdAt: entity.created_at
          ? new Date(entity.created_at * 1000).toISOString()
          : new Date().toISOString(),
        capturedAt: null,
        subscriptionId: null,
        invoiceId: null,
        recoveryCaseId: null,
        idempotencyKey: `razorpay:${entity.id}`,
        providerRef: entity.id,
      };

      await engine.store.payments.put(payment);
      const caseId = await engine.ingestion.ingestPayment(payment, null);

      logger.info('razorpay failure ingested', { paymentId: entity.id, caseId });
      response.status(200).json({ ok: true, caseId });
    } catch (error) {
      logger.error('razorpay webhook processing failed', error);
      // Return 200 so Razorpay does not retry a request we have already stored; the
      // scheduled sweep will pick up anything that did not fully process.
      response.status(200).json({ ok: false, error: 'processing failed' });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

/** Liveness probe for uptime monitoring. */
export const health = onRequest({ cors: true }, async (_request, response) => {
  try {
    const engine = await getEngine();
    const status = await engine.health();
    response.status(status.payments.healthy ? 200 : 503).json({
      ok: true,
      mode: engine.config.mode,
      store: status.store.kind,
      model: status.model,
      payments: status.payments,
      circuits: status.circuits,
    });
  } catch (error) {
    logger.error('health check failed', error);
    response.status(503).json({ ok: false, error: 'engine unavailable' });
  }
});
