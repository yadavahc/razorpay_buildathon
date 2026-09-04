import type { CaseSourceType, CustomerSegment, PaymentMethod } from '../types/enums.js';
import { clamp } from '../util/collections.js';

/**
 * The feature contract for the recovery-probability model.
 *
 * Every field here must be computable at inference time from the recovery opportunity
 * graph alone. That constraint is what keeps training and serving honest: there is no
 * feature in this list that a live case could not produce.
 */
export interface RecoveryFeatureInput {
  amountMinor: number;
  /** Failure reason, abandonment stage or overdue bucket — the case profile key. */
  profileKey: string;
  /** Domain prior from the failure taxonomy, in [0, 1]. */
  baseRecoverability: number;
  selfResolving: boolean;
  customerActionRequired: boolean;
  method: PaymentMethod;
  issuer: string;
  segment: CustomerSegment;
  sourceType: CaseSourceType;
  customerSuccessCount: number;
  customerFailureCount: number;
  customerLifetimeValueMinor: number;
  priorRecoveryAttempts: number;
  priorRecoverySuccesses: number;
  hoursSinceFailure: number;
  /** Null when the customer has never paid successfully. */
  daysSinceLastSuccess: number | null;
  /** Null when the case is not tied to a subscription. */
  subscriptionAgeDays: number | null;
  isSubscription: boolean;
  attemptNumber: number;
  /** The customer has previously paid with a different instrument that still works. */
  hasAlternateSuccessfulMethod: boolean;
  /** The failure landed inside the merchant's business hours. */
  isBusinessHours: boolean;
  /** Many failures at the same issuer in a short window — an outage, not a decline. */
  bankDowntimeCluster: boolean;
}

/** Ordered, stable feature names. The order is part of the model artifact contract. */
export const FEATURE_NAMES = [
  'log_amount',
  'profile_prior',
  'profile_target_encoding',
  'method_target_encoding',
  'segment_target_encoding',
  'issuer_target_encoding',
  'source_target_encoding',
  'customer_success_log',
  'customer_failure_log',
  'customer_success_ratio',
  'prior_recovery_rate',
  'prior_recovery_experience',
  'hours_since_failure_log',
  'days_since_success_norm',
  'has_prior_success',
  'subscription_age_norm',
  'is_subscription',
  'attempt_number',
  'has_alternate_method',
  'lifetime_value_log',
  'self_resolving',
  'customer_action_required',
  'business_hours',
  'bank_downtime_cluster',
  // Interactions. A linear model cannot discover these on its own, and they encode the
  // two relationships the domain says matter most: a good customer inside a recoverable
  // failure class is far better than either signal alone, and a large amount inside a
  // structurally unrecoverable class is worse than either.
  'prior_x_success_ratio',
  'prior_x_log_amount',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;

/**
 * Human-readable labels and the direction a merchant should read them in. Used verbatim
 * by the Decision Inspector so the UI never invents its own vocabulary for a feature.
 */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  log_amount: 'Transaction size',
  profile_prior: 'Failure-class recoverability prior',
  profile_target_encoding: 'Historical recovery rate for this failure class',
  method_target_encoding: 'Historical recovery rate for this payment method',
  segment_target_encoding: 'Historical recovery rate for this customer segment',
  issuer_target_encoding: 'Historical recovery rate for this bank/issuer',
  source_target_encoding: 'Historical recovery rate for this loss channel',
  customer_success_log: 'Successful payments by this customer',
  customer_failure_log: 'Failed payments by this customer',
  customer_success_ratio: 'Lifetime payment success ratio',
  prior_recovery_rate: 'Past recovery success rate for this customer',
  prior_recovery_experience: 'Number of past recovery attempts',
  hours_since_failure_log: 'Time elapsed since the loss event',
  days_since_success_norm: 'Days since the last successful payment',
  has_prior_success: 'Customer has ever paid successfully',
  subscription_age_norm: 'Subscription tenure',
  is_subscription: 'Recurring-revenue relationship',
  attempt_number: 'Attempts already made on this case',
  has_alternate_method: 'A working alternate instrument exists',
  lifetime_value_log: 'Customer lifetime value',
  self_resolving: 'Blocker clears without customer action',
  customer_action_required: 'Customer must act for recovery',
  business_hours: 'Failure occurred in business hours',
  bank_downtime_cluster: 'Part of a bank-downtime cluster',
  prior_x_success_ratio: 'Recoverable failure class on a reliable customer',
  prior_x_log_amount: 'Failure-class recoverability against transaction size',
};

/**
 * Smoothed target encoding. Categories with few observations are pulled toward the global
 * base rate, which stops a single lucky issuer from dominating the model.
 */
export interface TargetEncoding {
  globalMean: number;
  smoothing: number;
  values: Record<string, { sum: number; count: number }>;
}

export function createTargetEncoding(smoothing = 25): TargetEncoding {
  return { globalMean: 0, smoothing, values: {} };
}

export function fitTargetEncoding(
  keys: readonly string[],
  labels: readonly number[],
  smoothing = 25,
): TargetEncoding {
  const encoding = createTargetEncoding(smoothing);
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const label = labels[i]!;
    const bucket = (encoding.values[key] ??= { sum: 0, count: 0 });
    bucket.sum += label;
    bucket.count += 1;
    total += label;
  }
  encoding.globalMean = keys.length > 0 ? total / keys.length : 0.5;
  return encoding;
}

export function encodeTarget(encoding: TargetEncoding, key: string): number {
  const bucket = encoding.values[key];
  if (!bucket) return encoding.globalMean;
  return (bucket.sum + encoding.globalMean * encoding.smoothing) / (bucket.count + encoding.smoothing);
}

export interface FeatureEncoders {
  profile: TargetEncoding;
  method: TargetEncoding;
  segment: TargetEncoding;
  issuer: TargetEncoding;
  source: TargetEncoding;
}

/** Fit all categorical encoders on the training split only — never on test data. */
export function fitEncoders(
  rows: readonly RecoveryFeatureInput[],
  labels: readonly number[],
): FeatureEncoders {
  return {
    profile: fitTargetEncoding(rows.map((r) => r.profileKey), labels, 30),
    method: fitTargetEncoding(rows.map((r) => r.method), labels, 40),
    segment: fitTargetEncoding(rows.map((r) => r.segment), labels, 40),
    issuer: fitTargetEncoding(rows.map((r) => r.issuer), labels, 25),
    source: fitTargetEncoding(rows.map((r) => r.sourceType), labels, 40),
  };
}

const log1p = (v: number): number => Math.log1p(Math.max(0, v));

/** Project a feature input into the fixed-order numeric vector the model consumes. */
export function vectorize(input: RecoveryFeatureInput, encoders: FeatureEncoders): number[] {
  const successRatio =
    (input.customerSuccessCount + 1) / (input.customerSuccessCount + input.customerFailureCount + 2);
  const priorRecoveryRate =
    (input.priorRecoverySuccesses + 1.5) / (input.priorRecoveryAttempts + 3);

  return [
    log1p(input.amountMinor / 100) / 12,
    input.baseRecoverability,
    encodeTarget(encoders.profile, input.profileKey),
    encodeTarget(encoders.method, input.method),
    encodeTarget(encoders.segment, input.segment),
    encodeTarget(encoders.issuer, input.issuer),
    encodeTarget(encoders.source, input.sourceType),
    log1p(input.customerSuccessCount) / 4,
    log1p(input.customerFailureCount) / 3,
    successRatio,
    priorRecoveryRate,
    log1p(input.priorRecoveryAttempts) / 3,
    log1p(Math.max(0, input.hoursSinceFailure)) / 6,
    input.daysSinceLastSuccess === null ? 1 : clamp(input.daysSinceLastSuccess, 0, 365) / 365,
    input.daysSinceLastSuccess === null ? 0 : 1,
    input.subscriptionAgeDays === null ? 0 : clamp(input.subscriptionAgeDays, 0, 730) / 730,
    input.isSubscription ? 1 : 0,
    clamp(input.attemptNumber, 0, 6) / 6,
    input.hasAlternateSuccessfulMethod ? 1 : 0,
    log1p(input.customerLifetimeValueMinor / 100) / 14,
    input.selfResolving ? 1 : 0,
    input.customerActionRequired ? 1 : 0,
    input.isBusinessHours ? 1 : 0,
    input.bankDowntimeCluster ? 1 : 0,
    input.baseRecoverability * successRatio,
    input.baseRecoverability * (log1p(input.amountMinor / 100) / 12),
  ];
}

/** Feature-wise mean/std used to standardise inputs before gradient descent. */
export interface Scaler {
  mean: number[];
  std: number[];
}

export function fitScaler(matrix: readonly number[][]): Scaler {
  const n = matrix.length;
  const d = FEATURE_COUNT;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  if (n === 0) return { mean, std: std.map(() => 1) };

  for (const row of matrix) for (let j = 0; j < d; j++) mean[j]! += row[j]! / n;
  for (const row of matrix) for (let j = 0; j < d; j++) std[j]! += (row[j]! - mean[j]!) ** 2 / n;
  return { mean, std: std.map((v) => Math.max(Math.sqrt(v), 1e-6)) };
}

export function applyScaler(vector: readonly number[], scaler: Scaler): number[] {
  const out = new Array<number>(vector.length);
  for (let j = 0; j < vector.length; j++) out[j] = (vector[j]! - scaler.mean[j]!) / scaler.std[j]!;
  return out;
}
