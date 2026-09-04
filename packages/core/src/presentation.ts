/**
 * The presentation vocabulary.
 *
 * Client components import this rather than the full domain barrel: it carries the money
 * formatters, the human labels for every enum, and the semantic tone each state should be
 * rendered in — and nothing that would drag services, agents or providers into the browser
 * bundle.
 *
 * Labels live here rather than in the UI so that a failure reason reads identically in a
 * chart axis, a case timeline, a copilot answer and a CSV export.
 */

import { FAILURE_PROFILES } from './domain/failure-taxonomy.js';
import { INTERVENTION_COSTS } from './domain/intervention-economics.js';
import type {
  ActionStatus,
  CaseSourceType,
  CaseStatus,
  CustomerSegment,
  FailureReason,
  OutcomeKind,
  PaymentMethod,
  PolicyVerdict,
  RecoveryStrategy,
} from './types/enums.js';

export { formatMinor, formatMinorCompact, toMajor, fromMajor } from './types/money.js';
export { formatDuration } from './util/time.js';

/** How a piece of state should read: colour is meaning, never decoration. */
export type Tone = 'positive' | 'negative' | 'warning' | 'neutral' | 'accent';

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  detected: 'Detected',
  investigating: 'Investigating',
  awaiting_action: 'Awaiting action',
  in_progress: 'In progress',
  recovered: 'Recovered',
  escalated: 'Escalated',
  stopped: 'Stopped',
  unrecoverable: 'Unrecoverable',
};

export const CASE_STATUS_TONES: Record<CaseStatus, Tone> = {
  detected: 'warning',
  investigating: 'neutral',
  awaiting_action: 'warning',
  in_progress: 'accent',
  recovered: 'positive',
  escalated: 'warning',
  stopped: 'neutral',
  unrecoverable: 'negative',
};

export const CASE_SOURCE_LABELS: Record<CaseSourceType, string> = {
  payment_failure: 'Payment failure',
  checkout_abandonment: 'Checkout abandonment',
  subscription_dunning: 'Subscription dunning',
  overdue_invoice: 'Overdue invoice',
};

export const CASE_SOURCE_DESCRIPTIONS: Record<CaseSourceType, string> = {
  payment_failure: 'A one-off charge was declined by the bank or gateway.',
  checkout_abandonment: 'The customer left before authorising the payment.',
  subscription_dunning: 'A recurring renewal failed, putting the relationship at risk.',
  overdue_invoice: 'A receivable has passed its due date.',
};

export const STRATEGY_LABELS: Record<RecoveryStrategy, string> = {
  immediate_retry: 'Immediate retry',
  delayed_retry: 'Delayed retry',
  payment_link: 'Payment link',
  customer_notification: 'Customer notification',
  escalate: 'Human escalation',
  stop_recovery: 'Stop recovery',
};

export const STRATEGY_DESCRIPTIONS: Record<RecoveryStrategy, string> = Object.fromEntries(
  Object.entries(INTERVENTION_COSTS).map(([key, value]) => [key, value.description]),
) as Record<RecoveryStrategy, string>;

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  pending: 'Pending',
  blocked: 'Blocked by policy',
  executing: 'Executing',
  succeeded: 'Succeeded',
  failed: 'Failed',
  fell_back: 'Fell back',
  skipped_duplicate: 'Duplicate suppressed',
};

export const ACTION_STATUS_TONES: Record<ActionStatus, Tone> = {
  pending: 'neutral',
  blocked: 'warning',
  executing: 'accent',
  succeeded: 'positive',
  failed: 'negative',
  fell_back: 'warning',
  skipped_duplicate: 'neutral',
};

export const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  recovered: 'Recovered',
  action_failed: 'Action failed',
  no_response: 'No response',
  awaiting_customer: 'Awaiting customer',
  escalated_to_human: 'Escalated to human',
  stopped: 'Stopped',
};

export const OUTCOME_TONES: Record<OutcomeKind, Tone> = {
  recovered: 'positive',
  action_failed: 'negative',
  no_response: 'neutral',
  awaiting_customer: 'accent',
  escalated_to_human: 'warning',
  stopped: 'neutral',
};

export const VERDICT_LABELS: Record<PolicyVerdict, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  require_human: 'Human approval required',
};

export const VERDICT_TONES: Record<PolicyVerdict, Tone> = {
  allow: 'positive',
  deny: 'negative',
  require_human: 'warning',
};

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  card: 'Card',
  upi: 'UPI',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
  nach: 'NACH',
};

export const SEGMENT_LABELS: Record<CustomerSegment, string> = {
  enterprise: 'Enterprise',
  growth: 'Growth',
  smb: 'SMB',
  consumer: 'Consumer',
  trial: 'Trial',
};

export function failureLabel(reason: FailureReason | null): string {
  return reason ? FAILURE_PROFILES[reason].label : 'No bank error code';
}

export function failureCategory(reason: FailureReason | null): string {
  return reason ? FAILURE_PROFILES[reason].category : 'customer_intent';
}

/** Machine reason codes rendered for humans, with the guardrail they came from. */
export const POLICY_REASON_LABELS: Record<string, string> = {
  CASE_TERMINAL: 'Case already closed',
  RETRY_STRUCTURALLY_IMPOSSIBLE: 'Retry cannot work for this failure',
  MANDATE_INACTIVE: 'Mandate revoked',
  CUSTOMER_OPTED_OUT: 'Customer opted out of contact',
  CUSTOMER_DO_NOT_RETRY: 'Customer flagged do-not-retry',
  CHARGEBACK_RISK: 'Chargeback history above tolerance',
  NO_CONTACT_CHANNEL: 'No deliverable contact channel',
  MAX_RETRIES_EXCEEDED: 'Retry budget exhausted',
  CONTACT_CAP_EXCEEDED: 'Daily contact cap reached',
  COOLDOWN_ACTIVE: 'Cooldown still active',
  QUIET_HOURS: 'Customer local quiet hours',
  SYSTEMIC_INCIDENT_ACTIVE: 'Systemic incident on this route',
  EXPECTED_VALUE_TOO_LOW: 'Expected value below the floor',
  CASE_BUDGET_EXHAUSTED: 'Case intervention budget spent',
  DUPLICATE_ACTION: 'Duplicate action suppressed',
  ABOVE_AUTO_EXECUTE_CEILING: 'Above the automated ceiling',
  HIGH_VALUE_LOW_CONFIDENCE: 'High value, low confidence',
  INJECTED_POLICY_VIOLATION: 'Injected policy violation (failure lab)',
};

export function policyReasonLabel(code: string): string {
  return POLICY_REASON_LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

/** Percentage with a fixed precision; used everywhere a rate is shown. */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatSignedPercent(value: number, decimals = 1): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(decimals)}%`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-IN');
}

/** Relative time, coarse on purpose: "3h ago" is more useful here than a timestamp. */
export function formatRelative(iso: string, nowMs: number = Date.now()): string {
  const deltaMs = nowMs - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return '—';
  const seconds = Math.round(deltaMs / 1000);
  if (Math.abs(seconds) < 60) return seconds <= 0 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 60) return `${days}d ago`;
  return new Date(Date.parse(iso)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function titleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
