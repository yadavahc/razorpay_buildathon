import {
  type DataStore,
  type Payment,
  type RecoveryCase,
  type ReclaimConfig,
  RecoveryEngine,
  createMemoryStore,
  defaultConfig,
  faultInjector,
  getFailureProfile,
  idempotencyKeyFor,
  seededId,
  noopLogger,
  type FailureReason,
  type PaymentMethod,
} from '@reclaim/core';
import { DemoNotificationProvider, DemoPaymentProvider } from '@reclaim/core';
import { generateCorpus, type GeneratedCorpus } from '@reclaim/core/seed';
import { episodesToExamples } from '@reclaim/core/seed';
import { trainRecoveryModel, type ModelArtifact } from '@reclaim/core';

/**
 * The test harness.
 *
 * Builds a complete, real engine over an in-memory store: real policy engine, real
 * expected-value engine, real executor, real agents, real audit chain. Only the outside
 * world is substituted, and even then by the same offline provider the demo mode uses.
 *
 * That matters. A suite that mocks the executor proves the mock works. These tests
 * exercise the actual pipeline, so a regression in idempotency or guardrail ordering
 * fails a test rather than reaching production.
 */

/** A small corpus. Big enough to be realistic, small enough to build in milliseconds. */
let cachedCorpus: GeneratedCorpus | null = null;
let cachedArtifact: ModelArtifact | null = null;

export function testCorpus(): GeneratedCorpus {
  cachedCorpus ??= generateCorpus({
    seed: 4242,
    merchantId: 'merch_test',
    customerCount: 220,
    paymentCount: 1_400,
    historyDays: 120,
    liveWindowDays: 10,
  });
  return cachedCorpus;
}

/**
 * A genuinely trained model over the test corpus. Training takes tens of milliseconds at
 * this size, so the agent and end-to-end tests exercise real predictions rather than a
 * stub — which is the only way a train/serve mismatch would ever be caught.
 */
export function testModel(): ModelArtifact | null {
  if (cachedArtifact) return cachedArtifact;
  const corpus = testCorpus();
  const examples = episodesToExamples(corpus.trainingEpisodes);
  if (examples.length < 60) return null;

  cachedArtifact = trainRecoveryModel(
    examples,
    { seed: 4242, version: 'test-model-v1', options: { epochs: 220 } },
    episodesToExamples(corpus.holdoutEpisodes),
  ).artifact;
  return cachedArtifact;
}

export interface Harness {
  engine: RecoveryEngine;
  store: DataStore;
  config: ReclaimConfig;
  merchantId: string;
  provider: DemoPaymentProvider;
  /** Advance nothing and wait for nothing: retry backoff is a no-op in tests. */
  sleep: (ms: number) => Promise<void>;
}

export interface HarnessOptions {
  /** Load the seeded corpus. Off by default so unit-ish tests start from a clean slate. */
  withCorpus?: boolean;
  /** Load the trained model. Off by default; the fallback prior is used instead. */
  withModel?: boolean;
  policy?: Partial<ReclaimConfig['policy']>;
  provider?: DemoPaymentProvider;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  // Faults are process-global by design (the failure lab arms one and the next request
  // must see it), so every test starts by clearing them.
  faultInjector.disarmAll();

  const config = defaultConfig({
    merchantId: 'merch_test',
    mode: 'demo',
    store: 'memory',
    policy: { ...defaultConfig().policy, ...options.policy },
  });

  const store = createMemoryStore();
  const provider = options.provider ?? new DemoPaymentProvider({ simulateLatency: false });

  const engine = new RecoveryEngine({
    config,
    store,
    modelArtifact: options.withModel ? testModel() : null,
    paymentProvider: provider,
    notificationProvider: new DemoNotificationProvider(),
    logger: noopLogger,
    // Backoff delays are real time; tests assert on behaviour, not on waiting.
    sleep: async () => {},
  });

  if (options.withCorpus) {
    const corpus = testCorpus();
    await store.merchants.put(corpus.merchant);
    await store.customers.putMany(corpus.customers);
    await store.payments.putMany(corpus.payments);
    await store.paymentAttempts.putMany(corpus.paymentAttempts);
    await store.subscriptions.putMany(corpus.subscriptions);
    await store.invoices.putMany(corpus.invoices);
    await store.checkoutSessions.putMany(corpus.checkoutSessions);
    await store.cases.putMany(corpus.historicalCases);
    await store.actions.putMany(corpus.historicalActions);
    await store.outcomes.putMany(corpus.historicalOutcomes);
  }

  return { engine, store, config, merchantId: config.merchantId, provider, sleep: async () => {} };
}

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                            */
/* -------------------------------------------------------------------------- */

let sequence = 0;

export interface CustomerFixtureOptions {
  successfulPayments?: number;
  failedPayments?: number;
  contactOptOut?: boolean;
  doNotRetry?: boolean;
  chargebackCount?: number;
  timezone?: string;
  preferredMethod?: PaymentMethod;
}

/** Create a customer with a real payment history behind them. */
export async function seedCustomer(
  harness: Harness,
  options: CustomerFixtureOptions = {},
): Promise<{ customerId: string }> {
  const index = sequence++;
  const customerId = seededId('cust_test', index, 5);
  const nowMs = Date.now();
  const successes = options.successfulPayments ?? 5;
  const failures = options.failedPayments ?? 1;
  const method = options.preferredMethod ?? 'card';

  await harness.store.customers.put({
    id: customerId,
    merchantId: harness.merchantId,
    name: `Test Customer ${index}`,
    email: `customer${index}@example.test`,
    phone: `+91980000${String(index).padStart(4, '0')}`,
    segment: 'growth',
    createdAt: new Date(nowMs - 400 * 86_400_000).toISOString(),
    lifetimeValueMinor: successes * 250_000,
    successfulPaymentCount: successes,
    failedPaymentCount: failures,
    priorRecoveryAttempts: 0,
    priorRecoverySuccesses: 0,
    lastSuccessfulPaymentAt: new Date(nowMs - 20 * 86_400_000).toISOString(),
    lastFailedPaymentAt: new Date(nowMs - 86_400_000).toISOString(),
    preferredMethod: method,
    contactPreference: 'email',
    contactOptOut: options.contactOptOut ?? false,
    doNotRetry: options.doNotRetry ?? false,
    chargebackCount: options.chargebackCount ?? 0,
    // Midday UTC keeps fixtures clear of quiet hours unless a test asks otherwise.
    timezone: options.timezone ?? 'UTC',
  });

  for (let i = 0; i < successes; i++) {
    await harness.store.payments.put({
      id: seededId(`pay_ok_${index}`, i, 4),
      merchantId: harness.merchantId,
      customerId,
      amountMinor: 250_000,
      currency: 'INR',
      method,
      issuer: 'HDFC Bank',
      network: 'Visa',
      status: 'captured',
      source: 'checkout',
      failureReason: null,
      errorCode: null,
      createdAt: new Date(nowMs - (60 - i * 5) * 86_400_000).toISOString(),
      capturedAt: new Date(nowMs - (60 - i * 5) * 86_400_000).toISOString(),
      subscriptionId: null,
      invoiceId: null,
      recoveryCaseId: null,
      idempotencyKey: idempotencyKeyFor({ fixture: customerId, i }),
      providerRef: null,
    });
  }

  return { customerId };
}

export interface CaseFixtureOptions {
  amountMinor?: number;
  failureReason?: FailureReason;
  method?: PaymentMethod;
  sourceType?: RecoveryCase['sourceType'];
  detectedAt?: string;
  customerId?: string;
  customer?: CustomerFixtureOptions;
  mandateActive?: boolean;
}

/**
 * Create a failed payment and the recovery case that ingestion would open for it.
 * Goes through the real ingestion path so the case is shaped exactly as production's is.
 */
export async function seedCase(
  harness: Harness,
  options: CaseFixtureOptions = {},
): Promise<{ caseId: string; customerId: string; payment: Payment }> {
  const customerId =
    options.customerId ?? (await seedCustomer(harness, options.customer ?? {})).customerId;

  const index = sequence++;
  const failureReason = options.failureReason ?? 'insufficient_funds';
  const method = options.method ?? 'card';
  const detectedAt = options.detectedAt ?? new Date().toISOString();

  const payment: Payment = {
    id: seededId('pay_fail', index, 5),
    merchantId: harness.merchantId,
    customerId,
    amountMinor: options.amountMinor ?? 499_900,
    currency: 'INR',
    method,
    issuer: 'HDFC Bank',
    network: 'Visa',
    status: 'failed',
    source: options.sourceType === 'subscription_dunning' ? 'subscription' : 'checkout',
    failureReason,
    errorCode: getFailureProfile(failureReason).errorCode,
    createdAt: detectedAt,
    capturedAt: null,
    subscriptionId: null,
    invoiceId: null,
    recoveryCaseId: null,
    idempotencyKey: idempotencyKeyFor({ fixture: 'fail', index }),
    providerRef: null,
  };

  if (options.sourceType === 'subscription_dunning' || options.mandateActive !== undefined) {
    const subscriptionId = seededId('sub_test', index, 5);
    await harness.store.subscriptions.put({
      id: subscriptionId,
      merchantId: harness.merchantId,
      customerId,
      planId: 'plan_growth_m',
      planName: 'Growth Monthly',
      planAmountMinor: payment.amountMinor,
      interval: 'monthly',
      status: 'past_due',
      startedAt: new Date(Date.now() - 300 * 86_400_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      completedCycles: 9,
      failedCycles: 1,
      method,
      mandateActive: options.mandateActive ?? true,
    });
    payment.subscriptionId = subscriptionId;
  }

  await harness.store.payments.put(payment);

  const subscription = payment.subscriptionId
    ? await harness.store.subscriptions.get(payment.subscriptionId)
    : null;

  const caseId = await harness.engine.ingestion.ingestPayment(payment, subscription);
  if (!caseId) throw new Error('ingestion did not open a case for the fixture payment');

  return { caseId, customerId, payment };
}

/** Force a case's recovery probability, so a test can pin the economics it exercises. */
export async function scoreCase(
  harness: Harness,
  caseId: string,
  probability: number,
  expectedValueMinor = 100_000,
): Promise<RecoveryCase> {
  return harness.engine.cases.recordPrediction(caseId, {
    probability,
    expectedValueMinor,
    isSubscriber: false,
    lifetimeValueMinor: 1_000_000,
    at: new Date().toISOString(),
  });
}

/** A provider that always succeeds, for tests about flow rather than about odds. */
export class AlwaysSucceedsProvider extends DemoPaymentProvider {
  constructor() {
    super({ simulateLatency: false, transientFailureRate: 0 });
  }
  override async retryPayment(request: Parameters<DemoPaymentProvider['retryPayment']>[0]) {
    return super.retryPayment({ ...request, successProbability: 1 });
  }
}

/** A provider that always declines, for fallback-chain tests. */
export class AlwaysDeclinesProvider extends DemoPaymentProvider {
  constructor() {
    super({ simulateLatency: false, transientFailureRate: 0 });
  }
  override async retryPayment(request: Parameters<DemoPaymentProvider['retryPayment']>[0]) {
    return super.retryPayment({ ...request, successProbability: 0 });
  }
}
