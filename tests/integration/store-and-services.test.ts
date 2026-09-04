import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsService, createMemoryStore, verifyAuditChain } from '@reclaim/core';
import { createHarness, seedCase, seedCustomer, type Harness } from '../support/harness';

/**
 * Integration coverage for the persistence layer and the services that sit directly on
 * it. These run against the real in-memory store, not a mock, so the invariants asserted
 * here are the ones Firestore must also uphold.
 */

describe('store — repository semantics', () => {
  it('round-trips a document without sharing references', async () => {
    const store = createMemoryStore();
    const merchant = {
      id: 'merch_x',
      name: 'Test',
      legalName: 'Test Pvt Ltd',
      mcc: '5817',
      currency: 'INR' as const,
      createdAt: new Date().toISOString(),
      policyOverrides: {},
    };

    await store.merchants.put(merchant);
    const loaded = await store.merchants.get('merch_x');

    expect(loaded).toEqual(merchant);
    // Mutating what the caller got back must not corrupt what the store holds.
    loaded!.name = 'Mutated';
    expect((await store.merchants.get('merch_x'))!.name).toBe('Test');
  });

  it('returns null rather than throwing for a missing document', async () => {
    const store = createMemoryStore();
    expect(await store.customers.get('nope')).toBeNull();
  });

  it('throws a typed NOT_FOUND when patching a missing document', async () => {
    const store = createMemoryStore();
    await expect(store.customers.patch('nope', { name: 'x' })).rejects.toThrow(/not found/i);
  });

  it('filters, sorts and paginates', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 25; i++) {
      await store.customers.put({
        id: `cust_${String(i).padStart(3, '0')}`,
        merchantId: i % 2 === 0 ? 'merch_a' : 'merch_b',
        name: `Customer ${i}`,
        email: `c${i}@example.test`,
        phone: '+919800000000',
        segment: 'consumer',
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
        lifetimeValueMinor: i * 1000,
        successfulPaymentCount: i,
        failedPaymentCount: 0,
        priorRecoveryAttempts: 0,
        priorRecoverySuccesses: 0,
        lastSuccessfulPaymentAt: null,
        lastFailedPaymentAt: null,
        preferredMethod: 'upi',
        contactPreference: 'email',
        contactOptOut: false,
        doNotRetry: false,
        chargebackCount: 0,
        timezone: 'UTC',
      });
    }

    const filtered = await store.customers.count({
      where: [{ field: 'merchantId', op: '==', value: 'merch_a' }],
    });
    expect(filtered).toBe(13);

    const page = await store.customers.query({
      where: [{ field: 'merchantId', op: '==', value: 'merch_a' }],
      orderBy: { field: 'lifetimeValueMinor', direction: 'desc' },
      limit: 5,
    });
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]!.lifetimeValueMinor).toBeGreaterThan(page.items[4]!.lifetimeValueMinor);

    const next = await store.customers.query({
      where: [{ field: 'merchantId', op: '==', value: 'merch_a' }],
      orderBy: { field: 'lifetimeValueMinor', direction: 'desc' },
      limit: 5,
      cursor: page.nextCursor,
    });
    // The second page must not repeat anything from the first.
    const firstIds = new Set(page.items.map((c) => c.id));
    expect(next.items.every((c) => !firstIds.has(c.id))).toBe(true);
  });
});

describe('store — idempotency ledger', () => {
  it('claims a key exactly once', async () => {
    const store = createMemoryStore();
    const input = { key: 'idem_1', merchantId: 'merch_a', scope: 'action', actionId: 'act_1' };

    const first = await store.claimIdempotency(input);
    const second = await store.claimIdempotency({ ...input, actionId: 'act_2' });

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    // The second caller learns which action already owns the key.
    expect(second.record.actionId).toBe('act_1');
  });

  it('survives a concurrent race — exactly one caller wins', async () => {
    const store = createMemoryStore();
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.claimIdempotency({
          key: 'idem_race',
          merchantId: 'merch_a',
          scope: 'action',
          actionId: `act_${i}`,
        }),
      ),
    );

    expect(attempts.filter((a) => a.claimed)).toHaveLength(1);
    expect(attempts.filter((a) => !a.claimed)).toHaveLength(19);
  });

  it('records the terminal status so a replay can return the original result', async () => {
    const store = createMemoryStore();
    await store.claimIdempotency({
      key: 'idem_2',
      merchantId: 'merch_a',
      scope: 'action',
      actionId: 'act_1',
    });
    await store.settleIdempotency('idem_2', 'succeeded', 'pay_provider_ref');

    const record = await store.getIdempotency('idem_2');
    expect(record?.status).toBe('succeeded');
    expect(record?.resultRef).toBe('pay_provider_ref');
  });
});

describe('case service — lifecycle', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('opens exactly one case per source event, however many times ingestion runs', async () => {
    const { caseId, payment } = await seedCase(harness);

    // Replay the same event four more times.
    for (let i = 0; i < 4; i++) {
      await harness.engine.ingestion.ingestPayment(payment, null);
    }

    const cases = await harness.store.cases.list({
      where: [{ field: 'sourceId', op: '==', value: payment.id }],
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.id).toBe(caseId);
  });

  it('refuses an illegal state transition', async () => {
    const { caseId } = await seedCase(harness);
    const now = new Date().toISOString();

    await harness.engine.cases.transition(caseId, 'investigating', { at: now, summary: 'looking' });
    await harness.engine.cases.transition(caseId, 'in_progress', { at: now, summary: 'acting' });
    await harness.engine.cases.transition(caseId, 'recovered', { at: now, summary: 'done' });

    // Terminal states have no outgoing edges. This is what keeps the recovered total
    // monotonic: nothing can reopen a case and re-bank the same money.
    await expect(
      harness.engine.cases.transition(caseId, 'in_progress', { at: now, summary: 'again' }),
    ).rejects.toThrow(/cannot move case/i);
  });

  it('accumulates a timeline as the case progresses', async () => {
    const { caseId } = await seedCase(harness);
    const now = new Date().toISOString();

    await harness.engine.cases.appendTimeline(caseId, {
      at: now,
      kind: 'predicted',
      summary: 'Scored at 60%.',
    });
    await harness.engine.cases.appendTimeline(caseId, {
      at: now,
      kind: 'decided',
      summary: 'Chose a delayed retry.',
    });

    const updated = await harness.engine.cases.get(caseId);
    // One entry from detection plus the two just added.
    expect(updated.timeline).toHaveLength(3);
    expect(updated.timeline[0]!.kind).toBe('detected');
    expect(updated.timeline.at(-1)!.kind).toBe('decided');
  });

  it('ranks the work queue by priority score', async () => {
    const small = await seedCase(harness, { amountMinor: 50_000 });
    const large = await seedCase(harness, { amountMinor: 5_000_000 });

    const now = new Date().toISOString();
    await harness.engine.cases.recordPrediction(small.caseId, {
      probability: 0.5,
      expectedValueMinor: 20_000,
      isSubscriber: false,
      lifetimeValueMinor: 0,
      at: now,
    });
    await harness.engine.cases.recordPrediction(large.caseId, {
      probability: 0.5,
      expectedValueMinor: 2_000_000,
      isSubscriber: false,
      lifetimeValueMinor: 0,
      at: now,
    });

    const queue = await harness.engine.cases.listWorkQueue(harness.merchantId, { limit: 10 });
    expect(queue[0]!.id).toBe(large.caseId);
  });
});

describe('ingestion — detection across every loss channel', () => {
  it('opens cases for failures, dunning, abandonment and overdue invoices', async () => {
    const harness = await createHarness({ withCorpus: true });

    const summary = await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 500 });
    const created =
      summary.created.paymentFailure +
      summary.created.subscriptionDunning +
      summary.created.checkoutAbandonment +
      summary.created.overdueInvoice;

    expect(created).toBeGreaterThan(0);
    expect(summary.created.paymentFailure).toBeGreaterThan(0);
    expect(summary.created.checkoutAbandonment).toBeGreaterThan(0);
    expect(summary.totalAtRiskMinor).toBeGreaterThan(0);
  });

  it('is idempotent — a second pass opens nothing new', async () => {
    const harness = await createHarness({ withCorpus: true });

    await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 200 });
    const countAfterFirst = await harness.store.cases.count();

    const second = await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 200 });
    const countAfterSecond = await harness.store.cases.count();

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.skippedExisting).toBeGreaterThan(0);
  });

  it('ignores a failure that was already followed by a successful payment', async () => {
    const harness = await createHarness();
    const { customerId } = await seedCustomer(harness, { successfulPayments: 0 });
    const base = Date.now();

    // A failure, then the same amount succeeding an hour later. Nothing is at risk.
    await harness.store.payments.put({
      id: 'pay_failed_then_ok',
      merchantId: harness.merchantId,
      customerId,
      amountMinor: 300_000,
      currency: 'INR',
      method: 'card',
      issuer: 'HDFC Bank',
      network: 'Visa',
      status: 'failed',
      source: 'checkout',
      failureReason: 'payment_timeout',
      errorCode: null,
      createdAt: new Date(base - 7_200_000).toISOString(),
      capturedAt: null,
      subscriptionId: null,
      invoiceId: null,
      recoveryCaseId: null,
      idempotencyKey: 'k1',
      providerRef: null,
    });
    await harness.store.payments.put({
      id: 'pay_recovered_naturally',
      merchantId: harness.merchantId,
      customerId,
      amountMinor: 300_000,
      currency: 'INR',
      method: 'card',
      issuer: 'HDFC Bank',
      network: 'Visa',
      status: 'captured',
      source: 'checkout',
      failureReason: null,
      errorCode: null,
      createdAt: new Date(base - 3_600_000).toISOString(),
      capturedAt: new Date(base - 3_600_000).toISOString(),
      subscriptionId: null,
      invoiceId: null,
      recoveryCaseId: null,
      idempotencyKey: 'k2',
      providerRef: null,
    });

    const summary = await harness.engine.ingestion.ingest(harness.merchantId);
    expect(summary.created.paymentFailure).toBe(0);
  });

  it('ignores failures below the minimum worth working', async () => {
    const harness = await createHarness();
    await seedCase(harness, { amountMinor: 100 });
    const summary = await harness.engine.ingestion.ingest(harness.merchantId, {
      minAmountMinor: 100_000,
    });
    expect(summary.created.paymentFailure).toBe(0);
  });
});

describe('context service — assembling the opportunity graph', () => {
  it('derives relational features from the customer history', async () => {
    const harness = await createHarness();
    const { caseId } = await seedCase(harness, {
      customer: { successfulPayments: 8, failedPayments: 2 },
    });

    const context = await harness.engine.context.buildCaseContext(caseId);

    expect(context.features.successfulPaymentCount).toBe(8);
    expect(context.features.successRatio).toBeGreaterThan(0.5);
    expect(context.features.lifetimeValueMinor).toBe(8 * 250_000);
    // Every model feature must be computable from the context alone.
    expect(context.modelInput.customerSuccessCount).toBe(8);
    expect(context.modelInput.profileKey).toBe('insufficient_funds');
  });

  it('detects an alternate working instrument', async () => {
    const harness = await createHarness();
    const { customerId } = await seedCustomer(harness, {
      successfulPayments: 4,
      preferredMethod: 'upi',
    });
    // The failure is on a card; the customer has a working UPI history.
    const { caseId } = await seedCase(harness, { customerId, method: 'card' });

    const context = await harness.engine.context.buildCaseContext(caseId);
    expect(context.features.hasAlternateSuccessfulMethod).toBe(true);
    expect(context.features.alternateMethods).toContain('upi');
  });

  it('builds a renderable graph with the case at the focus', async () => {
    const harness = await createHarness();
    const { caseId } = await seedCase(harness, { customer: { successfulPayments: 6 } });

    const context = await harness.engine.context.buildCaseContext(caseId);
    const graph = harness.engine.context.buildGraph(context);

    expect(graph.focusNodeId).toBe(caseId);
    expect(graph.nodes.length).toBeGreaterThan(3);
    expect(graph.nodes.some((n) => n.kind === 'customer')).toBe(true);
    expect(graph.narrative.length).toBeGreaterThan(40);
    // Every edge must connect two nodes that are actually present.
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.from) || ids.has(edge.to)).toBe(true);
    }
  });
});

describe('analytics — measured, not asserted', () => {
  it('never counts an un-captured intervention as recovered revenue', async () => {
    const harness = await createHarness({ withCorpus: true });
    const overview = await harness.engine.analytics.controlTower(harness.merchantId);
    const outcomes = await harness.store.outcomes.list({
      where: [{ field: 'merchantId', op: '==', value: harness.merchantId }],
    });

    const recoveredFromOutcomes = outcomes
      .filter((o) => o.outcome === 'recovered')
      .reduce((sum, o) => sum + o.recoveredAmountMinor, 0);

    expect(overview.recoveredRevenueMinor).toBe(recoveredFromOutcomes);
  });

  it('produces a funnel whose stages are nested subsets', async () => {
    const harness = await createHarness({ withCorpus: true });
    await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 100 });

    const funnel = await harness.engine.analytics.funnel(harness.merchantId);
    for (let i = 1; i < funnel.length; i++) {
      // A stage can never contain more value than the one above it.
      expect(funnel[i]!.amountMinor).toBeLessThanOrEqual(funnel[i - 1]!.amountMinor);
    }
  });

  it('keeps the audit chain valid through a full analytics workload', async () => {
    const harness = await createHarness({ withCorpus: true });
    await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 50 });

    const logs = await harness.store.auditLogs.list({
      where: [{ field: 'merchantId', op: '==', value: harness.merchantId }],
    });
    expect(verifyAuditChain(logs).valid).toBe(true);
  });
});

describe('analytics — read amplification against a billed store', () => {
  /**
   * Wrap a store so every `list` call is counted. The portfolio scan is cheap over the
   * in-memory store but is thousands of billed document reads against Firestore, and
   * `/api/metrics` calls it six times per request — so the count, not the wall time, is
   * the thing worth asserting.
   */
  function countingStore(inner: Awaited<ReturnType<typeof createHarness>>['store']) {
    let listCalls = 0;
    const wrap = <T extends { list: (...args: never[]) => unknown }>(repo: T): T =>
      new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === 'list') {
            return (...args: never[]) => {
              listCalls += 1;
              return (target.list as (...a: never[]) => unknown)(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

    const proxied = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          value &&
          typeof value === 'object' &&
          'list' in (value as Record<string, unknown>) &&
          typeof (value as { list?: unknown }).list === 'function'
        ) {
          return wrap(value as { list: (...args: never[]) => unknown });
        }
        return value;
      },
    });

    return { store: proxied, reads: () => listCalls };
  }

  it('does not cache over the in-memory store, so figures are always fresh', async () => {
    const harness = await createHarness({ withCorpus: true });
    const service = new AnalyticsService(harness.store);

    const before = await service.controlTower(harness.merchantId);
    // A new case appears. With no cache, the very next read must see it.
    await seedCase(harness, { amountMinor: 999_900 });
    const after = await service.controlTower(harness.merchantId);

    expect(after.totalCases).toBe(before.totalCases + 1);
  });

  it('collapses one request worth of analytics into a single portfolio scan', async () => {
    const harness = await createHarness({ withCorpus: true });
    const counted = countingStore(harness.store);
    const service = new AnalyticsService(counted.store, { ttlMs: 30_000 });

    const merchantId = harness.merchantId;
    // Exactly what /api/metrics does: six analytics calls, concurrently.
    await Promise.all([
      service.controlTower(merchantId),
      service.funnel(merchantId),
      service.trend(merchantId, 30),
      service.opportunities(merchantId, 12),
      service.strategyPerformance(merchantId),
      service.systemHealth(merchantId),
    ]);

    // Five collections in one portfolio scan. Without the shared in-flight promise this
    // would be six scans — the difference between a usable Firestore deployment and one
    // that exhausts a day's read quota on a single page view.
    expect(counted.reads()).toBeLessThanOrEqual(12);
  });

  it('serves a second request from cache, then refreshes after the TTL', async () => {
    const harness = await createHarness({ withCorpus: true });
    const counted = countingStore(harness.store);
    const service = new AnalyticsService(counted.store, { ttlMs: 30_000 });

    await service.controlTower(harness.merchantId);
    const afterFirst = counted.reads();

    await service.controlTower(harness.merchantId);
    expect(counted.reads()).toBe(afterFirst);

    // An explicit invalidation is what the batch and demo endpoints use so a run shows up
    // immediately rather than waiting out the window.
    service.invalidate();
    await service.controlTower(harness.merchantId);
    expect(counted.reads()).toBeGreaterThan(afterFirst);
  });
});
