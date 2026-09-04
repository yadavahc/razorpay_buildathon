import { getFailureProfile } from '../domain/failure-taxonomy.js';
import { faultInjector } from '../services/fault-injector.js';
import type { FailureReason } from '../types/enums.js';
import { FAILURE_REASONS } from '../types/enums.js';
import { addHours } from '../util/time.js';
import { createRng } from '../util/rng.js';
import type {
  CreatePaymentLinkRequest,
  NotificationProvider,
  NotificationResult,
  PaymentLinkResult,
  PaymentProvider,
  PaymentResult,
  ProviderHealth,
  ProviderIdentity,
  ProviderPaymentSnapshot,
  RetryPaymentRequest,
  SendNotificationRequest,
} from './payment-provider.js';

/**
 * THE OFFLINE PAYMENT PROVIDER
 *
 * The default provider, and the one that makes the whole system runnable with no
 * credentials at all. Two properties make it useful rather than merely convenient:
 *
 * 1. **It is deterministic in the idempotency key.** The outcome of an attempt is drawn
 *    from a generator seeded by that key, so replaying the same action produces the same
 *    result — which is exactly the semantics a real provider's idempotency guarantee
 *    gives you, and it means duplicate-suppression bugs surface here instead of in
 *    production.
 *
 * 2. **Its outcomes are drawn from the decisioning engine's own probability.** The
 *    executor passes the probability it computed, and the provider samples against it.
 *    A batch therefore recovers roughly the amount the engine predicted it would, which
 *    is what makes the measured recovery numbers meaningful rather than decorative.
 *
 * When an attempt fails, the failure reason is drawn from the taxonomy in a way that
 * respects the original cause: an insufficient-funds decline usually fails the same way
 * again, and occasionally fails differently.
 */

const IDENTITY: ProviderIdentity = {
  name: 'RECLAIM demo provider',
  mode: 'demo',
  live: false,
  description:
    'Deterministic offline payment simulator. Outcomes are seeded by idempotency key and sampled from the decisioning engine own probability, so results are reproducible across machines.',
};

export interface DemoProviderOptions {
  /** Artificial latency floor, kept low so batch runs stay fast. */
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** Probability that any given call fails with a transient infrastructure error. */
  transientFailureRate?: number;
  /** Set false in tests to remove wall-clock delay entirely. */
  simulateLatency?: boolean;
}

export class DemoPaymentProvider implements PaymentProvider {
  readonly identity = IDENTITY;

  private readonly minLatencyMs: number;
  private readonly maxLatencyMs: number;
  private readonly transientFailureRate: number;
  private readonly simulateLatency: boolean;
  private readonly ledger = new Map<string, ProviderPaymentSnapshot>();

  constructor(options: DemoProviderOptions = {}) {
    this.minLatencyMs = options.minLatencyMs ?? 12;
    this.maxLatencyMs = options.maxLatencyMs ?? 90;
    this.transientFailureRate = options.transientFailureRate ?? 0.03;
    this.simulateLatency = options.simulateLatency ?? true;
  }

  private async latency(rng: ReturnType<typeof createRng>): Promise<number> {
    const ms = rng.int(this.minLatencyMs, this.maxLatencyMs);
    if (this.simulateLatency && ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 60)));
    return ms;
  }

  async retryPayment(request: RetryPaymentRequest): Promise<PaymentResult> {
    faultInjector.maybeFail('payment_timeout', 'payments', 'retryPayment');
    faultInjector.maybeFail('gateway_failure', 'payments', 'retryPayment');
    faultInjector.maybeFail('invalid_transaction', 'payments', 'retryPayment');
    faultInjector.maybeFail('external_api_failure', 'payments', 'retryPayment');

    const rng = createRng(`retry:${request.idempotencyKey}`);
    const latencyMs = await this.latency(rng);
    const providerRef = `pay_demo_${hashRef(request.idempotencyKey)}`;

    // Transient infrastructure noise, independent of whether the case was recoverable.
    if (rng.bool(this.transientFailureRate)) {
      const reason: FailureReason = rng.pick(['gateway_error', 'network_error', 'payment_timeout']);
      this.ledger.set(providerRef, {
        providerRef,
        status: 'failed',
        amountMinor: request.amountMinor,
        method: request.method,
        capturedAt: null,
      });
      return {
        providerRef,
        status: 'failed',
        amountMinor: request.amountMinor,
        failureReason: reason,
        errorCode: getFailureProfile(reason).errorCode,
        latencyMs,
        simulated: true,
        simulationNote: 'Simulated transient gateway fault.',
        raw: { simulated: true, cause: 'transient' },
      };
    }

    const succeeded = rng.next() < request.successProbability;
    if (succeeded) {
      const snapshot: ProviderPaymentSnapshot = {
        providerRef,
        status: 'captured',
        amountMinor: request.amountMinor,
        method: request.method,
        capturedAt: new Date().toISOString(),
      };
      this.ledger.set(providerRef, snapshot);
      return {
        providerRef,
        status: 'captured',
        amountMinor: request.amountMinor,
        failureReason: null,
        errorCode: null,
        latencyMs,
        simulated: true,
        simulationNote: null,
        raw: { simulated: true, successProbability: request.successProbability },
      };
    }

    const failureReason = this.sampleFailureReason(rng, request.originalFailureReason);
    this.ledger.set(providerRef, {
      providerRef,
      status: 'failed',
      amountMinor: request.amountMinor,
      method: request.method,
      capturedAt: null,
    });
    return {
      providerRef,
      status: 'failed',
      amountMinor: request.amountMinor,
      failureReason,
      errorCode: getFailureProfile(failureReason).errorCode,
      latencyMs,
      simulated: true,
      simulationNote: null,
      raw: { simulated: true, successProbability: request.successProbability },
    };
  }

  /**
   * A repeat attempt usually reproduces the original decline; sometimes the underlying
   * situation has moved and a different condition surfaces instead.
   */
  private sampleFailureReason(
    rng: ReturnType<typeof createRng>,
    original: FailureReason | null,
  ): FailureReason {
    if (original && rng.bool(0.78)) return original;
    return rng.weighted(
      FAILURE_REASONS.map((reason) => [reason, getFailureProfile(reason).baseRecoverability + 0.15]),
    );
  }

  async createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLinkResult> {
    faultInjector.maybeFail('gateway_failure', 'payments', 'createPaymentLink');
    faultInjector.maybeFail('external_api_failure', 'payments', 'createPaymentLink');

    const rng = createRng(`link:${request.idempotencyKey}`);
    const latencyMs = await this.latency(rng);
    const providerRef = `plink_demo_${hashRef(request.idempotencyKey)}`;

    return {
      providerRef,
      shortUrl: `https://demo.reclaim.pay/l/${providerRef.slice(-10)}`,
      status: 'created',
      amountMinor: request.amountMinor,
      expiresAt: addHours(new Date().toISOString(), request.expiresInHours),
      latencyMs,
      simulated: true,
      simulationNote:
        'Link is generated locally and is not payable. Whether the customer pays it is resolved by the outcome simulator, not by a live page.',
      raw: { simulated: true },
    };
  }

  /**
   * Resolve whether an issued link was actually paid. Called by the outcome tracker after
   * the customer response window; deterministic in the link reference.
   */
  resolveLinkOutcome(providerRef: string, successProbability: number): boolean {
    return createRng(`linkoutcome:${providerRef}`).next() < successProbability;
  }

  async fetchPayment(providerRef: string): Promise<ProviderPaymentSnapshot | null> {
    return this.ledger.get(providerRef) ?? null;
  }

  async health(): Promise<ProviderHealth> {
    return {
      healthy: true,
      latencyMs: 0,
      detail: 'Offline provider; always available.',
    };
  }
}

const NOTIFICATION_IDENTITY: ProviderIdentity = {
  name: 'RECLAIM demo messaging',
  mode: 'demo',
  live: false,
  description:
    'Renders and records messages without dispatching them. No email or SMS leaves the process, which is the correct behaviour for a system running on synthetic customer data.',
};

export class DemoNotificationProvider implements NotificationProvider {
  readonly identity = NOTIFICATION_IDENTITY;

  async send(request: SendNotificationRequest): Promise<NotificationResult> {
    faultInjector.maybeFail('external_api_failure', 'notifications', 'send');

    const rng = createRng(`notify:${request.idempotencyKey}`);
    // Real messaging channels bounce. Modelling that keeps the outcome accounting honest.
    const bounced = rng.bool(0.02);

    return {
      providerRef: `msg_demo_${hashRef(request.idempotencyKey)}`,
      status: bounced ? 'failed' : 'sent',
      channel: request.channel,
      latencyMs: rng.int(4, 25),
      simulated: true,
      simulationNote: 'Message rendered and stored; nothing was dispatched.',
      error: bounced ? 'simulated delivery bounce' : null,
    };
  }
}

function hashRef(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (h * 33) ^ key.charCodeAt(i);
  return (h >>> 0).toString(36).padStart(7, '0');
}
