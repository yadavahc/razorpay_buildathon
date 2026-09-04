/**
 * SYSTEMIC INCIDENT DETECTION
 *
 * Every recovery decision in this system is, until now, made about one payment in
 * isolation. That is the right unit for a wrong CVV. It is exactly the wrong unit for an
 * issuer outage.
 *
 * When a bank goes down, hundreds of unrelated customers fail within minutes for reasons
 * that have nothing to do with them. Case-by-case logic sees hundreds of independent
 * problems and does the locally sensible thing to each: retry. Every one of those retries
 * fails, because the bank is still down. The cost is not just the wasted attempt — it is
 * the retry budget burned, the customers messaged about a problem that was never theirs,
 * and the fatigue spent right before the window when a retry would actually have worked.
 *
 * This module changes the unit of decision from a payment to a population. It answers two
 * questions:
 *
 *   1. Is this failure part of something bigger?
 *   2. If so, what is the correct thing to do to the whole cohort at once?
 *
 * The answer to (2) is almost always "wait, then go together" — suppress retries into the
 * affected dimension while the incident is live, hold the cases, and release them as a
 * single coordinated wave when the dimension recovers.
 *
 * DETECTION IS STATISTICAL, NOT A THRESHOLD ON A COUNT. A busy issuer fails more often
 * than a quiet one at all times, so a raw count fires constantly on the big banks and
 * never on the small ones. We compare each dimension's failure rate in a recent window
 * against its own trailing baseline and score the deviation, so "unusual for this issuer"
 * is what triggers, not "large".
 */

import type { Payment } from '../types/entities.js';
import type { FailureReason } from '../types/enums.js';

/** The axes along which a systemic failure can present. */
export type IncidentDimension = 'issuer' | 'method' | 'failure_reason';

export type IncidentSeverity = 'watch' | 'elevated' | 'critical';

export interface Incident {
  id: string;
  dimension: IncidentDimension;
  /** The specific issuer / method / reason this incident is about. */
  value: string;
  severity: IncidentSeverity;

  // ---- measured -----------------------------------------------------------------
  /** Failures for this value inside the detection window. */
  windowFailures: number;
  windowTotal: number;
  windowFailureRate: number;
  /** The same value's failure rate over the trailing baseline period. */
  baselineFailureRate: number;
  baselineSample: number;
  /** windowFailureRate / baselineFailureRate. The headline "up 340%" number. */
  rateRatio: number;
  /**
   * How many standard deviations the observed failure count sits above what the baseline
   * predicts, under a binomial model. This is what separates a real outage from a quiet
   * issuer having an unlucky afternoon.
   */
  zScore: number;

  // ---- impact -------------------------------------------------------------------
  affectedCustomers: number;
  exposureMinor: number;
  dominantFailureReason: FailureReason | null;
  startedAt: string;
  lastSeenAt: string;

  /** Retries into this dimension are suppressed while true. */
  suppressRetries: boolean;
  /** Plain-language statement of what was measured. Never model-generated. */
  summary: string;
}

export interface IncidentReport {
  incidents: Incident[];
  /** Dimension values with retries currently suppressed, for the policy engine to consult. */
  suppressed: SuppressionSet;
  windowMinutes: number;
  baselineHours: number;
  evaluatedAt: string;
  /** Payments considered. A small number here makes every incident below unreliable. */
  sampleSize: number;
}

/**
 * The suppression set is deliberately a plain data structure rather than a live service
 * call: the policy engine must stay a pure, synchronous, deterministic function, so it is
 * handed the answer rather than allowed to go looking for it.
 */
export interface SuppressionSet {
  issuers: string[];
  methods: string[];
  failureReasons: string[];
}

export const EMPTY_SUPPRESSION: SuppressionSet = {
  issuers: [],
  methods: [],
  failureReasons: [],
};

export interface IncidentDetectorOptions {
  /** How recent a failure must be to count toward the live signal. */
  windowMinutes?: number;
  /** How far back the "normal for this dimension" rate is measured. */
  baselineHours?: number;
  /**
   * Minimum failures in-window before a dimension can be called an incident at all. Two
   * failures can be a 10x rate ratio and still mean nothing.
   */
  minWindowFailures?: number;
  /** Minimum baseline observations before that baseline is trustworthy. */
  minBaselineSample?: number;
  /** Deviation required to escalate past a watch. */
  zScoreThreshold?: number;
}

const DEFAULTS = {
  windowMinutes: 60,
  // Two weeks, not three days. Per-issuer failure rates are the whole point of this
  // detector, and a single issuer only accumulates enough observations to have a
  // trustworthy rate over a reasonably long window -- a 72h baseline leaves every issuer
  // below minBaselineSample and silently disables the issuer axis entirely. A longer
  // baseline is also the more stable one: it averages over the weekly volume cycle rather
  // than sitting inside it.
  baselineHours: 24 * 14,
  minWindowFailures: 8,
  minBaselineSample: 50,
  zScoreThreshold: 3,
} as const;

export interface DetectIncidentsInput {
  payments: readonly Payment[];
  nowIso: string;
  options?: IncidentDetectorOptions;
}

export function detectIncidents(input: DetectIncidentsInput): IncidentReport {
  const opts = { ...DEFAULTS, ...input.options };
  const now = Date.parse(input.nowIso);
  const windowStart = now - opts.windowMinutes * 60_000;
  const baselineStart = now - opts.baselineHours * 3_600_000;

  const inWindow: Payment[] = [];
  const inBaseline: Payment[] = [];
  for (const payment of input.payments) {
    const at = Date.parse(payment.createdAt);
    if (Number.isNaN(at) || at > now) continue;
    if (at >= windowStart) inWindow.push(payment);
    // The baseline deliberately excludes the detection window. Including it would blend
    // the anomaly into the very number the anomaly is measured against, which suppresses
    // exactly the large incidents we most need to catch.
    else if (at >= baselineStart) inBaseline.push(payment);
  }

  const incidents: Incident[] = [];
  for (const dimension of ['issuer', 'method', 'failure_reason'] as const) {
    incidents.push(...detectForDimension(dimension, inWindow, inBaseline, opts, input.nowIso));
  }

  incidents.sort((a, b) => b.zScore - a.zScore);

  const suppressed: SuppressionSet = { issuers: [], methods: [], failureReasons: [] };
  for (const incident of incidents) {
    if (!incident.suppressRetries) continue;
    if (incident.dimension === 'issuer') suppressed.issuers.push(incident.value);
    else if (incident.dimension === 'method') suppressed.methods.push(incident.value);
    else suppressed.failureReasons.push(incident.value);
  }

  return {
    incidents,
    suppressed,
    windowMinutes: opts.windowMinutes,
    baselineHours: opts.baselineHours,
    evaluatedAt: input.nowIso,
    sampleSize: inWindow.length + inBaseline.length,
  };
}

function keyOf(payment: Payment, dimension: IncidentDimension): string | null {
  if (dimension === 'issuer') return payment.issuer || null;
  if (dimension === 'method') return payment.method || null;
  return payment.failureReason;
}

function detectForDimension(
  dimension: IncidentDimension,
  inWindow: readonly Payment[],
  inBaseline: readonly Payment[],
  opts: Required<IncidentDetectorOptions>,
  nowIso: string,
): Incident[] {
  // For the failure-reason axis the denominator is all failures rather than all payments:
  // "what share of failures are bank_downtime" is the meaningful rate, whereas
  // "what share of all payments" just tracks the overall failure rate.
  const isReasonAxis = dimension === 'failure_reason';
  const windowPool = isReasonAxis ? inWindow.filter((p) => p.status === 'failed') : inWindow;
  const baselinePool = isReasonAxis ? inBaseline.filter((p) => p.status === 'failed') : inBaseline;

  const windowByKey = new Map<string, Payment[]>();
  for (const payment of windowPool) {
    const key = keyOf(payment, dimension);
    if (!key) continue;
    const list = windowByKey.get(key);
    if (list) list.push(payment);
    else windowByKey.set(key, [payment]);
  }

  const baselineByKey = new Map<string, { failures: number; total: number }>();
  for (const payment of baselinePool) {
    const key = keyOf(payment, dimension);
    if (!key) continue;
    const stats = baselineByKey.get(key) ?? { failures: 0, total: 0 };
    stats.total += 1;
    if (isReasonAxis || payment.status === 'failed') stats.failures += 1;
    baselineByKey.set(key, stats);
  }

  const incidents: Incident[] = [];

  for (const [value, payments] of windowByKey) {
    const failures = isReasonAxis ? payments : payments.filter((p) => p.status === 'failed');
    if (failures.length < opts.minWindowFailures) continue;

    const baseline = baselineByKey.get(value);
    if (!baseline || baseline.total < opts.minBaselineSample) continue;

    const windowTotal = isReasonAxis ? windowPool.length : payments.length;
    if (windowTotal === 0) continue;

    const windowFailureRate = failures.length / windowTotal;
    const baselineFailureRate = baseline.failures / baseline.total;

    // A dimension that never fails has no meaningful ratio; guard the division and let the
    // z-score carry the signal instead.
    const rateRatio =
      baselineFailureRate > 0 ? windowFailureRate / baselineFailureRate : windowFailureRate > 0 ? Infinity : 0;

    // Binomial deviation: how surprising is this many failures out of this many attempts,
    // if the baseline rate were still true?
    const expected = baselineFailureRate * windowTotal;
    const variance = windowTotal * baselineFailureRate * (1 - baselineFailureRate);
    const zScore = variance > 0 ? (failures.length - expected) / Math.sqrt(variance) : 0;

    if (zScore < opts.zScoreThreshold) continue;

    const severity: IncidentSeverity =
      zScore >= opts.zScoreThreshold * 3 && rateRatio >= 3
        ? 'critical'
        : zScore >= opts.zScoreThreshold * 1.8
          ? 'elevated'
          : 'watch';

    const times = failures.map((p) => Date.parse(p.createdAt)).sort((a, b) => a - b);
    const dominantFailureReason = modeOf(
      failures.map((p) => p.failureReason).filter((r): r is FailureReason => r !== null),
    );

    incidents.push({
      id: `inc_${dimension}_${slug(value)}`,
      dimension,
      value,
      severity,
      windowFailures: failures.length,
      windowTotal,
      windowFailureRate,
      baselineFailureRate,
      baselineSample: baseline.total,
      rateRatio,
      zScore,
      affectedCustomers: new Set(failures.map((p) => p.customerId)).size,
      exposureMinor: failures.reduce((sum, p) => sum + p.amountMinor, 0),
      dominantFailureReason,
      startedAt: new Date(times[0] ?? Date.parse(nowIso)).toISOString(),
      lastSeenAt: new Date(times[times.length - 1] ?? Date.parse(nowIso)).toISOString(),
      // Only a genuine outage justifies holding money back. A "watch" is information for
      // an operator, not a reason to stop trying to recover.
      suppressRetries: severity !== 'watch',
      summary: summarise(dimension, value, failures.length, rateRatio, zScore),
    });
  }

  return incidents;
}

function summarise(
  dimension: IncidentDimension,
  value: string,
  failures: number,
  rateRatio: number,
  zScore: number,
): string {
  const label =
    dimension === 'issuer' ? value : dimension === 'method' ? `${value} payments` : value.replace(/_/g, ' ');
  const ratio = Number.isFinite(rateRatio)
    ? `${(rateRatio * 100 - 100).toFixed(0)}% above its own baseline`
    : 'against a baseline of no failures at all';
  return `${failures} failures on ${label} in the detection window — ${ratio} (${zScore.toFixed(1)}σ).`;
}

function modeOf<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Would a retry on this payment be firing into a known-dead dimension?
 *
 * Pure and synchronous by design so the policy engine can call it without becoming async.
 */
export function isSuppressed(
  suppressed: SuppressionSet,
  target: { issuer?: string | null; method?: string | null; failureReason?: string | null },
): { suppressed: boolean; dimension: IncidentDimension | null; value: string | null } {
  if (target.issuer && suppressed.issuers.includes(target.issuer)) {
    return { suppressed: true, dimension: 'issuer', value: target.issuer };
  }
  if (target.method && suppressed.methods.includes(target.method)) {
    return { suppressed: true, dimension: 'method', value: target.method };
  }
  if (target.failureReason && suppressed.failureReasons.includes(target.failureReason)) {
    return { suppressed: true, dimension: 'failure_reason', value: target.failureReason };
  }
  return { suppressed: false, dimension: null, value: null };
}
