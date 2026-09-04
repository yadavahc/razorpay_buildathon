import { z } from 'zod';
import {
  caseSourceTypeSchema,
  caseStatusSchema,
  customerSegmentSchema,
  failureReasonSchema,
  invoiceStatusSchema,
  notificationChannelSchema,
  paymentMethodSchema,
  paymentSourceSchema,
  paymentStatusSchema,
  recoveryStrategySchema,
  subscriptionStatusSchema,
} from './enums.js';

/**
 * Timestamps are ISO-8601 UTC strings across every layer. They sort lexicographically,
 * survive JSON round-trips, and range-query correctly in Firestore, which removes an
 * entire class of serialization bugs between the seed files, the API and the UI.
 */
export const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'invalid ISO-8601 timestamp' });

export const minorAmount = z
  .number()
  .int({ message: 'amounts must be integer minor units (paise)' })
  .nonnegative();

export const probability = z.number().min(0).max(1);

export const merchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  legalName: z.string().min(1),
  mcc: z.string(),
  currency: z.literal('INR'),
  createdAt: isoTimestamp,
  /** Per-merchant guardrail overrides, merged over the platform defaults. */
  policyOverrides: z.record(z.string(), z.number()).default({}),
});
export type Merchant = z.infer<typeof merchantSchema>;

export const customerSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(6),
  segment: customerSegmentSchema,
  createdAt: isoTimestamp,
  /** Denormalised counters maintained by the ingestion service for O(1) feature reads. */
  lifetimeValueMinor: minorAmount,
  successfulPaymentCount: z.number().int().nonnegative(),
  failedPaymentCount: z.number().int().nonnegative(),
  priorRecoveryAttempts: z.number().int().nonnegative(),
  priorRecoverySuccesses: z.number().int().nonnegative(),
  lastSuccessfulPaymentAt: isoTimestamp.nullable(),
  lastFailedPaymentAt: isoTimestamp.nullable(),
  preferredMethod: paymentMethodSchema,
  contactPreference: notificationChannelSchema,
  /** Hard eligibility gates enforced by the policy engine, never by the model. */
  contactOptOut: z.boolean(),
  doNotRetry: z.boolean(),
  chargebackCount: z.number().int().nonnegative(),
  timezone: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

export const paymentSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  amountMinor: minorAmount,
  currency: z.literal('INR'),
  method: paymentMethodSchema,
  /** Instrument detail used for leakage attribution (issuer, network, bank, handle). */
  issuer: z.string(),
  network: z.string().nullable(),
  status: paymentStatusSchema,
  source: paymentSourceSchema,
  failureReason: failureReasonSchema.nullable(),
  errorCode: z.string().nullable(),
  createdAt: isoTimestamp,
  capturedAt: isoTimestamp.nullable(),
  subscriptionId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  /** Set when this payment was itself produced by a recovery action. */
  recoveryCaseId: z.string().nullable(),
  idempotencyKey: z.string(),
  providerRef: z.string().nullable(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const paymentAttemptSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  paymentId: z.string().min(1),
  customerId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  status: paymentStatusSchema,
  failureReason: failureReasonSchema.nullable(),
  gatewayLatencyMs: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
  /** True when this attempt was initiated by RECLAIM rather than the customer. */
  initiatedByRecovery: z.boolean(),
});
export type PaymentAttempt = z.infer<typeof paymentAttemptSchema>;

export const subscriptionSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  planId: z.string().min(1),
  planName: z.string().min(1),
  planAmountMinor: minorAmount,
  interval: z.enum(['monthly', 'quarterly', 'annual']),
  status: subscriptionStatusSchema,
  startedAt: isoTimestamp,
  currentPeriodEnd: isoTimestamp,
  completedCycles: z.number().int().nonnegative(),
  failedCycles: z.number().int().nonnegative(),
  method: paymentMethodSchema,
  /** A revoked mandate makes retries structurally impossible — a hard policy stop. */
  mandateActive: z.boolean(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const invoiceSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  number: z.string(),
  amountMinor: minorAmount,
  status: invoiceStatusSchema,
  issuedAt: isoTimestamp,
  dueAt: isoTimestamp,
  paidAt: isoTimestamp.nullable(),
  subscriptionId: z.string().nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const checkoutSessionSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  cartValueMinor: minorAmount,
  /** Where the customer dropped out; later stages recover materially better. */
  stage: z.enum(['cart', 'contact', 'method_selected', 'otp_pending']),
  method: paymentMethodSchema.nullable(),
  startedAt: isoTimestamp,
  abandonedAt: isoTimestamp,
  convertedPaymentId: z.string().nullable(),
});
export type CheckoutSession = z.infer<typeof checkoutSessionSchema>;

/** A single, replayable step in a recovery case lifecycle, rendered as the UI timeline. */
export const caseTimelineEntrySchema = z.object({
  at: isoTimestamp,
  kind: z.enum([
    'detected',
    'investigated',
    'predicted',
    'decided',
    'policy_evaluated',
    'action_executed',
    'action_blocked',
    'action_failed',
    'fallback_taken',
    'outcome_recorded',
    'escalated',
    'closed',
    'note',
  ]),
  summary: z.string(),
  refId: z.string().nullable().default(null),
  amountMinor: z.number().int().nullable().default(null),
});
export type CaseTimelineEntry = z.infer<typeof caseTimelineEntrySchema>;

export const recoveryCaseSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  sourceType: caseSourceTypeSchema,
  sourceId: z.string().min(1),
  amountAtRiskMinor: minorAmount,
  currency: z.literal('INR'),
  status: caseStatusSchema,
  failureReason: failureReasonSchema.nullable(),
  method: paymentMethodSchema,
  /** Model output; null until the prediction step has run. */
  recoveryProbability: probability.nullable(),
  expectedValueMinor: z.number().int().nullable(),
  /** amountAtRisk x probability, used to rank the opportunity map. */
  priorityScore: z.number().nullable(),
  selectedStrategy: recoveryStrategySchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  notificationCount: z.number().int().nonnegative(),
  recoveredAmountMinor: minorAmount,
  detectedAt: isoTimestamp,
  updatedAt: isoTimestamp,
  lastActionAt: isoTimestamp.nullable(),
  cooldownUntil: isoTimestamp.nullable(),
  resolvedAt: isoTimestamp.nullable(),
  escalationReason: z.string().nullable(),
  timeline: z.array(caseTimelineEntrySchema).default([]),
});
export type RecoveryCase = z.infer<typeof recoveryCaseSchema>;

export const notificationSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  caseId: z.string().min(1),
  customerId: z.string().min(1),
  channel: notificationChannelSchema,
  template: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['queued', 'sent', 'failed', 'suppressed']),
  createdAt: isoTimestamp,
  sentAt: isoTimestamp.nullable(),
  suppressionReason: z.string().nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const paymentLinkSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  caseId: z.string().min(1),
  customerId: z.string().min(1),
  amountMinor: minorAmount,
  shortUrl: z.string(),
  status: z.enum(['created', 'paid', 'expired', 'cancelled']),
  createdAt: isoTimestamp,
  expiresAt: isoTimestamp,
  paidAt: isoTimestamp.nullable(),
  providerRef: z.string().nullable(),
});
export type PaymentLink = z.infer<typeof paymentLinkSchema>;

export const userSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string(),
  role: z.enum(['owner', 'analyst', 'viewer']),
  createdAt: isoTimestamp,
});
export type User = z.infer<typeof userSchema>;
