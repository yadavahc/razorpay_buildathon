/**
 * INCIDENT SERVICE
 *
 * Holds the current systemic-incident picture so the policy engine can consult it without
 * becoming asynchronous.
 *
 * The split matters. Detection is a scan over recent payments — inherently async and
 * moderately expensive. Authorisation is a pure synchronous function that must return the
 * same verdict for the same inputs, forever, and must never depend on whether a network
 * call happened to succeed. So detection runs on its own cadence and *publishes* a small
 * immutable snapshot; the policy engine is handed that snapshot as an input.
 *
 * The failure mode is deliberately permissive: if detection has never run, or its data is
 * stale, `current()` returns an empty suppression set and recovery proceeds normally. A
 * broken detector must not be able to halt every retry in the system — that would turn a
 * monitoring outage into a revenue outage.
 */

import {
  EMPTY_SUPPRESSION,
  detectIncidents,
  type Incident,
  type IncidentDetectorOptions,
  type IncidentReport,
  type SuppressionSet,
} from '../analytics/incident-detector.js';
import type { DataStore } from '../store/types.js';

/**
 * How long a published snapshot is allowed to steer authorisation. An issuer that came
 * back up five minutes ago should not still be holding the queue, and a detector that
 * silently stopped running must not keep suppressing forever.
 */
const SNAPSHOT_TTL_MS = 5 * 60_000;

export class IncidentService {
  private snapshot: { report: IncidentReport; at: number } | null = null;

  constructor(
    private readonly store: DataStore,
    private readonly options: IncidentDetectorOptions = {},
  ) {}

  /** Rescan recent payments and publish a new snapshot. */
  async refresh(merchantId: string, nowIso = new Date().toISOString()): Promise<IncidentReport> {
    const payments = await this.store.payments.list({
      where: [{ field: 'merchantId', op: '==', value: merchantId }],
    });
    const report = detectIncidents({ payments, nowIso, options: this.options });
    this.snapshot = { report, at: Date.now() };
    return report;
  }

  /** The last published report, or null when detection has not run recently. */
  report(): IncidentReport | null {
    if (!this.snapshot) return null;
    if (Date.now() - this.snapshot.at > SNAPSHOT_TTL_MS) return null;
    return this.snapshot.report;
  }

  /**
   * Synchronous read for the authorisation path. Empty when no fresh snapshot exists,
   * which lets recovery continue rather than blocking it on a stale detector.
   */
  current(): SuppressionSet {
    return this.report()?.suppressed ?? EMPTY_SUPPRESSION;
  }

  /** Incidents currently severe enough to hold retries. */
  active(): Incident[] {
    return (this.report()?.incidents ?? []).filter((incident) => incident.suppressRetries);
  }

  /** Drop the snapshot so the next read reflects a rescan. */
  invalidate(): void {
    this.snapshot = null;
  }
}
