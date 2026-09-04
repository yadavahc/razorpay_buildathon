import { z } from 'zod';

/** Payment instruments supported by the merchant, mirroring Razorpay's method taxonomy. */
export const PAYMENT_METHODS = ['card', 'upi', 'netbanking', 'wallet', 'emi', 'nach'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const PAYMENT_STATUSES = [
  'created',
  'authorized',
  'captured',
  'failed',
  'refunded',
] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const PAYMENT_SOURCES = ['checkout', 'subscription', 'invoice', 'recovery'] as const;
export const paymentSourceSchema = z.enum(PAYMENT_SOURCES);
export type PaymentSource = z.infer<typeof paymentSourceSchema>;

/**
 * Failure taxonomy. Each code carries an intrinsic recoverability profile that the
 * diagnosis engine, the strategy engine and the synthetic data generator all share,
 * so the explanations shown in the UI describe the same world the model was trained on.
 */
export const FAILURE_REASONS = [
  'insufficient_funds',
  'card_expired',
  'do_not_honour',
  'incorrect_cvv',
  'payment_timeout',
  'gateway_error',
  'bank_downtime',
  'risk_declined_by_bank',
  'international_not_allowed',
  'mandate_revoked',
  'upi_collect_expired',
  'daily_limit_exceeded',
  'authentication_failed',
  'card_blocked',
  'network_error',
  'invalid_account',
  'wallet_insufficient_balance',
] as const;
export const failureReasonSchema = z.enum(FAILURE_REASONS);
export type FailureReason = z.infer<typeof failureReasonSchema>;

export const CUSTOMER_SEGMENTS = ['enterprise', 'growth', 'smb', 'consumer', 'trial'] as const;
export const customerSegmentSchema = z.enum(CUSTOMER_SEGMENTS);
export type CustomerSegment = z.infer<typeof customerSegmentSchema>;

export const SUBSCRIPTION_STATUSES = [
  'active',
  'past_due',
  'paused',
  'cancelled',
  'completed',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const INVOICE_STATUSES = ['open', 'paid', 'overdue', 'written_off'] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

/** The four revenue-loss event families RECLAIM detects. */
export const CASE_SOURCE_TYPES = [
  'payment_failure',
  'checkout_abandonment',
  'subscription_dunning',
  'overdue_invoice',
] as const;
export const caseSourceTypeSchema = z.enum(CASE_SOURCE_TYPES);
export type CaseSourceType = z.infer<typeof caseSourceTypeSchema>;

export const CASE_STATUSES = [
  'detected',
  'investigating',
  'awaiting_action',
  'in_progress',
  'recovered',
  'escalated',
  'stopped',
  'unrecoverable',
] as const;
export const caseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = [
  'recovered',
  'stopped',
  'unrecoverable',
];

/** The bounded strategy space the decisioning engine is allowed to choose from. */
export const RECOVERY_STRATEGIES = [
  'immediate_retry',
  'delayed_retry',
  'payment_link',
  'customer_notification',
  'escalate',
  'stop_recovery',
] as const;
export const recoveryStrategySchema = z.enum(RECOVERY_STRATEGIES);
export type RecoveryStrategy = z.infer<typeof recoveryStrategySchema>;

export const ACTION_STATUSES = [
  'pending',
  'blocked',
  'executing',
  'succeeded',
  'failed',
  'fell_back',
  'skipped_duplicate',
] as const;
export const actionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const OUTCOME_KINDS = [
  'recovered',
  'action_failed',
  'no_response',
  'awaiting_customer',
  'escalated_to_human',
  'stopped',
] as const;
export const outcomeKindSchema = z.enum(OUTCOME_KINDS);
export type OutcomeKind = z.infer<typeof outcomeKindSchema>;

export const POLICY_VERDICTS = ['allow', 'deny', 'require_human'] as const;
export const policyVerdictSchema = z.enum(POLICY_VERDICTS);
export type PolicyVerdict = z.infer<typeof policyVerdictSchema>;

export const NOTIFICATION_CHANNELS = ['email', 'sms', 'whatsapp', 'in_app'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const FAULT_KINDS = [
  'payment_timeout',
  'duplicate_request',
  'gateway_failure',
  'invalid_transaction',
  'policy_violation',
  'ai_unavailable',
  'external_api_failure',
] as const;
export const faultKindSchema = z.enum(FAULT_KINDS);
export type FaultKind = z.infer<typeof faultKindSchema>;

export const RUN_MODES = ['demo', 'razorpay_test'] as const;
export const runModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof runModeSchema>;
