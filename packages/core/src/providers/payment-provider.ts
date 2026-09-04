import type { FailureReason, NotificationChannel, PaymentMethod, RunMode } from '../types/enums.js';

/**
 * The payment-provider seam.
 *
 * Everything downstream of the decisioning engine talks to this interface, which is what
 * lets the identical recovery pipeline run against a deterministic offline provider or
 * against Razorpay's test-mode API by changing one environment variable.
 *
 * Each result carries `simulated`, and an operation that cannot be genuinely performed in
 * the available test environment says so in `simulationNote` rather than quietly
 * pretending. That honesty is not decoration: the audit trail records it, and the UI
 * shows it next to every executed action.
 */

export interface ProviderIdentity {
  name: string;
  mode: RunMode;
  /** True when calls leave the process and hit a real external API. */
  live: boolean;
  description: string;
}

export interface RetryPaymentRequest {
  idempotencyKey: string;
  caseId: string;
  customerId: string;
  customerEmail: string;
  customerPhone: string;
  amountMinor: number;
  currency: 'INR';
  method: PaymentMethod;
  issuer: string;
  /** Original failure being recovered from; drives the simulated outcome distribution. */
  originalFailureReason: FailureReason | null;
  /**
   * Probability the decisioning engine computed for this specific attempt. The offline
   * provider samples against it, so simulated outcomes match the modelled world instead
   * of being arbitrary.
   */
  successProbability: number;
  description: string;
}

export interface PaymentResult {
  providerRef: string;
  status: 'captured' | 'failed';
  amountMinor: number;
  failureReason: FailureReason | null;
  errorCode: string | null;
  latencyMs: number;
  simulated: boolean;
  simulationNote: string | null;
  raw: Record<string, unknown>;
}

export interface CreatePaymentLinkRequest {
  idempotencyKey: string;
  caseId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  amountMinor: number;
  currency: 'INR';
  description: string;
  expiresInHours: number;
  /** Probability the link is paid; used by the offline provider only. */
  successProbability: number;
}

export interface PaymentLinkResult {
  providerRef: string;
  shortUrl: string;
  status: 'created';
  amountMinor: number;
  expiresAt: string;
  latencyMs: number;
  simulated: boolean;
  simulationNote: string | null;
  raw: Record<string, unknown>;
}

export interface ProviderPaymentSnapshot {
  providerRef: string;
  status: string;
  amountMinor: number;
  method: string | null;
  capturedAt: string | null;
}

export interface ProviderHealth {
  healthy: boolean;
  latencyMs: number;
  detail: string;
}

export interface PaymentProvider {
  readonly identity: ProviderIdentity;
  /** Re-present an authorisation. MUST be idempotent on `idempotencyKey`. */
  retryPayment(request: RetryPaymentRequest): Promise<PaymentResult>;
  createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLinkResult>;
  fetchPayment(providerRef: string): Promise<ProviderPaymentSnapshot | null>;
  health(): Promise<ProviderHealth>;
}

export interface SendNotificationRequest {
  idempotencyKey: string;
  caseId: string;
  customerId: string;
  channel: NotificationChannel;
  to: string;
  subject: string;
  body: string;
}

export interface NotificationResult {
  providerRef: string;
  status: 'sent' | 'failed';
  channel: NotificationChannel;
  latencyMs: number;
  simulated: boolean;
  simulationNote: string | null;
  error: string | null;
}

export interface NotificationProvider {
  readonly identity: ProviderIdentity;
  send(request: SendNotificationRequest): Promise<NotificationResult>;
}
