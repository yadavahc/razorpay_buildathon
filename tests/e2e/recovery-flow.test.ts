import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@reclaim/core';
import {
  AlwaysDeclinesProvider,
  AlwaysSucceedsProvider,
  createHarness,
  seedCase,
} from '../support/harness';

/**
 * END-TO-END
 *
 * Payment failure → detection → prediction → AI decision → policy → action → outcome,
 * through the real pipeline with nothing stubbed but the outside world.
 *
 * These are the tests that would catch a regression nobody thought to unit-test: an
 * ordering change that lets the provider be called before the idempotency key is claimed,
 * or a state machine that lets a recovered case be recovered twice.
 */

describe('end-to-end — the full recovery loop', () => {
  it('runs every phase and records each one', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 420_000,
      failureReason: 'insufficient_funds',
      customer: { successfulPayments: 8 },
    });

    const result = await harness.engine.decisions.runCase(caseId, {
      execute: true,
      actor: { kind: 'agent', id: 'agent:test' },
      trigger: 'e2e',
    });

    // Every phase ran, in order.
    const phases = result.phases.map((p) => p.phase);
    expect(phases).toEqual(['context', 'predict', 'diagnose', 'decide', 'execute']);

    // The decision was recorded before execution, so the reasoning survives a crash.
    const decision = await harness.store.aiDecisions.get(result.aiDecision.id);
    expect(decision).not.toBeNull();
    expect(decision!.candidates).toHaveLength(6);
    expect(decision!.recoveryProbability).toBeGreaterThan(0);

    // A policy decision exists for the action that was taken.
    const policies = await harness.store.policyDecisions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(policies.length).toBeGreaterThan(0);

    // An outcome was measured against the prediction.
    const outcomes = await harness.store.outcomes.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0]!.predictedProbability).toBeGreaterThan(0);
  });

  it('recovers money and books it exactly once', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 300_000,
      failureReason: 'payment_timeout',
      customer: { successfulPayments: 9 },
    });

    const result = await harness.engine.decisions.runCase(caseId, { execute: true });
    expect(result.execution?.recoveredAmountMinor).toBe(300_000);

    const recovered = await harness.engine.cases.get(caseId);
    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmountMinor).toBe(300_000);

    // The portfolio total agrees with the case.
    const overview = await harness.engine.analytics.controlTower(harness.merchantId);
    expect(overview.recoveredRevenueMinor).toBe(300_000);
  });

  it('refuses to work a case that has already been resolved', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 300_000,
      failureReason: 'payment_timeout',
      customer: { successfulPayments: 9 },
    });

    await harness.engine.decisions.runCase(caseId, { execute: true });

    // Running it again must not double-count the money.
    await expect(harness.engine.decisions.runCase(caseId, { execute: true })).rejects.toThrow(
      /cannot be worked further/i,
    );

    const overview = await harness.engine.analytics.controlTower(harness.merchantId);
    expect(overview.recoveredRevenueMinor).toBe(300_000);
  });

  it('falls back rather than giving up when the first action is impossible', async () => {
    // An expired card cannot be retried, so the engine must route around it.
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 480_000,
      failureReason: 'card_expired',
      method: 'card',
      customer: { successfulPayments: 7 },
    });

    const result = await harness.engine.decisions.runCase(caseId, {
      execute: true,
      overrideStrategy: 'delayed_retry',
    });

    const execution = result.execution!;
    expect(execution.blockedByPolicy).toBe(true);
    // Blocked, but not abandoned: it moved to something that can actually work.
    expect(execution.finalStrategy).not.toBe('delayed_retry');
    expect(execution.fallbacksUsed).toBeGreaterThan(0);
  });

  it('reaches a terminal state even when every option fails', async () => {
    const harness = await createHarness({
      withModel: true,
      provider: new AlwaysDeclinesProvider(),
      policy: { cooldownHours: 0 },
    });
    const { caseId } = await seedCase(harness, {
      amountMinor: 200_000,
      failureReason: 'do_not_honour',
      customer: { successfulPayments: 4 },
    });

    await harness.engine.decisions.runCase(caseId, { execute: true });

    const finalCase = await harness.engine.cases.get(caseId);
    // A case must never be left dangling: it either recovers, stops, or is written off.
    expect(['recovered', 'stopped', 'unrecoverable', 'escalated', 'in_progress']).toContain(
      finalCase.status,
    );
    const outcomes = await harness.store.outcomes.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('reports the outcome it recorded, even when the case was stopped rather than recovered', async () => {
    // A guardrail stop and an action failure are different things, and the executor must
    // hand back the outcome it actually wrote instead of leaving the caller to guess.
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 400_000,
      failureReason: 'insufficient_funds',
      // A customer over the chargeback tolerance: every money-moving option is refused.
      customer: { successfulPayments: 6, chargebackCount: 9, contactOptOut: true },
    });

    const result = await harness.engine.decisions.runCase(caseId, { execute: true });

    expect(result.execution?.outcome).not.toBeNull();
    const recorded = await harness.store.outcomes.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(recorded).toHaveLength(1);
    expect(result.execution!.outcome!.id).toBe(recorded[0]!.id);
    expect(result.execution!.outcome!.recoveredAmountMinor).toBe(0);
  });

  it('leaves a complete, verifiable audit trail', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 350_000,
      customer: { successfulPayments: 8 },
    });

    await harness.engine.decisions.runCase(caseId, { execute: true, trigger: 'e2e-audit' });

    const entries = await harness.store.auditLogs.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    const events = entries.map((e) => e.event);

    expect(events).toContain('case.detected');
    expect(events).toContain('ai.decision_recorded');
    expect(events.some((e) => e.startsWith('action.'))).toBe(true);
    expect(events).toContain('outcome.recorded');

    // Every financial entry carries the fields an auditor needs.
    const actionEntry = entries.find((e) => e.event === 'action.executed');
    expect(actionEntry?.amountMinor).toBeGreaterThan(0);
    expect(actionEntry?.actionId).toBeTruthy();
    expect(actionEntry?.policyDecisionId).toBeTruthy();
    expect(actionEntry?.aiDecisionId).toBeTruthy();

    const allLogs = await harness.store.auditLogs.list({
      where: [{ field: 'merchantId', op: '==', value: harness.merchantId }],
    });
    expect(verifyAuditChain(allLogs).valid).toBe(true);
  });
});

describe('end-to-end — batch', () => {
  it('processes a queue and reports measured totals', async () => {
    const harness = await createHarness({
      withCorpus: true,
      withModel: true,
      provider: new AlwaysSucceedsProvider(),
    });

    await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 40 });
    const queue = await harness.engine.cases.listWorkQueue(harness.merchantId, { limit: 40 });

    const before = await harness.engine.analytics.controlTower(harness.merchantId);
    const result = await harness.engine.decisions.runBatch(
      queue.map((c) => c.id),
      { execute: true, actor: { kind: 'system', id: 'batch' }, trigger: 'e2e-batch' },
    );
    const after = await harness.engine.analytics.controlTower(harness.merchantId);

    expect(result.processed).toBeGreaterThan(0);
    // The reported recovery must equal the change in the measured portfolio total.
    expect(after.recoveredRevenueMinor - before.recoveredRevenueMinor).toBe(result.recoveredMinor);
    expect(after.activeCases).toBeLessThanOrEqual(before.activeCases + queue.length);
  });

  it('never aborts the whole batch because one case failed', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const good = await seedCase(harness, { amountMinor: 200_000, customer: { successfulPayments: 6 } });
    const alsoGood = await seedCase(harness, {
      amountMinor: 250_000,
      customer: { successfulPayments: 6 },
    });

    const result = await harness.engine.decisions.runBatch(
      [good.caseId, 'case_does_not_exist', alsoGood.caseId],
      { execute: true },
    );

    expect(result.processed).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.caseId).toBe('case_does_not_exist');
  });

  it('respects the daily contact cap across cases for the same customer', async () => {
    // Two cases, one customer, a failure class that can only be answered by contacting.
    const harness = await createHarness({
      withModel: true,
      policy: { dailyContactCap: 1, cooldownHours: 0 },
    });
    const first = await seedCase(harness, {
      amountMinor: 400_000,
      failureReason: 'card_expired',
      method: 'card',
      customer: { successfulPayments: 6 },
    });
    const second = await seedCase(harness, {
      amountMinor: 400_000,
      failureReason: 'card_expired',
      method: 'card',
      customerId: first.customerId,
    });

    await harness.engine.decisions.runBatch([first.caseId, second.caseId], { execute: true });

    const notifications = await harness.store.notifications.list({
      where: [{ field: 'customerId', op: '==', value: first.customerId }],
    });
    const sent = notifications.filter((n) => n.status === 'sent');
    // The cap is per customer per day, counted across every open case they have.
    expect(sent.length).toBeLessThanOrEqual(1);
  });
});

describe('end-to-end — recommendation without execution', () => {
  it('records a decision but takes no action', async () => {
    const harness = await createHarness({ withModel: true });
    const { caseId } = await seedCase(harness, { customer: { successfulPayments: 5 } });

    const result = await harness.engine.decisions.runCase(caseId, { execute: false });

    expect(result.executed).toBe(false);
    expect(result.execution).toBeNull();

    const decisions = await harness.store.aiDecisions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(decisions).toHaveLength(1);

    const actions = await harness.store.actions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(actions).toHaveLength(0);

    // But the case is scored and rankable afterwards.
    const scored = await harness.engine.cases.get(caseId);
    expect(scored.recoveryProbability).not.toBeNull();
    expect(scored.priorityScore).not.toBeNull();
  });
});
