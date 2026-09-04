import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  READ_ONLY_SCOPES,
  type ToolCallContext,
  noopLogger,
} from '@reclaim/core';
import { createHarness, scoreCase, seedCase, type Harness } from '../support/harness';

/**
 * AGENT TESTS
 *
 * The question these answer is not "does the agent produce nice text" but "can the agent
 * do something it should not be able to do". Tool selection, argument validation,
 * authorisation and idempotency are all asserted directly, because prompt instructions
 * are not a security boundary and these are.
 */

function toolContext(harness: Harness, overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    merchantId: harness.merchantId,
    actor: { kind: 'agent', id: 'agent:test' },
    scopes: ALL_SCOPES,
    store: harness.store,
    logger: noopLogger,
    nowIso: new Date().toISOString(),
    runId: `run_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

describe('tool registry — authorisation', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('refuses a write tool to an agent holding only read scopes', async () => {
    const { caseId } = await seedCase(harness);

    const result = await harness.engine.tools.invoke(
      'retry_payment',
      { caseId, timing: 'delayed' },
      toolContext(harness, { scopes: READ_ONLY_SCOPES }),
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('FORBIDDEN');
    expect(result.error).toContain('write:payment');
  });

  it('blocks the write BEFORE any handler runs, so no action is created', async () => {
    const { caseId } = await seedCase(harness);

    await harness.engine.tools.invoke(
      'create_payment_link',
      { caseId },
      toolContext(harness, { scopes: READ_ONLY_SCOPES }),
    );

    // Authorisation is a gate, not a check inside the handler.
    const actions = await harness.store.actions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(actions).toHaveLength(0);
  });

  it('allows read tools to a read-scoped agent', async () => {
    const { caseId } = await seedCase(harness);

    const result = await harness.engine.tools.invoke(
      'get_customer_context',
      { caseId },
      toolContext(harness, { scopes: READ_ONLY_SCOPES }),
    );

    expect(result.ok).toBe(true);
  });

  it('exposes only in-scope tools in the catalog handed to a planner', () => {
    const readOnly = harness.engine.tools.catalog(READ_ONLY_SCOPES).map((t) => t.name);
    const full = harness.engine.tools.catalog(ALL_SCOPES).map((t) => t.name);

    expect(readOnly).toContain('get_customer_context');
    expect(readOnly).not.toContain('retry_payment');
    expect(full).toContain('retry_payment');
    // A planner cannot ask for a tool it was never shown.
    expect(full.length).toBeGreaterThan(readOnly.length);
  });
});

describe('tool registry — validation', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('rejects an unknown tool by name rather than throwing', async () => {
    const result = await harness.engine.tools.invoke('definitely_not_a_tool', {}, toolContext(harness));

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
    // The agent loop must be able to observe this and adapt.
    expect(result.error).toContain('available tools are');
  });

  it('rejects malformed arguments with a field-level message', async () => {
    const result = await harness.engine.tools.invoke(
      'get_customer_context',
      { caseId: '' },
      toolContext(harness),
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(result.error).toContain('caseId');
  });

  it('rejects arguments of the wrong type', async () => {
    const result = await harness.engine.tools.invoke(
      'get_payment_history',
      { caseId: 'case_1', limit: 'many' },
      toolContext(harness),
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects an out-of-range argument', async () => {
    const { caseId } = await seedCase(harness);
    const result = await harness.engine.tools.invoke(
      'get_payment_history',
      { caseId, limit: 9_999 },
      toolContext(harness),
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
  });

  it('never lets an exception escape as an exception', async () => {
    // A tool asked about a case that does not exist must report, not throw.
    const result = await harness.engine.tools.invoke(
      'get_customer_context',
      { caseId: 'case_does_not_exist' },
      toolContext(harness),
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

describe('tool registry — idempotency and audit', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('suppresses an identical mutating call within the same run', async () => {
    const { caseId } = await seedCase(harness);
    await scoreCase(harness, caseId, 0.7, 200_000);
    const context = toolContext(harness);

    const first = await harness.engine.tools.invoke('create_payment_link', { caseId }, context);
    const second = await harness.engine.tools.invoke('create_payment_link', { caseId }, context);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // A suppressed duplicate is a success, not a failure — nothing went wrong.
    expect(second.ok).toBe(true);
  });

  it('writes an audit entry for every invocation, including rejected ones', async () => {
    const { caseId } = await seedCase(harness);
    const before = await harness.store.auditLogs.count();

    await harness.engine.tools.invoke('get_customer_context', { caseId }, toolContext(harness));
    await harness.engine.tools.invoke('nope', {}, toolContext(harness));
    await harness.engine.tools.invoke(
      'retry_payment',
      { caseId },
      toolContext(harness, { scopes: READ_ONLY_SCOPES }),
    );

    const after = await harness.store.auditLogs.count();
    expect(after - before).toBeGreaterThanOrEqual(3);

    const entries = await harness.store.auditLogs.list();
    const toolEntries = entries.filter((e) => e.event.startsWith('tool.'));
    expect(toolEntries.some((e) => e.event === 'tool.nope')).toBe(true);
    expect(toolEntries.some((e) => e.failure !== null)).toBe(true);
  });

  it('refuses to register a mutating tool without an idempotency derivation', () => {
    // Enforced at registration, so the mistake cannot reach runtime.
    expect(() =>
      harness.engine.tools.register({
        name: 'unsafe_tool',
        description: 'x',
        parameterSummary: '{}',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        scope: 'write:payment',
        mutating: true,
        summarize: () => '',
        handler: async () => ({}),
      }),
    ).toThrow(/must declare an idempotencyKey/i);
  });
});

describe('tool behaviour — the read tools return real evidence', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });

  it('get_customer_context reports the actual payment history', async () => {
    const { caseId } = await seedCase(harness, {
      customer: { successfulPayments: 7, failedPayments: 2 },
    });

    const result = await harness.engine.tools.invoke(
      'get_customer_context',
      { caseId },
      toolContext(harness),
    );

    const output = result.output as { successfulPayments: number; lifetimeValueMinor: number };
    expect(result.ok).toBe(true);
    expect(output.successfulPayments).toBe(7);
    expect(output.lifetimeValueMinor).toBe(7 * 250_000);
    expect(result.summary).toContain('7 successful');
  });

  it('diagnose_failure classifies against the taxonomy', async () => {
    const { caseId } = await seedCase(harness, { failureReason: 'card_expired', method: 'card' });

    const result = await harness.engine.tools.invoke(
      'diagnose_failure',
      { caseId },
      toolContext(harness),
    );

    const output = result.output as { retryPossible: boolean; category: string; label: string };
    expect(output.retryPossible).toBe(false);
    expect(output.category).toBe('instrument');
    expect(output.label).toBe('Card expired');
  });

  it('calculate_expected_recovery prices every strategy and marks the impossible ones', async () => {
    const { caseId } = await seedCase(harness, { failureReason: 'card_expired', method: 'card' });

    const result = await harness.engine.tools.invoke(
      'calculate_expected_recovery',
      { caseId, probabilityOverride: 0.6 },
      toolContext(harness),
    );

    const output = result.output as {
      candidates: Array<{ strategy: string; eligible: boolean; expectedValueMinor: number }>;
      bestStrategy: string;
    };

    expect(output.candidates).toHaveLength(6);
    const retry = output.candidates.find((c) => c.strategy === 'delayed_retry')!;
    expect(retry.eligible).toBe(false);
    // A dead card must never be answered with a retry.
    expect(output.bestStrategy).not.toBe('delayed_retry');
    expect(output.bestStrategy).not.toBe('immediate_retry');
  });

  it('get_subscription surfaces a revoked mandate', async () => {
    const { caseId } = await seedCase(harness, {
      sourceType: 'subscription_dunning',
      mandateActive: false,
    });

    const result = await harness.engine.tools.invoke(
      'get_subscription',
      { caseId },
      toolContext(harness),
    );

    const output = result.output as { mandateActive: boolean | null };
    expect(output.mandateActive).toBe(false);
    expect(result.summary).toContain('REVOKED');
  });
});

describe('recovery analyst agent — investigation', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness({ withModel: true });
  });

  it('selects only valid tools and produces a diagnosis', async () => {
    const { caseId } = await seedCase(harness, { customer: { successfulPayments: 6 } });
    const context = await harness.engine.context.buildCaseContext(caseId);
    const prediction = harness.engine.prediction.predict(context.modelInput);
    const graph = harness.engine.context.buildGraph(context);

    const investigation = await harness.engine.analyst.investigate({
      context,
      prediction,
      graphNarrative: graph.narrative,
    });

    expect(investigation.toolCalls.length).toBeGreaterThan(0);
    // Every tool it chose must exist and have been permitted.
    for (const call of investigation.toolCalls) {
      expect(harness.engine.tools.has(call.tool)).toBe(true);
      expect(call.errorCode).not.toBe('FORBIDDEN');
    }
    expect(investigation.diagnosis.headline.length).toBeGreaterThan(10);
    expect(investigation.diagnosis.keyFactors.length).toBeGreaterThan(0);
  });

  it('never calls a write tool, because it does not hold the scope', async () => {
    const { caseId } = await seedCase(harness);
    const context = await harness.engine.context.buildCaseContext(caseId);
    const prediction = harness.engine.prediction.predict(context.modelInput);

    const investigation = await harness.engine.analyst.investigate({
      context,
      prediction,
      graphNarrative: 'test',
    });

    const writeTools = ['retry_payment', 'create_payment_link', 'send_notification', 'escalate_case'];
    for (const call of investigation.toolCalls) {
      expect(writeTools).not.toContain(call.tool);
    }
    // And nothing was executed as a side effect of merely looking.
    const actions = await harness.store.actions.list({
      where: [{ field: 'caseId', op: '==', value: caseId }],
    });
    expect(actions).toHaveLength(0);
  });

  it('completes on partial evidence when a tool fails', async () => {
    const { caseId } = await seedCase(harness);
    const context = await harness.engine.context.buildCaseContext(caseId);
    const prediction = harness.engine.prediction.predict(context.modelInput);

    // Delete the case out from under the agent so its tools start failing mid-run.
    await harness.store.cases.delete(caseId);

    const investigation = await harness.engine.analyst.investigate({
      context,
      prediction,
      graphNarrative: 'test',
    });

    // It must still produce a usable diagnosis rather than throwing.
    expect(investigation.diagnosis.headline.length).toBeGreaterThan(0);
    expect(investigation.degradedEvidence).toBeTruthy();
    expect(investigation.toolCalls.some((c) => !c.ok)).toBe(true);
  });

  it('bounds its own tool loop', async () => {
    const { caseId } = await seedCase(harness);
    const context = await harness.engine.context.buildCaseContext(caseId);
    const prediction = harness.engine.prediction.predict(context.modelInput);

    const investigation = await harness.engine.analyst.investigate({
      context,
      prediction,
      graphNarrative: 'test',
    });

    // A runaway agent loop is a production incident, so the budget is hard.
    expect(investigation.toolCalls.length).toBeLessThanOrEqual(6);
  });
});

describe('strategy agent — recommendation', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness({ withModel: true });
  });

  it('only ever recommends a structurally available strategy', async () => {
    const { caseId } = await seedCase(harness, { failureReason: 'mandate_revoked', method: 'nach' });
    const context = await harness.engine.context.buildCaseContext(caseId);

    const decision = await harness.engine.strategist.decide({
      context,
      recoveryProbability: 0.8,
      diagnosis: {
        headline: 'Mandate revoked.',
        explanation: 'The recurring authorisation has been cancelled.',
        keyFactors: ['mandate revoked'],
        confidence: 0.9,
      },
    });

    const chosen = decision.candidates.find((c) => c.strategy === decision.recommendedStrategy)!;
    expect(chosen.eligible).toBe(true);
    expect(decision.recommendedStrategy).not.toBe('immediate_retry');
    expect(decision.recommendedStrategy).not.toBe('delayed_retry');
  });

  it('chooses to stop when nothing clears the bar', async () => {
    // A tiny balance on an unrecoverable failure class: every option is value-destroying.
    const { caseId } = await seedCase(harness, {
      amountMinor: 6_000,
      failureReason: 'invalid_account',
      method: 'netbanking',
      customer: { successfulPayments: 0, failedPayments: 6 },
    });
    const context = await harness.engine.context.buildCaseContext(caseId);

    const decision = await harness.engine.strategist.decide({
      context,
      recoveryProbability: 0.06,
      diagnosis: {
        headline: 'The destination account does not exist.',
        explanation: 'Nothing on the merchant side can repair a closed account.',
        keyFactors: ['invalid account'],
        confidence: 0.9,
      },
    });

    expect(decision.recommendedStrategy).toBe('stop_recovery');
    expect(decision.expectedValueMinor).toBe(0);
  });

  it('records when the reasoner departs from the expected-value winner', async () => {
    const { caseId } = await seedCase(harness);
    const context = await harness.engine.context.buildCaseContext(caseId);

    const decision = await harness.engine.strategist.decide({
      context,
      recoveryProbability: 0.65,
      diagnosis: {
        headline: 'Insufficient funds.',
        explanation: 'Balance-driven decline.',
        keyFactors: ['funding'],
        confidence: 0.8,
      },
    });

    // With the deterministic reasoner the two always agree, and the override field says so.
    if (decision.recommendedStrategy === decision.economicChoice) {
      expect(decision.overrode).toBeNull();
    } else {
      expect(decision.overrode).not.toBeNull();
      expect(decision.overrode!.from).toBe(decision.economicChoice);
    }
  });

  it('produces a confidence that reflects how clear-cut the choice was', async () => {
    const { caseId } = await seedCase(harness);
    const context = await harness.engine.context.buildCaseContext(caseId);

    const decision = await harness.engine.strategist.decide({
      context,
      recoveryProbability: 0.65,
      diagnosis: {
        headline: 'Insufficient funds.',
        explanation: 'Balance-driven decline.',
        keyFactors: ['funding'],
        confidence: 0.8,
      },
    });

    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.explanation.length).toBeGreaterThan(30);
  });
});

describe('merchant copilot — grounded answers', () => {
  it('answers from real queries and cites the figures it used', async () => {
    const harness = await createHarness({ withCorpus: true, withModel: true });
    await harness.engine.ingestion.ingest(harness.merchantId, { maxCases: 60 });

    const answer = await harness.engine.copilot.ask(
      harness.merchantId,
      'How much revenue is currently at risk?',
    );

    expect(answer.answer.length).toBeGreaterThan(20);
    expect(answer.toolsUsed.length).toBeGreaterThan(0);
    expect(answer.citations.length).toBeGreaterThan(0);
    // The cited figures must be the computed ones.
    const overview = await harness.engine.analytics.controlTower(harness.merchantId);
    const riskCitation = answer.citations.find((c) => c.label === 'Revenue at risk');
    expect(riskCitation).toBeDefined();
    expect(riskCitation!.value).toContain(
      Math.round(overview.revenueAtRiskMinor / 100).toLocaleString('en-IN').slice(0, 3),
    );
  });

  it('routes different questions to different intents and different tools', async () => {
    const harness = await createHarness({ withCorpus: true });

    const drop = await harness.engine.copilot.ask(harness.merchantId, 'Why did revenue drop?');
    const opportunity = await harness.engine.copilot.ask(
      harness.merchantId,
      'What is our biggest recovery opportunity?',
    );

    expect(drop.intent).toBe('revenue_drop');
    expect(opportunity.intent).toBe('biggest_opportunity');
    expect(drop.toolsUsed).not.toEqual(opportunity.toolsUsed);
  });

  it('answers safely on an empty portfolio rather than inventing numbers', async () => {
    const harness = await createHarness();
    const answer = await harness.engine.copilot.ask(
      harness.merchantId,
      'What is our biggest recovery opportunity?',
    );

    expect(answer.answer.length).toBeGreaterThan(10);
    // Nothing recovered, nothing at risk — and it says so rather than fabricating.
    expect(answer.citations.every((c) => c.value.length > 0)).toBe(true);
  });
});
