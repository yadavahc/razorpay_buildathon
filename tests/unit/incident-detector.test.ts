import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUPPRESSION,
  detectIncidents,
  isSuppressed,
  type Payment,
} from '@reclaim/core';

const NOW = '2026-09-04T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

let seq = 0;
function payment(overrides: Partial<Payment> & { minutesAgo: number }): Payment {
  const { minutesAgo, ...rest } = overrides;
  seq += 1;
  return {
    id: `pay_${seq}`,
    merchantId: 'm1',
    customerId: `cust_${seq % 400}`,
    amountMinor: 100_000,
    currency: 'INR',
    method: 'card',
    issuer: 'HDFC Bank',
    network: 'visa',
    status: 'captured',
    source: 'checkout',
    failureReason: null,
    errorCode: null,
    createdAt: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
    capturedAt: null,
    subscriptionId: null,
    invoiceId: null,
    recoveryCaseId: null,
    idempotencyKey: `idem_${seq}`,
    providerRef: null,
    ...rest,
  } as Payment;
}

/** A steady, healthy trailing history for one issuer at a given background failure rate. */
function baseline(issuer: string, total: number, failureRate: number): Payment[] {
  const out: Payment[] = [];
  for (let i = 0; i < total; i++) {
    const failed = i < Math.round(total * failureRate);
    out.push(
      payment({
        // 90 minutes to 70 hours ago: outside the 60-minute detection window.
        minutesAgo: 90 + (i % 4_000),
        issuer,
        status: failed ? 'failed' : 'captured',
        failureReason: failed ? 'do_not_honour' : null,
      }),
    );
  }
  return out;
}

describe('incident detector — separates an outage from ordinary noise', () => {
  it('fires when an issuer fails far above its own baseline', () => {
    const payments = [
      ...baseline('HDFC Bank', 400, 0.05),
      // The outage: 40 of 44 recent HDFC payments fail.
      ...Array.from({ length: 40 }, (_, i) =>
        payment({
          minutesAgo: 5 + (i % 30),
          issuer: 'HDFC Bank',
          status: 'failed',
          failureReason: 'bank_downtime',
        }),
      ),
      ...Array.from({ length: 4 }, () =>
        payment({ minutesAgo: 10, issuer: 'HDFC Bank', status: 'captured' }),
      ),
    ];

    const report = detectIncidents({ payments, nowIso: NOW });
    const incident = report.incidents.find(
      (i) => i.dimension === 'issuer' && i.value === 'HDFC Bank',
    );

    expect(incident).toBeDefined();
    expect(incident!.windowFailures).toBe(40);
    expect(incident!.rateRatio).toBeGreaterThan(3);
    expect(incident!.zScore).toBeGreaterThan(3);
    expect(incident!.severity).toBe('critical');
    expect(incident!.suppressRetries).toBe(true);
    expect(incident!.dominantFailureReason).toBe('bank_downtime');
    expect(report.suppressed.issuers).toContain('HDFC Bank');
  });

  it('does NOT fire on a busy issuer whose failure rate is merely normal', () => {
    // This is the trap a raw count threshold falls into: 30 recent failures looks alarming
    // until you notice this issuer always fails at that rate, at ten times the volume.
    const payments = [
      ...baseline('SBI', 4_000, 0.3),
      ...Array.from({ length: 30 }, (_, i) =>
        payment({
          minutesAgo: 5 + (i % 40),
          issuer: 'SBI',
          status: 'failed',
          failureReason: 'do_not_honour',
        }),
      ),
      ...Array.from({ length: 70 }, () =>
        payment({ minutesAgo: 20, issuer: 'SBI', status: 'captured' }),
      ),
    ];

    const report = detectIncidents({ payments, nowIso: NOW });
    expect(report.incidents.find((i) => i.value === 'SBI')).toBeUndefined();
    expect(report.suppressed.issuers).not.toContain('SBI');
  });

  it('refuses to call an incident on too few failures, however extreme the ratio', () => {
    // Three failures against a spotless baseline is an infinite rate ratio and still noise.
    const payments = [
      ...baseline('Axis', 300, 0.0),
      ...Array.from({ length: 3 }, () =>
        payment({
          minutesAgo: 5,
          issuer: 'Axis',
          status: 'failed',
          failureReason: 'gateway_error',
        }),
      ),
    ];

    const report = detectIncidents({ payments, nowIso: NOW });
    expect(report.incidents.find((i) => i.value === 'Axis')).toBeUndefined();
  });

  it('refuses to judge against a baseline it has barely seen', () => {
    const payments = [
      ...baseline('NewBank', 10, 0.0),
      ...Array.from({ length: 20 }, () =>
        payment({
          minutesAgo: 5,
          issuer: 'NewBank',
          status: 'failed',
          failureReason: 'bank_downtime',
        }),
      ),
    ];

    const report = detectIncidents({ payments, nowIso: NOW });
    expect(report.incidents.find((i) => i.value === 'NewBank')).toBeUndefined();
  });

  it('excludes the detection window from the baseline it compares against', () => {
    // If the window bled into the baseline, a large enough outage would raise its own
    // yardstick and hide itself. The bigger the incident, the worse that failure gets.
    const payments = [
      ...baseline('ICICI', 200, 0.05),
      ...Array.from({ length: 150 }, (_, i) =>
        payment({
          minutesAgo: 1 + (i % 50),
          issuer: 'ICICI',
          status: 'failed',
          failureReason: 'bank_downtime',
        }),
      ),
    ];

    const report = detectIncidents({ payments, nowIso: NOW });
    const incident = report.incidents.find((i) => i.value === 'ICICI');
    expect(incident).toBeDefined();
    expect(incident!.baselineFailureRate).toBeCloseTo(0.05, 2);
    expect(incident!.baselineSample).toBe(200);
  });

  it('reports impact in customers and money, not just counts', () => {
    const payments = [
      ...baseline('Kotak', 400, 0.05),
      ...Array.from({ length: 30 }, (_, i) =>
        payment({
          minutesAgo: 5 + (i % 30),
          issuer: 'Kotak',
          customerId: `victim_${i}`,
          amountMinor: 250_000,
          status: 'failed',
          failureReason: 'bank_downtime',
        }),
      ),
    ];

    const report = detectIncidents({ payments, nowIso: NOW });
    const incident = report.incidents.find((i) => i.value === 'Kotak')!;
    expect(incident.affectedCustomers).toBe(30);
    expect(incident.exposureMinor).toBe(30 * 250_000);
    expect(incident.summary).toContain('Kotak');
  });

  it('produces nothing at all from an empty portfolio', () => {
    const report = detectIncidents({ payments: [], nowIso: NOW });
    expect(report.incidents).toHaveLength(0);
    expect(report.suppressed).toEqual(EMPTY_SUPPRESSION);
    expect(report.sampleSize).toBe(0);
  });
});

describe('incident detector — suppression lookup', () => {
  it('matches on each dimension independently', () => {
    const set = { issuers: ['HDFC Bank'], methods: ['upi'], failureReasons: ['bank_downtime'] };
    expect(isSuppressed(set, { issuer: 'HDFC Bank' }).dimension).toBe('issuer');
    expect(isSuppressed(set, { method: 'upi' }).dimension).toBe('method');
    expect(isSuppressed(set, { failureReason: 'bank_downtime' }).dimension).toBe('failure_reason');
  });

  it('permits everything when no incident data is available', () => {
    // The failure mode that matters: a detector that never ran must not halt recovery.
    const result = isSuppressed(EMPTY_SUPPRESSION, {
      issuer: 'HDFC Bank',
      method: 'card',
      failureReason: 'bank_downtime',
    });
    expect(result.suppressed).toBe(false);
  });

  it('ignores absent fields rather than matching on null', () => {
    const set = { issuers: ['HDFC Bank'], methods: [], failureReasons: [] };
    expect(isSuppressed(set, { issuer: null, method: null }).suppressed).toBe(false);
  });
});
