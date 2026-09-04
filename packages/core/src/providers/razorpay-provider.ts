import type { RazorpayConfig } from '../config/index.js';
import { errors } from '../errors/index.js';
import { withTimeout } from '../resilience/index.js';
import { faultInjector } from '../services/fault-injector.js';
import { addHours } from '../util/time.js';
import type {
  CreatePaymentLinkRequest,
  PaymentLinkResult,
  PaymentProvider,
  PaymentResult,
  ProviderHealth,
  ProviderIdentity,
  ProviderPaymentSnapshot,
  RetryPaymentRequest,
} from './payment-provider.js';
import { DemoPaymentProvider } from './demo-provider.js';

/**
 * RAZORPAY TEST-MODE PROVIDER
 *
 * Activated by setting `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (test keys, `rzp_test_…`)
 * and `RECLAIM_MODE=razorpay_test`. Calls go to the real Razorpay REST API over HTTPS
 * with HTTP Basic auth; no vendor SDK is required for the endpoints we use.
 *
 * WHAT IS REAL AND WHAT IS NOT — stated plainly, because the difference matters:
 *
 *   - `createPaymentLink` is **fully real**. It creates an actual Razorpay payment link
 *     in the test account, returns the real `short_url`, and that link is openable and
 *     payable with Razorpay's test instruments. This is the single most important
 *     recovery action in the product, and it is genuinely exercised end to end.
 *
 *   - `fetchPayment` and `health` are **fully real** reads against the Payments API.
 *
 *   - `retryPayment` is **partly real**. RECLAIM creates a genuine Order for the retry
 *     amount, so the money movement is registered on the Razorpay side with a real
 *     `order_id`. It cannot then complete the authorisation leg: re-charging a stored
 *     instrument server-side requires a customer-authorised token or an active
 *     e-mandate, which cannot be provisioned safely from a demo environment and must
 *     never be faked against a live-looking API. The authorisation outcome is therefore
 *     resolved by the same deterministic simulator the offline provider uses, and the
 *     result is returned with `simulated: true` plus an explicit `simulationNote` that
 *     the audit trail and the UI both display.
 *
 * The alternative — quietly reporting a simulated authorisation as a real one — would
 * make every recovery figure in the product untrustworthy. Labelling it costs nothing.
 */

const IDENTITY: ProviderIdentity = {
  name: 'Razorpay (test mode)',
  mode: 'razorpay_test',
  live: true,
  description:
    'Live calls to the Razorpay test API. Payment links, payment reads and health checks are real; the card authorisation leg of a retry is simulated and labelled, because re-charging a stored instrument requires a customer-authorised token.',
};

interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string };
}

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
}

interface RazorpayPaymentLink {
  id: string;
  short_url: string;
  amount: number;
  status: string;
  expire_by?: number;
}

interface RazorpayPayment {
  id: string;
  status: string;
  amount: number;
  method?: string;
  created_at?: number;
  error_code?: string | null;
  error_description?: string | null;
}

export class RazorpayProvider implements PaymentProvider {
  readonly identity = IDENTITY;

  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** Resolves the authorisation leg that the test API cannot perform for us. */
  private readonly authorisationSimulator = new DemoPaymentProvider({ simulateLatency: false });

  constructor(config: RazorpayConfig, timeoutMs = 15_000) {
    if (!config.keyId || !config.keySecret) {
      throw errors.config('RazorpayProvider requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    if (!config.keyId.startsWith('rzp_test_')) {
      // A guard, not a preference. This project must never be pointed at live keys.
      throw errors.config(
        `RECLAIM refuses to run against non-test Razorpay keys (received "${config.keyId.slice(0, 12)}…"). Use a rzp_test_ key.`,
      );
    }
    this.authHeader = `Basic ${base64(`${config.keyId}:${config.keySecret}`)}`;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.authHeader,
      'content-type': 'application/json',
    };
    if (idempotencyKey) headers['x-razorpay-idempotency-key'] = idempotencyKey;

    const response = await withTimeout(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        }),
      this.timeoutMs,
      'razorpay',
    );

    const payload = (await response.json().catch(() => ({}))) as T & RazorpayErrorBody;

    if (!response.ok) {
      const description = payload.error?.description ?? `HTTP ${response.status}`;
      if (response.status >= 500) throw errors.providerUnavailable('razorpay');
      if (response.status === 429) {
        throw errors.providerError('razorpay', 'rate limited', { status: 429 });
      }
      throw errors.providerError('razorpay', description, {
        status: response.status,
        code: payload.error?.code ?? null,
      });
    }

    return payload;
  }

  /**
   * Create a real Order for the retry, then resolve the authorisation deterministically.
   * The Order id is genuine and visible in the Razorpay test dashboard.
   */
  async retryPayment(request: RetryPaymentRequest): Promise<PaymentResult> {
    faultInjector.maybeFail('payment_timeout', 'payments', 'retryPayment');
    faultInjector.maybeFail('gateway_failure', 'payments', 'retryPayment');
    faultInjector.maybeFail('invalid_transaction', 'payments', 'retryPayment');

    const started = Date.now();

    const order = await this.call<RazorpayOrder>(
      'POST',
      '/orders',
      {
        amount: request.amountMinor,
        currency: request.currency,
        // Razorpay receipts are capped at 40 characters.
        receipt: `rcl_${request.caseId}`.slice(0, 40),
        notes: {
          reclaim_case_id: request.caseId,
          reclaim_customer_id: request.customerId,
          recovery_attempt: 'true',
        },
      },
      request.idempotencyKey,
    );

    const simulated = await this.authorisationSimulator.retryPayment(request);

    return {
      providerRef: order.id,
      status: simulated.status,
      amountMinor: request.amountMinor,
      failureReason: simulated.failureReason,
      errorCode: simulated.errorCode,
      latencyMs: Date.now() - started,
      simulated: true,
      simulationNote: `Razorpay order ${order.id} was created for real in test mode. The card authorisation leg is simulated: re-charging a stored instrument requires a customer-authorised token or active e-mandate, which a demo environment cannot provision.`,
      raw: { order, simulatedAuthorisation: true },
    };
  }

  /** Fully real: creates a genuine, openable Razorpay test-mode payment link. */
  async createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLinkResult> {
    faultInjector.maybeFail('gateway_failure', 'payments', 'createPaymentLink');
    faultInjector.maybeFail('external_api_failure', 'payments', 'createPaymentLink');

    const started = Date.now();
    const expiresAt = addHours(new Date().toISOString(), request.expiresInHours);

    const link = await this.call<RazorpayPaymentLink>(
      'POST',
      '/payment_links',
      {
        amount: request.amountMinor,
        currency: request.currency,
        description: request.description.slice(0, 2048),
        // Razorpay requires the expiry to be at least 15 minutes out.
        expire_by: Math.floor(Date.parse(expiresAt) / 1000),
        reference_id: request.idempotencyKey.slice(0, 40),
        customer: {
          name: request.customerName,
          email: request.customerEmail,
          contact: request.customerPhone,
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { reclaim_case_id: request.caseId, reclaim_customer_id: request.customerId },
      },
      request.idempotencyKey,
    );

    return {
      providerRef: link.id,
      shortUrl: link.short_url,
      status: 'created',
      amountMinor: link.amount,
      expiresAt,
      latencyMs: Date.now() - started,
      simulated: false,
      simulationNote: null,
      raw: { link: link as unknown as Record<string, unknown> },
    };
  }

  async fetchPayment(providerRef: string): Promise<ProviderPaymentSnapshot | null> {
    try {
      const payment = await this.call<RazorpayPayment>('GET', `/payments/${providerRef}`);
      return {
        providerRef: payment.id,
        status: payment.status,
        amountMinor: payment.amount,
        method: payment.method ?? null,
        capturedAt:
          payment.status === 'captured' && payment.created_at
            ? new Date(payment.created_at * 1000).toISOString()
            : null,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not exist')) return null;
      throw error;
    }
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.call('GET', '/payments?count=1');
      return {
        healthy: true,
        latencyMs: Date.now() - started,
        detail: 'Razorpay test API reachable.',
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}

function base64(value: string): string {
  if (typeof btoa === 'function') return btoa(value);
  // Node without a global btoa.
  const BufferCtor = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } })
    .Buffer;
  if (BufferCtor) return BufferCtor.from(value, 'utf-8').toString('base64');
  throw errors.internal('no base64 encoder available in this runtime');
}
