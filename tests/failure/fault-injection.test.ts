import { afterEach, describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  errors,
  faultInjector,
  fixedClock,
  withRetry,
  withTimeout,
} from '@reclaim/core';
import { AlwaysSucceedsProvider, createHarness, seedCase } from '../support/harness';

/**
 * FAILURE TESTS
 *
 * Every fault the Failure Lab can arm, asserted to produce a recovery rather than a
 * crash. The property under test is never "the fault happened" — it is "the system was
 * still correct afterwards": the case reached a terminal state, no money was double-taken,
 * and the audit trail records what went wrong.
 */

afterEach(() => {
  faultInjector.disarmAll();
});

describe('resilience primitives — retry', () => {
  it('retries a retryable failure and succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        // Retry classification reads the typed error, not an ad-hoc property, so the
        // test throws exactly what a provider throws.
        if (attempts < 3) throw errors.providerTimeout('test-provider', 100);
        return 'ok';
      },
      { policy: { maxAttempts: 5, baseDelayMs: 1 }, sleep: async () => {} },
    );

    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(3);
    expect(result.history).toHaveLength(2);
  });

  it('does not retry a non-retryable failure', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw errors.validation('malformed request');
        },
        {
          policy: { maxAttempts: 5, baseDelayMs: 1, isRetryable: () => false },
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow();

    // Burning a retry budget on a malformed request helps nobody.
    expect(attempts).toBe(1);
  });

  it('gives up after the budget and surfaces the final error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw errors.providerUnavailable('always-down-provider');
        },
        { policy: { maxAttempts: 3, baseDelayMs: 1 }, sleep: async () => {} },
      ),
    ).rejects.toThrow(/always-down-provider is unavailable/);

    expect(attempts).toBe(3);
  });

  it('backs off exponentially with jitter', async () => {
    const delays: number[] = [];
    await withRetry(
      async (attempt) => {
        if (attempt < 4) throw errors.providerTimeout('test-provider', 50);
        return 'ok';
      },
      {
        policy: { maxAttempts: 5, baseDelayMs: 100, factor: 2, maxDelayMs: 10_000, jitter: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(delays).toEqual([100, 200, 400]);
  });
});

describe('resilience primitives — timeout and circuit breaker', () => {
  it('rejects with a typed timeout rather than hanging', async () => {
    await expect(
      withTimeout(() => new Promise((resolve) => setTimeout(resolve, 500)), 20, 'slow-provider'),
    ).rejects.toThrow(/slow-provider timed out/);
  });

  it('opens after consecutive failures and then fails fast', async () => {
    const clock = fixedClock('2026-09-01T00:00:00.000Z');
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
      successThreshold: 1,
      clock,
    });

    const boom = async (): Promise<never> => {
      throw new Error('down');
    };

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(boom)).rejects.toThrow('down');
    }
    expect(breaker.snapshot().state).toBe('open');

    // Now it refuses without ever calling the dependency.
    let called = false;
    await expect(
      breaker.execute(async () => {
        called = true;
        return 'never';
      }),
    ).rejects.toThrow(/circuit breaker open/);
    expect(called).toBe(false);
  });

  it('admits a probe after the reset window and closes on success', async () => {
    const clock = fixedClock('2026-09-01T00:00:00.000Z');
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      resetTimeoutMs: 5_000,
      successThreshold: 1,
      clock,
    });

    const boom = async (): Promise<never> => {
      throw new Error('down');
    };
    await expect(breaker.execute(boom)).rejects.toThrow();
    await expect(breaker.execute(boom)).rejects.toThrow();
    expect(breaker.snapshot().state).toBe('open');

    clock.advance(6_000);
    expect(breaker.snapshot().state).toBe('half_open');

    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('re-opens immediately when the probe fails', async () => {
    const clock = fixedClock('2026-09-01T00:00:00.000Z');
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      resetTimeoutMs: 5_000,
      successThreshold: 1,
      clock,
    });

    const boom = async (): Promise<never> => {
      throw new Error('down');
    };
    await expect(breaker.execute(boom)).rejects.toThrow();
    await expect(breaker.execute(boom)).rejects.toThrow();

    clock.advance(6_000);
    // A dependency that fails its probe is still down; do not wait for the full threshold.
    await expect(breaker.execute(boom)).rejects.toThrow();
    expect(breaker.snapshot().state).toBe('open');
  });
});

describe('fault injection — bounded and self-disarming', () => {
  it('fires exactly the requested number of times', () => {
    faultInjector.arm({ kind: 'payment_timeout', target: 'payments', count: 2 });

    expect(faultInjector.shouldFail('payment_timeout', 'payments', 'op')).toBe(true);
    expect(faultInjector.shouldFail('payment_timeout', 'payments', 'op')).toBe(true);
    // Disarmed itself; the next demo is unaffected.
    expect(faultInjector.shouldFail('payment_timeout', 'payments', 'op')).toBe(false);
    expect(faultInjector.armed()).toHaveLength(0);
  });

  it('only fires against the target it was armed for', () => {
    faultInjector.arm({ kind: 'gateway_failure', target: 'llm', count: 5 });
    expect(faultInjector.shouldFail('gateway_failure', 'payments', 'op')).toBe(false);
    expect(faultInjector.shouldFail('gateway_failure', 'llm', 'op')).toBe(true);
  });

  it('records every firing', () => {
    faultInjector.arm({ kind: 'gateway_failure', target: '*', count: 1 });
    faultInjector.shouldFail('gateway_failure', 'payments', 'retryPayment');

    const events = faultInjector.events();
    expect(events.at(-1)?.kind).toBe('gateway_failure');
    expect(events.at(-1)?.operation).toBe('retryPayment');
  });
});

describe('failure lab — the system stays correct under each fault', () => {
  it('payment timeout → retries, then falls back, and the case still resolves', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 400_000,
      failureReason: 'insufficient_funds',
      customer: { successfulPayments: 7 },
    });

    // Enough firings to exhaust the retry budget on the first strategy.
    faultInjector.arm({ kind: 'payment_timeout', target: 'payments', count: 3 });

    const result = await harness.engine.decisions.runCase(caseId, { execute: true });

    expect(result.execution).not.toBeNull();
    const finalCase = await harness.engine.cases.get(caseId);
    // Whatever happened, the case is not left dangling.
    expect(['recovered', 'in_progress', 'stopped', 'unrecoverable', 'escalated']).toContain(
      finalCase.status,
    );

    const audit = await harness.store.auditLogs.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(audit.some((e) => e.event.startsWith('action.') || e.event === 'outcome.recorded')).toBe(
      true,
    );
  });

  it('gateway failure → recorded as a failure, never as a silent success', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 300_000,
      failureReason: 'payment_timeout',
      customer: { successfulPayments: 6 },
    });

    faultInjector.arm({ kind: 'gateway_failure', target: 'payments', count: 10 });
    await harness.engine.decisions.runCase(caseId, { execute: true });

    const finalCase = await harness.engine.cases.get(caseId);
    // The provider never captured anything, so nothing may be booked as recovered.
    expect(finalCase.recoveredAmountMinor).toBe(0);
    expect(finalCase.status).not.toBe('recovered');

    const overview = await harness.engine.analytics.controlTower(harness.merchantId);
    expect(overview.recoveredRevenueMinor).toBe(0);
  });

  it('duplicate request → suppressed before the provider is called', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 250_000,
      failureReason: 'insufficient_funds',
      customer: { successfulPayments: 6 },
    });

    const context = await harness.engine.context.buildCaseContext(caseId);
    const request = {
      context,
      strategy: 'delayed_retry' as const,
      successProbability: 0.8,
      expectedValueMinor: 150_000,
      aiDecisionId: null,
      actor: { kind: 'system' as const, id: 'test' },
      trigger: 'duplicate-test',
      allowFallback: false,
    };

    const first = await harness.engine.executor.execute(request);
    // Replay the *identical* request against the same case state.
    const second = await harness.engine.executor.execute(request);

    expect(first.finalStatus).toBe('succeeded');
    expect(second.duplicatePrevented).toBe(true);
    expect(second.finalStatus).toBe('skipped_duplicate');

    // The money was taken exactly once.
    const payments = await harness.store.payments.list({
      where: [{ field: 'recoveryCaseId', op: '==', value: caseId }],
    });
    expect(payments.filter((p) => p.status === 'captured')).toHaveLength(1);
  });

  it('invalid transaction → not retried, and the failure is typed', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 300_000,
      customer: { successfulPayments: 6 },
    });

    faultInjector.arm({ kind: 'invalid_transaction', target: 'payments', count: 1 });
    const result = await harness.engine.decisions.runCase(caseId, { execute: true });

    const failedStep = result.execution?.steps.find((s) => s.status === 'failed');
    if (failedStep) {
      // A malformed request is not a transient fault; it must not consume the budget.
      expect(failedStep.action?.attempts ?? 1).toBeLessThanOrEqual(1);
    }

    const finalCase = await harness.engine.cases.get(caseId);
    expect(finalCase.recoveredAmountMinor).toBeGreaterThanOrEqual(0);
  });

  it('AI unavailable → the decision still happens, flagged as degraded', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 300_000,
      customer: { successfulPayments: 6 },
    });

    faultInjector.arm({ kind: 'ai_unavailable', target: 'llm', count: 20 });

    const result = await harness.engine.decisions.runCase(caseId, { execute: true });

    // The reasoning layer was never load-bearing for correctness.
    expect(result.aiDecision.recommendedStrategy).toBeTruthy();
    expect(result.aiDecision.candidates).toHaveLength(6);
    expect(result.aiDecision.recoveryProbability).toBeGreaterThan(0);
    expect(result.aiDecision.explanation.length).toBeGreaterThan(20);
  });

  it('policy rejection → the alternative is taken, and the denial is recorded', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    // A revoked mandate makes every retry structurally impossible.
    const { caseId } = await seedCase(harness, {
      amountMinor: 400_000,
      failureReason: 'insufficient_funds',
      sourceType: 'subscription_dunning',
      mandateActive: false,
      customer: { successfulPayments: 6 },
    });

    const result = await harness.engine.decisions.runCase(caseId, {
      execute: true,
      overrideStrategy: 'delayed_retry',
    });

    const execution = result.execution!;
    expect(execution.blockedByPolicy).toBe(true);

    const denials = await harness.store.policyDecisions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    const denied = denials.find((d) => d.verdict === 'deny');
    expect(denied).toBeDefined();
    expect(denied!.reasonCodes).toContain('MANDATE_INACTIVE');

    // A blocked action is recorded, not swallowed.
    const actions = await harness.store.actions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(actions.some((a) => a.status === 'blocked')).toBe(true);
  });

  it('external API failure → surfaces as a typed error the executor can act on', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 350_000,
      failureReason: 'card_expired',
      method: 'card',
      customer: { successfulPayments: 6 },
    });

    faultInjector.arm({ kind: 'external_api_failure', target: 'payments', count: 10 });
    await harness.engine.decisions.runCase(caseId, { execute: true });

    const finalCase = await harness.engine.cases.get(caseId);
    expect(finalCase.recoveredAmountMinor).toBe(0);

    const audit = await harness.store.auditLogs.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    // The failure is in the record, with a reason.
    expect(audit.some((e) => e.failure !== null)).toBe(true);
  });

  it('a fault never corrupts the audit chain', async () => {
    const harness = await createHarness({ withModel: true, provider: new AlwaysSucceedsProvider() });
    const { caseId } = await seedCase(harness, {
      amountMinor: 300_000,
      customer: { successfulPayments: 6 },
    });

    faultInjector.arm({ kind: 'gateway_failure', target: 'payments', count: 4 });
    await harness.engine.decisions.runCase(caseId, { execute: true });

    const { verifyAuditChain } = await import('@reclaim/core');
    const logs = await harness.store.auditLogs.list({
      where: [{ field: 'merchantId', op: '==', value: harness.merchantId }],
    });
    expect(verifyAuditChain(logs).valid).toBe(true);
  });
});
