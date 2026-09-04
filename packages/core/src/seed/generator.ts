import { resolveCaseProfile } from '../domain/case-profiles.js';
import { failureReasonsForMethod, getFailureProfile } from '../domain/failure-taxonomy.js';
import type { RecoveryAction, RecoveryOutcome } from '../types/decisions.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Merchant,
  Payment,
  PaymentAttempt,
  RecoveryCase,
  Subscription,
  User,
} from '../types/entities.js';
import type {
  CustomerSegment,
  FailureReason,
  PaymentMethod,
  RecoveryStrategy,
} from '../types/enums.js';
import { clamp, round } from '../util/collections.js';
import { idempotencyKeyFor } from '../util/hash.js';
import { seededId } from '../util/id.js';
import { createRng, logNormalAmount, type Rng } from '../util/rng.js';
import { addDays, addHours, daysBetween, toIso } from '../util/time.js';
import {
  CARD_ISSUERS,
  CARD_NETWORKS,
  COMPANY_PREFIXES,
  COMPANY_SUFFIXES,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  LAST_NAMES,
  PLANS,
  TIMEZONES,
  UPI_HANDLES,
  WALLETS,
} from './catalog.js';

/**
 * THE SYNTHETIC CORPUS
 *
 * Ten thousand payments across five thousand customers, generated from a single seed so
 * the dataset is byte-identical on every machine that runs `npm run seed`.
 *
 * The generator is the most consequential file in the project, because every metric the
 * product reports is measured against what it produces. Three properties make those
 * metrics meaningful:
 *
 * 1. RELATIONSHIPS ARE REAL. A customer's segment drives their transaction sizes, which
 *    drive their plan, which drives their failure modes. A customer with a long
 *    successful history genuinely does recover better — not because the label was drawn
 *    that way, but because the latent process that produces the label reads the same
 *    history the model reads.
 *
 * 2. THE LABEL COMES FROM A LATENT PROCESS THE MODEL CANNOT SEE PERFECTLY. Recovery
 *    outcomes are drawn against a probability built from the taxonomy prior, customer
 *    history, relationship depth and instrument, plus per-customer and per-event noise
 *    the features do not expose. The model therefore learns a real but imperfect signal,
 *    which is why the reported AUC lands where a genuine model lands rather than at 0.99.
 *
 * 3. HISTORY IS CAUSALLY ORDERED. Features for a historical episode are computed from the
 *    customer's state *at that moment*, never from the finished corpus. Training on
 *    information that did not exist yet is the single easiest way to produce impressive
 *    and worthless metrics, and the generator is structured so it cannot happen.
 */

export interface GeneratorOptions {
  seed: number;
  merchantId: string;
  customerCount: number;
  paymentCount: number;
  /** Days of history to synthesise. */
  historyDays: number;
  /**
   * Failures inside this trailing window are left without a case, so ingestion has live
   * work to detect. Everything older is a closed historical episode with a known outcome.
   */
  liveWindowDays: number;
  /** Instant the corpus is generated "as of". Defaults to now. */
  nowIso: string;
  /**
   * Ceiling on training episodes. A cap keeps seeding fast at default size, but it must be
   * raisable: several analyses here slice outcomes several ways at once, and a hard ceiling
   * silently starves them of the sample they need no matter how many payments are asked
   * for. Null means "take the whole pool".
   */
  trainingEpisodeCap: number | null;
  /** Ceiling on held-out evaluation episodes. */
  holdoutEpisodeCap: number | null;
}

/**
 * Defaults exceed the 10,000-payment floor deliberately. Five thousand customers
 * transacting for eight months produce roughly 24,000 payments, and that volume is what
 * yields enough resolved recovery episodes (~3,000 train, ~700 held out) for the reported
 * model metrics to be stable rather than noise. A thinner corpus would still run, but the
 * confusion matrix would move materially between seeds, and metrics that move are metrics
 * that mean nothing.
 */
export const DEFAULT_GENERATOR_OPTIONS: Omit<GeneratorOptions, 'nowIso'> = {
  seed: 20260901,
  merchantId: 'merch_reclaim_demo',
  customerCount: 5_000,
  paymentCount: 24_000,
  historyDays: 240,
  liveWindowDays: 14,
  trainingEpisodeCap: 4_200,
  holdoutEpisodeCap: 900,
};

export interface GeneratedCorpus {
  merchant: Merchant;
  users: User[];
  customers: Customer[];
  payments: Payment[];
  paymentAttempts: PaymentAttempt[];
  subscriptions: Subscription[];
  invoices: Invoice[];
  checkoutSessions: CheckoutSession[];
  /** Closed historical recovery episodes; the source of the training labels. */
  historicalCases: RecoveryCase[];
  historicalActions: RecoveryAction[];
  historicalOutcomes: RecoveryOutcome[];
  /**
   * The labelled training rows, carrying the features as they were observable at the
   * moment each decision was made. Exposed directly rather than reconstructed from the
   * persisted cases, because the point-in-time view is the whole value of the dataset and
   * cannot be recovered from the finished records.
   */
  trainingEpisodes: RecoveryEpisode[];
  /** Episodes reserved for evaluation. Never written to the store, never trained on. */
  holdoutEpisodes: RecoveryEpisode[];
  stats: CorpusStats;
}

export interface CorpusStats {
  seed: number;
  generatedAt: string;
  historyFrom: string;
  historyTo: string;
  customers: number;
  payments: number;
  capturedPayments: number;
  failedPayments: number;
  failureRate: number;
  subscriptions: number;
  invoices: number;
  checkoutSessions: number;
  historicalEpisodes: number;
  historicalRecoveryRate: number;
  holdoutEpisodes: number;
  liveFailuresAwaitingDetection: number;
  grossCapturedMinor: number;
  grossFailedMinor: number;
}

/**
 * One completed recovery attempt from the past: the observable state at decision time,
 * the strategy that was tried, and whether the money actually came back.
 */
export interface RecoveryEpisode {
  caseId: string;
  customerId: string;
  paymentId: string;
  atIso: string;
  amountMinor: number;
  method: PaymentMethod;
  issuer: string;
  segment: CustomerSegment;
  failureReason: FailureReason;
  strategy: RecoveryStrategy;
  /** Observable-at-the-time features. */
  observed: {
    successCountBefore: number;
    failureCountBefore: number;
    lifetimeValueBeforeMinor: number;
    priorRecoveryAttempts: number;
    priorRecoverySuccesses: number;
    hoursSinceFailure: number;
    daysSinceLastSuccess: number | null;
    subscriptionAgeDays: number | null;
    isSubscriber: boolean;
    attemptNumber: number;
    hasAlternateSuccessfulMethod: boolean;
    isBusinessHours: boolean;
    bankDowntimeCluster: boolean;
  };
  /** The latent probability the outcome was drawn against. Diagnostic only. */
  latentProbability: number;
  recovered: boolean;
  interventionCostMinor: number;
}

/** Per-segment behavioural profile driving amounts, volumes and reliability. */
const SEGMENT_PROFILES: Record<
  CustomerSegment,
  {
    weight: number;
    medianAmountMinor: number;
    sigma: number;
    paymentsLambda: number;
    /** Baseline probability a given payment succeeds. */
    reliability: number;
    subscriptionChance: number;
    invoiceChance: number;
  }
> = {
  enterprise: {
    weight: 4,
    medianAmountMinor: 1_800_000,
    sigma: 0.85,
    paymentsLambda: 5.5,
    reliability: 0.94,
    subscriptionChance: 0.78,
    invoiceChance: 0.7,
  },
  growth: {
    weight: 12,
    medianAmountMinor: 420_000,
    sigma: 0.9,
    paymentsLambda: 3.8,
    reliability: 0.9,
    subscriptionChance: 0.6,
    invoiceChance: 0.4,
  },
  smb: {
    weight: 24,
    medianAmountMinor: 120_000,
    sigma: 0.95,
    paymentsLambda: 2.6,
    reliability: 0.86,
    subscriptionChance: 0.38,
    invoiceChance: 0.22,
  },
  consumer: {
    weight: 48,
    medianAmountMinor: 34_000,
    sigma: 1.05,
    paymentsLambda: 1.9,
    reliability: 0.83,
    subscriptionChance: 0.16,
    invoiceChance: 0.04,
  },
  trial: {
    weight: 12,
    medianAmountMinor: 19_900,
    sigma: 0.6,
    paymentsLambda: 1.2,
    reliability: 0.72,
    subscriptionChance: 0.3,
    invoiceChance: 0.02,
  },
};

const METHOD_WEIGHTS: ReadonlyArray<readonly [PaymentMethod, number]> = [
  ['upi', 42],
  ['card', 31],
  ['netbanking', 13],
  ['wallet', 7],
  ['emi', 4],
  ['nach', 3],
];

/** Bank outage windows: clustered failures that a naive engine misreads as declines. */
interface DowntimeWindow {
  issuer: string;
  fromIso: string;
  toIso: string;
}

export function generateCorpus(options: Partial<GeneratorOptions> = {}): GeneratedCorpus {
  const opts: GeneratorOptions = {
    ...DEFAULT_GENERATOR_OPTIONS,
    nowIso: new Date().toISOString(),
    ...options,
  };

  const rng = createRng(opts.seed);
  const historyFrom = addDays(opts.nowIso, -opts.historyDays);
  const liveFrom = addDays(opts.nowIso, -opts.liveWindowDays);

  const merchant = buildMerchant(opts);
  const users = buildUsers(opts, merchant);
  const downtimes = buildDowntimeWindows(rng, historyFrom, opts.nowIso);

  // ---- customers ----------------------------------------------------------
  const customers: Customer[] = [];
  const customerProfiles = new Map<string, CustomerProfile>();

  for (let i = 0; i < opts.customerCount; i++) {
    const { customer, profile } = buildCustomer(rng, opts, i, historyFrom);
    customers.push(customer);
    customerProfiles.set(customer.id, profile);
  }

  // ---- payments -----------------------------------------------------------
  // Volume is allocated across customers proportional to their segment's activity, then
  // trimmed or topped up so the corpus hits `paymentCount` exactly.
  const payments: Payment[] = [];
  const paymentAttempts: PaymentAttempt[] = [];
  const subscriptions: Subscription[] = [];
  const invoices: Invoice[] = [];
  const checkoutSessions: CheckoutSession[] = [];

  const allocation = allocatePayments(rng, customers, customerProfiles, opts.paymentCount);
  let paymentIndex = 0;
  let attemptIndex = 0;
  let subscriptionIndex = 0;
  let invoiceIndex = 0;
  let sessionIndex = 0;

  for (const customer of customers) {
    const profile = customerProfiles.get(customer.id)!;
    const count = allocation.get(customer.id) ?? 0;
    if (count === 0) continue;

    const segment = SEGMENT_PROFILES[customer.segment];

    // --- subscription (drives recurring payments) --------------------------
    let subscription: Subscription | null = null;
    if (rng.bool(segment.subscriptionChance)) {
      subscription = buildSubscription(rng, opts, customer, profile, subscriptionIndex++, historyFrom);
      subscriptions.push(subscription);
    }

    // --- payment timeline ---------------------------------------------------
    const timeline = buildPaymentTimeline(rng, opts, count, historyFrom, subscription);

    let successCount = 0;
    let failureCount = 0;
    let lifetimeValueMinor = 0;
    let lastSuccessAt: string | null = null;
    let lastFailedAt: string | null = null;
    const successfulMethods = new Set<PaymentMethod>();

    for (const slot of timeline) {
      const method = slot.method ?? pickMethod(rng, profile);
      const issuer = pickIssuer(rng, method);
      const amountMinor =
        slot.amountMinor ??
        logNormalAmount(rng, {
          median: segment.medianAmountMinor,
          sigma: segment.sigma,
          min: 5_000,
          max: 60_000_000,
        });

      const inDowntime = downtimes.some(
        (w) => w.issuer === issuer && slot.atIso >= w.fromIso && slot.atIso <= w.toIso,
      );

      const successProbability = paymentSuccessProbability({
        base: segment.reliability,
        reliabilityOffset: profile.reliabilityOffset,
        amountMinor,
        method,
        inDowntime,
        consecutiveFailures: countTrailingFailures(payments, customer.id),
      });

      const succeeded = rng.next() < successProbability;
      const failureReason = succeeded
        ? null
        : pickFailureReason(rng, method, inDowntime, amountMinor, profile);

      const payment: Payment = {
        id: seededId('pay', paymentIndex++, 7),
        merchantId: opts.merchantId,
        customerId: customer.id,
        amountMinor,
        currency: 'INR',
        method,
        issuer,
        network: method === 'card' || method === 'emi' ? rng.weighted(CARD_NETWORKS) : null,
        status: succeeded ? 'captured' : 'failed',
        source: slot.source,
        failureReason,
        errorCode: failureReason ? getFailureProfile(failureReason).errorCode : null,
        createdAt: slot.atIso,
        capturedAt: succeeded ? slot.atIso : null,
        subscriptionId: slot.subscriptionId,
        invoiceId: null,
        recoveryCaseId: null,
        idempotencyKey: idempotencyKeyFor({ customer: customer.id, at: slot.atIso, amountMinor }),
        providerRef: null,
      };
      payments.push(payment);

      paymentAttempts.push({
        id: seededId('att', attemptIndex++, 7),
        merchantId: opts.merchantId,
        paymentId: payment.id,
        customerId: customer.id,
        attemptNumber: 1,
        status: payment.status,
        failureReason,
        gatewayLatencyMs: succeeded ? rng.int(280, 2_400) : rng.int(600, 9_000),
        createdAt: slot.atIso,
        initiatedByRecovery: false,
      });

      if (succeeded) {
        successCount += 1;
        lifetimeValueMinor += amountMinor;
        lastSuccessAt = slot.atIso;
        successfulMethods.add(method);
      } else {
        failureCount += 1;
        lastFailedAt = slot.atIso;
      }
    }

    // --- invoices -----------------------------------------------------------
    if (rng.bool(segment.invoiceChance)) {
      const invoiceCount = rng.int(1, 3);
      for (let i = 0; i < invoiceCount; i++) {
        invoices.push(
          buildInvoice(rng, opts, customer, profile, invoiceIndex++, historyFrom, subscription),
        );
      }
    }

    // --- abandoned checkouts -------------------------------------------------
    if (rng.bool(0.22)) {
      checkoutSessions.push(
        buildCheckoutSession(rng, opts, customer, profile, sessionIndex++, historyFrom),
      );
    }

    // --- denormalised counters ------------------------------------------------
    const index = customers.findIndex((c) => c.id === customer.id);
    customers[index] = {
      ...customer,
      successfulPaymentCount: successCount,
      failedPaymentCount: failureCount,
      lifetimeValueMinor,
      lastSuccessfulPaymentAt: lastSuccessAt,
      lastFailedPaymentAt: lastFailedAt,
    };
  }

  payments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  // ---- historical recovery episodes ---------------------------------------
  const episodeResult = buildRecoveryEpisodes({
    rng: createRng(opts.seed + 977),
    opts,
    customers,
    customerProfiles,
    payments,
    subscriptions,
    downtimes,
    liveFrom,
  });

  // Update customers with their recovery history so graph features are populated.
  const recoveryStats = new Map<string, { attempts: number; successes: number }>();
  for (const episode of episodeResult.episodes) {
    const entry = recoveryStats.get(episode.customerId) ?? { attempts: 0, successes: 0 };
    entry.attempts += 1;
    if (episode.recovered) entry.successes += 1;
    recoveryStats.set(episode.customerId, entry);
  }
  for (let i = 0; i < customers.length; i++) {
    const stats = recoveryStats.get(customers[i]!.id);
    if (stats) {
      customers[i] = {
        ...customers[i]!,
        priorRecoveryAttempts: stats.attempts,
        priorRecoverySuccesses: stats.successes,
      };
    }
  }

  // ---- holdout ------------------------------------------------------------
  const holdout = buildRecoveryEpisodes({
    rng: createRng(opts.seed + 555_111),
    opts,
    customers,
    customerProfiles,
    payments,
    subscriptions,
    downtimes,
    liveFrom,
    // A distinct slice of the corpus, drawn with an independent generator, so the
    // evaluation set shares the world but not a single training row.
    holdoutMode: true,
  });

  const captured = payments.filter((p) => p.status === 'captured');
  const failed = payments.filter((p) => p.status === 'failed');
  const casedPaymentIds = new Set(episodeResult.cases.map((c) => c.sourceId));
  const liveFailures = failed.filter(
    (p) => p.createdAt >= liveFrom && !casedPaymentIds.has(p.id),
  );

  const stats: CorpusStats = {
    seed: opts.seed,
    generatedAt: opts.nowIso,
    historyFrom,
    historyTo: opts.nowIso,
    customers: customers.length,
    payments: payments.length,
    capturedPayments: captured.length,
    failedPayments: failed.length,
    failureRate: round(failed.length / Math.max(1, payments.length)),
    subscriptions: subscriptions.length,
    invoices: invoices.length,
    checkoutSessions: checkoutSessions.length,
    historicalEpisodes: episodeResult.episodes.length,
    historicalRecoveryRate: round(
      episodeResult.episodes.filter((e) => e.recovered).length /
        Math.max(1, episodeResult.episodes.length),
    ),
    holdoutEpisodes: holdout.episodes.length,
    liveFailuresAwaitingDetection: liveFailures.length,
    grossCapturedMinor: captured.reduce((s, p) => s + p.amountMinor, 0),
    grossFailedMinor: failed.reduce((s, p) => s + p.amountMinor, 0),
  };

  return {
    merchant,
    users,
    customers,
    payments,
    paymentAttempts,
    subscriptions,
    invoices,
    checkoutSessions,
    historicalCases: episodeResult.cases,
    historicalActions: episodeResult.actions,
    historicalOutcomes: episodeResult.outcomes,
    trainingEpisodes: episodeResult.episodes,
    holdoutEpisodes: holdout.episodes,
    stats,
  };
}

// ---------------------------------------------------------------------------
// customer construction
// ---------------------------------------------------------------------------

interface CustomerProfile {
  /** Persistent per-customer deviation from their segment's baseline reliability. */
  reliabilityOffset: number;
  /** Latent willingness to respond to a recovery prompt. Never observable by the model. */
  responsiveness: number;
  preferredMethod: PaymentMethod;
  planIndex: number;
  joinedAt: string;
}

function buildCustomer(
  rng: Rng,
  opts: GeneratorOptions,
  index: number,
  historyFrom: string,
): { customer: Customer; profile: CustomerProfile } {
  const segment = rng.weighted(
    (Object.entries(SEGMENT_PROFILES) as Array<[CustomerSegment, (typeof SEGMENT_PROFILES)[CustomerSegment]]>).map(
      ([key, value]) => [key, value.weight] as const,
    ),
  );

  const isBusiness = segment === 'enterprise' || segment === 'growth';
  const firstName = rng.pick(FIRST_NAMES);
  const lastName = rng.pick(LAST_NAMES);
  const name = isBusiness
    ? `${rng.pick(COMPANY_PREFIXES)} ${rng.pick(COMPANY_SUFFIXES)}`
    : `${firstName} ${lastName}`;

  const joinedAt = toIso(
    Date.parse(historyFrom) - rng.int(0, 540) * 86_400_000,
  );

  const preferredMethod = rng.weighted(METHOD_WEIGHTS);
  const emailLocal = `${firstName}.${lastName}${rng.int(1, 999)}`.toLowerCase();

  const customer: Customer = {
    id: seededId('cust', index, 6),
    merchantId: opts.merchantId,
    name,
    email: isBusiness
      ? `billing@${name.toLowerCase().replace(/\s+/g, '')}.example.in`
      : `${emailLocal}@${rng.weighted(EMAIL_DOMAINS)}`,
    phone: `+9198${rng.int(10_000_000, 99_999_999)}`,
    segment,
    createdAt: joinedAt,
    lifetimeValueMinor: 0,
    successfulPaymentCount: 0,
    failedPaymentCount: 0,
    priorRecoveryAttempts: 0,
    priorRecoverySuccesses: 0,
    lastSuccessfulPaymentAt: null,
    lastFailedPaymentAt: null,
    preferredMethod,
    contactPreference: rng.weighted<Customer['contactPreference']>([
      ['email', 58],
      ['sms', 22],
      ['whatsapp', 16],
      ['in_app', 4],
    ]),
    // Small but non-zero: the policy engine's hard gates need real cases to fire on.
    contactOptOut: rng.bool(0.05),
    doNotRetry: rng.bool(0.02),
    chargebackCount: rng.bool(0.04) ? rng.int(1, 4) : 0,
    timezone: rng.weighted(TIMEZONES),
  };

  return {
    customer,
    profile: {
      reliabilityOffset: clamp(rng.normal(0, 0.06), -0.22, 0.14),
      responsiveness: clamp(rng.normal(0.5, 0.2), 0.05, 0.95),
      preferredMethod,
      planIndex: rng.int(0, PLANS.length - 1),
      joinedAt,
    },
  };
}

function buildMerchant(opts: GeneratorOptions): Merchant {
  return {
    id: opts.merchantId,
    name: 'Kadamba Commerce',
    legalName: 'Kadamba Commerce Private Limited',
    mcc: '5817',
    currency: 'INR',
    createdAt: addDays(opts.nowIso, -900),
    policyOverrides: {},
  };
}

function buildUsers(opts: GeneratorOptions, merchant: Merchant): User[] {
  return [
    {
      id: 'user_owner_demo',
      merchantId: merchant.id,
      email: 'owner@kadamba.example.in',
      displayName: 'Revenue Operations Lead',
      role: 'owner',
      createdAt: merchant.createdAt,
    },
    {
      id: 'user_analyst_demo',
      merchantId: merchant.id,
      email: 'analyst@kadamba.example.in',
      displayName: 'Recovery Analyst',
      role: 'analyst',
      createdAt: addDays(opts.nowIso, -400),
    },
  ];
}

// ---------------------------------------------------------------------------
// payment timeline
// ---------------------------------------------------------------------------

interface PaymentSlot {
  atIso: string;
  source: Payment['source'];
  subscriptionId: string | null;
  amountMinor: number | null;
  method: PaymentMethod | null;
}

/**
 * Distribute the payment budget across customers. Enterprise accounts transact far more
 * than trial accounts, so a flat split would produce a corpus where segment carries no
 * information.
 */
function allocatePayments(
  rng: Rng,
  customers: readonly Customer[],
  profiles: ReadonlyMap<string, CustomerProfile>,
  total: number,
): Map<string, number> {
  const weights = customers.map((customer) => {
    const segment = SEGMENT_PROFILES[customer.segment];
    return Math.max(1, Math.round(rng.exponential(segment.paymentsLambda)));
  });
  const weightSum = weights.reduce((s, w) => s + w, 0);

  const allocation = new Map<string, number>();
  let assigned = 0;

  for (let i = 0; i < customers.length; i++) {
    const share = Math.floor((weights[i]! / weightSum) * total);
    const count = Math.max(1, share);
    allocation.set(customers[i]!.id, count);
    assigned += count;
  }

  // Trim or top up to land exactly on the requested total.
  const ids = customers.map((c) => c.id);
  while (assigned > total) {
    const id = ids[rng.int(0, ids.length - 1)]!;
    const current = allocation.get(id) ?? 0;
    if (current > 1) {
      allocation.set(id, current - 1);
      assigned -= 1;
    }
  }
  while (assigned < total) {
    const id = ids[rng.int(0, ids.length - 1)]!;
    allocation.set(id, (allocation.get(id) ?? 0) + 1);
    assigned += 1;
  }

  void profiles;
  return allocation;
}

function buildPaymentTimeline(
  rng: Rng,
  opts: GeneratorOptions,
  count: number,
  historyFrom: string,
  subscription: Subscription | null,
): PaymentSlot[] {
  const slots: PaymentSlot[] = [];
  const fromMs = Date.parse(historyFrom);
  const toMs = Date.parse(opts.nowIso);

  if (subscription) {
    // Recurring charges land on a regular cadence from the subscription start.
    const intervalDays =
      subscription.interval === 'monthly' ? 30 : subscription.interval === 'quarterly' ? 91 : 365;
    let cursor = Date.parse(subscription.startedAt);
    while (cursor <= toMs && slots.length < count) {
      if (cursor >= fromMs) {
        slots.push({
          atIso: toIso(cursor + rng.int(0, 6) * 3_600_000),
          source: 'subscription',
          subscriptionId: subscription.id,
          amountMinor: subscription.planAmountMinor,
          method: subscription.method,
        });
      }
      cursor += intervalDays * 86_400_000;
    }
  }

  // Remaining volume is one-off checkout activity, weighted toward the recent past so the
  // live window has enough material for detection to work on.
  while (slots.length < count) {
    const skew = Math.pow(rng.next(), 0.75);
    const atMs = fromMs + skew * (toMs - fromMs);
    slots.push({
      atIso: toIso(atMs),
      source: 'checkout',
      subscriptionId: null,
      amountMinor: null,
      method: null,
    });
  }

  return slots.sort((a, b) => (a.atIso < b.atIso ? -1 : 1));
}

function pickMethod(rng: Rng, profile: CustomerProfile): PaymentMethod {
  // Customers mostly reuse their preferred instrument, occasionally trying another.
  return rng.bool(0.72) ? profile.preferredMethod : rng.weighted(METHOD_WEIGHTS);
}

function pickIssuer(rng: Rng, method: PaymentMethod): string {
  switch (method) {
    case 'upi':
      return rng.weighted(UPI_HANDLES);
    case 'wallet':
      return rng.weighted(WALLETS);
    default:
      return rng.weighted(CARD_ISSUERS);
  }
}

/**
 * Probability a payment succeeds. Larger amounts fail more (limits, risk rules), a bank
 * outage dominates everything, and a customer already in a failure streak keeps failing.
 */
function paymentSuccessProbability(input: {
  base: number;
  reliabilityOffset: number;
  amountMinor: number;
  method: PaymentMethod;
  inDowntime: boolean;
  consecutiveFailures: number;
}): number {
  if (input.inDowntime) return 0.12;

  const amountPenalty = clamp(Math.log10(input.amountMinor / 100_000 + 1) * 0.045, 0, 0.14);
  const methodAdjustment =
    input.method === 'upi' ? 0.02 : input.method === 'nach' ? -0.06 : input.method === 'emi' ? -0.04 : 0;
  const streakPenalty = clamp(input.consecutiveFailures * 0.07, 0, 0.25);

  return clamp(
    input.base + input.reliabilityOffset + methodAdjustment - amountPenalty - streakPenalty,
    0.25,
    0.985,
  );
}

function countTrailingFailures(payments: readonly Payment[], customerId: string): number {
  let count = 0;
  for (let i = payments.length - 1; i >= 0; i--) {
    const payment = payments[i]!;
    if (payment.customerId !== customerId) continue;
    if (payment.status === 'failed') count += 1;
    else break;
  }
  return count;
}

function pickFailureReason(
  rng: Rng,
  method: PaymentMethod,
  inDowntime: boolean,
  amountMinor: number,
  profile: CustomerProfile,
): FailureReason {
  if (inDowntime) return 'bank_downtime';

  const candidates = failureReasonsForMethod(method);
  const weighted = candidates.map((candidate) => {
    let weight = 10;
    // Funding failures dominate at small amounts; limits and risk at large ones.
    if (candidate.category === 'funding') weight += amountMinor < 200_000 ? 14 : 4;
    if (candidate.reason === 'daily_limit_exceeded') weight += amountMinor > 2_000_000 ? 12 : 1;
    if (candidate.category === 'risk') weight += amountMinor > 1_000_000 ? 9 : 2;
    if (candidate.category === 'infrastructure') weight += 8;
    if (candidate.category === 'instrument') weight += profile.reliabilityOffset < -0.05 ? 8 : 3;
    if (candidate.reason === 'mandate_revoked') weight = method === 'nach' ? 9 : 1;
    return [candidate.reason, weight] as const;
  });

  return rng.weighted(weighted);
}

// ---------------------------------------------------------------------------
// subscriptions, invoices, checkout sessions
// ---------------------------------------------------------------------------

function buildSubscription(
  rng: Rng,
  opts: GeneratorOptions,
  customer: Customer,
  profile: CustomerProfile,
  index: number,
  historyFrom: string,
): Subscription {
  // Plan choice tracks segment: enterprises do not buy the ₹199 tier.
  const affordable = PLANS.filter((plan) => {
    const median = SEGMENT_PROFILES[customer.segment].medianAmountMinor;
    return plan.amountMinor <= median * 6 && plan.amountMinor >= median / 12;
  });
  const plan = affordable.length > 0
    ? rng.weighted(affordable.map((p) => [p, p.weight] as const))
    : PLANS[profile.planIndex]!;

  const startedAt = toIso(
    Math.max(
      Date.parse(customer.createdAt),
      Date.parse(historyFrom) - rng.int(0, 400) * 86_400_000,
    ),
  );
  const intervalDays = plan.interval === 'monthly' ? 30 : plan.interval === 'quarterly' ? 91 : 365;
  const completedCycles = Math.max(
    0,
    Math.floor(daysBetween(startedAt, opts.nowIso) / intervalDays),
  );
  const failedCycles = rng.bool(0.24) ? rng.int(1, 3) : 0;

  const status = rng.weighted<Subscription['status']>([
    ['active', 74],
    ['past_due', 12],
    ['cancelled', 9],
    ['paused', 3],
    ['completed', 2],
  ]);

  return {
    id: seededId('sub', index, 6),
    merchantId: opts.merchantId,
    customerId: customer.id,
    planId: plan.id,
    planName: plan.name,
    planAmountMinor: plan.amountMinor,
    interval: plan.interval,
    status,
    startedAt,
    currentPeriodEnd: addDays(opts.nowIso, rng.int(1, intervalDays)),
    completedCycles,
    failedCycles,
    method: rng.bool(0.55) ? 'card' : rng.bool(0.6) ? 'upi' : 'nach',
    // A revoked mandate is what makes retries structurally impossible; it must occur.
    mandateActive: status === 'cancelled' ? false : !rng.bool(0.07),
  };
}

function buildInvoice(
  rng: Rng,
  opts: GeneratorOptions,
  customer: Customer,
  profile: CustomerProfile,
  index: number,
  historyFrom: string,
  subscription: Subscription | null,
): Invoice {
  const segment = SEGMENT_PROFILES[customer.segment];
  const amountMinor = logNormalAmount(rng, {
    median: segment.medianAmountMinor * 1.4,
    sigma: 0.7,
    min: 20_000,
    max: 80_000_000,
  });

  const issuedAt = toIso(
    Date.parse(historyFrom) + rng.next() * (Date.parse(opts.nowIso) - Date.parse(historyFrom)),
  );
  const dueAt = addDays(issuedAt, rng.pick([7, 14, 30, 45]));
  const isPastDue = Date.parse(dueAt) < Date.parse(opts.nowIso);

  const status = !isPastDue
    ? 'open'
    : rng.weighted<Invoice['status']>([
        ['paid', 62],
        ['overdue', 30],
        ['written_off', 8],
      ]);

  void profile;
  return {
    id: seededId('inv', index, 6),
    merchantId: opts.merchantId,
    customerId: customer.id,
    number: `INV-${String(index + 1).padStart(6, '0')}`,
    amountMinor,
    status,
    issuedAt,
    dueAt,
    paidAt: status === 'paid' ? addDays(dueAt, -rng.int(0, 5)) : null,
    subscriptionId: subscription?.id ?? null,
  };
}

function buildCheckoutSession(
  rng: Rng,
  opts: GeneratorOptions,
  customer: Customer,
  profile: CustomerProfile,
  index: number,
  historyFrom: string,
): CheckoutSession {
  const segment = SEGMENT_PROFILES[customer.segment];
  const cartValueMinor = logNormalAmount(rng, {
    median: segment.medianAmountMinor,
    sigma: 0.9,
    min: 9_900,
    max: 20_000_000,
  });

  const startedAt = toIso(
    Date.parse(historyFrom) + rng.next() * (Date.parse(opts.nowIso) - Date.parse(historyFrom)),
  );

  const stage = rng.weighted<CheckoutSession['stage']>([
    ['cart', 38],
    ['contact', 24],
    ['method_selected', 24],
    ['otp_pending', 14],
  ]);

  return {
    id: seededId('chk', index, 6),
    merchantId: opts.merchantId,
    customerId: customer.id,
    cartValueMinor,
    stage,
    method: stage === 'cart' || stage === 'contact' ? null : profile.preferredMethod,
    startedAt,
    abandonedAt: addHours(startedAt, rng.next() * 0.4),
    // Some abandoned carts convert on their own; those are not revenue at risk.
    convertedPaymentId: rng.bool(0.18) ? `pay_organic_${index}` : null,
  };
}

function buildDowntimeWindows(rng: Rng, fromIso: string, toIso_: string): DowntimeWindow[] {
  const windows: DowntimeWindow[] = [];
  const count = rng.int(6, 12);
  const fromMs = Date.parse(fromIso);
  const span = Date.parse(toIso_) - fromMs;

  for (let i = 0; i < count; i++) {
    const issuer = rng.weighted(CARD_ISSUERS);
    const startMs = fromMs + rng.next() * span;
    const durationHours = rng.int(2, 14);
    windows.push({
      issuer,
      fromIso: toIso(startMs),
      toIso: toIso(startMs + durationHours * 3_600_000),
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// historical recovery episodes — the labelled training signal
// ---------------------------------------------------------------------------

interface EpisodeBuildInput {
  rng: Rng;
  opts: GeneratorOptions;
  customers: readonly Customer[];
  customerProfiles: ReadonlyMap<string, CustomerProfile>;
  payments: readonly Payment[];
  subscriptions: readonly Subscription[];
  downtimes: readonly DowntimeWindow[];
  liveFrom: string;
  holdoutMode?: boolean;
}

interface EpisodeBuildResult {
  episodes: RecoveryEpisode[];
  cases: RecoveryCase[];
  actions: RecoveryAction[];
  outcomes: RecoveryOutcome[];
}

/**
 * The latent recovery process.
 *
 * This is the ground truth the model is trying to learn. It reads the taxonomy prior, the
 * customer's observable history, and the strategy chosen — and then adds two sources of
 * noise the model can never observe: the customer's latent responsiveness, and a
 * per-event shock. Those unobservables are what stop the model from reaching an
 * unrealistic AUC, and what make the reported metrics believable.
 */
/**
 * Liquidity across the month, as a multiplier on the log-odds of recovering a
 * funds-related decline.
 *
 * Peak just after payday (1st-4th), a secondary bump mid-month for the sizeable share of
 * salaries paid then, and a trough in the last week when balances are thinnest. Returns
 * roughly -1..+1.
 */
function payCycleLift(dayOfMonth: number): number {
  const day = Math.min(31, Math.max(1, Math.round(dayOfMonth)));
  if (day <= 4) return 1;
  if (day <= 7) return 0.6;
  if (day <= 12) return 0.1;
  if (day <= 17) return 0.35;
  if (day <= 22) return -0.2;
  if (day <= 26) return -0.65;
  return -1;
}

function latentRecoveryProbability(input: {
  profileRecoverability: number;
  strategyLift: number;
  successRatio: number;
  successCount: number;
  priorRecoveryRate: number | null;
  isSubscriber: boolean;
  subscriptionAgeDays: number | null;
  hasAlternateMethod: boolean;
  amountMinor: number;
  hoursSinceFailure: number;
  attemptNumber: number;
  responsiveness: number;
  shock: number;
  /** Day of month (1-31) the retry would land on. Drives the liquidity cycle below. */
  retryDayOfMonth: number;
  /** True for failures that are a liquidity problem rather than a technical one. */
  liquidityBound: boolean;
}): number {
  // Work in log-odds so the contributions compose sensibly.
  let logit = Math.log(
    clamp(input.profileRecoverability, 0.02, 0.98) / (1 - clamp(input.profileRecoverability, 0.02, 0.98)),
  );

  // Relationship depth. These coefficients are sized so that customer history carries
  // roughly the same weight as failure class — which is the product's central claim, and
  // is what real dunning data shows: a customer with eight successful payments behind
  // them recovers at a materially different rate to a first-timer with the same decline.
  logit += 2.6 * (input.successRatio - 0.5);
  logit += 0.45 * Math.log1p(input.successCount);
  if (input.priorRecoveryRate !== null) logit += 1.8 * (input.priorRecoveryRate - 0.5);
  if (input.isSubscriber) logit += 0.55;
  if (input.subscriptionAgeDays !== null) logit += 0.45 * Math.min(1, input.subscriptionAgeDays / 365);
  if (input.hasAlternateMethod) logit += 0.75;

  // Large amounts are harder to recover; time and repeated attempts erode the odds.
  logit -= 0.35 * Math.log10(input.amountMinor / 100_000 + 1);
  logit -= 0.012 * Math.min(input.hoursSinceFailure, 168);
  logit -= 0.46 * Math.max(0, input.attemptNumber - 1);

  // SALARY-CYCLE LIQUIDITY.
  //
  // A decline for insufficient funds is not a statement about the customer, it is a
  // statement about their balance on one particular day. In India salaries land at the
  // start of the month, so the same customer who cannot pay on the 28th very often can on
  // the 2nd. Modelling this makes the corpus more realistic, not less: it is one of the
  // strongest and best-documented effects in subscription dunning.
  //
  // It applies ONLY to liquidity-bound failures. An expired card does not start working
  // because payday arrived, and letting the cycle leak into technical declines would teach
  // the timing engine a relationship that does not exist.
  //
  // Note for anyone reading the Timing page: this effect is PUT INTO the synthetic world
  // here, deliberately. The timing engine is never told about it and rediscovers it from
  // outcomes alone — which is how we validate that the engine works, not a claim to have
  // discovered something about real payments.
  if (input.liquidityBound) {
    logit += 0.95 * payCycleLift(input.retryDayOfMonth);
  }

  // Unobservable to the model, by design.
  logit += 1.5 * (input.responsiveness - 0.5);
  logit += input.shock;

  const base = 1 / (1 + Math.exp(-logit));
  return clamp(base * input.strategyLift, 0.01, 0.97);
}

function buildRecoveryEpisodes(input: EpisodeBuildInput): EpisodeBuildResult {
  const { rng, opts, customers, customerProfiles, payments, subscriptions, downtimes } = input;

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const subscriptionByCustomer = new Map<string, Subscription>();
  for (const subscription of subscriptions) {
    if (!subscriptionByCustomer.has(subscription.customerId)) {
      subscriptionByCustomer.set(subscription.customerId, subscription);
    }
  }

  // Only historical failures (outside the live window) become closed episodes; the live
  // window is left untouched so ingestion has genuine work to detect.
  const eligible = payments.filter(
    (p) => p.status === 'failed' && p.failureReason !== null && p.createdAt < input.liveFrom,
  );

  // Partition the eligible failures into disjoint training and holdout pools using a
  // FIXED shuffle, so the two sets never share a payment.
  //
  // The partition is random rather than chronological on purpose. A temporal split would
  // put the earliest failures in the holdout, and those customers have barely any payment
  // history yet — so the evaluation set would systematically lack the relational signal
  // the model relies on, and would understate the model for a reason that has nothing to
  // do with the model. Disjoint payments give a clean read; the temporal question is a
  // separate experiment.
  const partitioned = createRng(20260901 + 31).shuffle([...eligible]);
  const holdoutSize = Math.floor(partitioned.length * 0.18);
  const pool = input.holdoutMode
    ? partitioned.slice(0, holdoutSize)
    : partitioned.slice(holdoutSize);

  const cap = input.holdoutMode ? input.opts.holdoutEpisodeCap : input.opts.trainingEpisodeCap;
  const targetCount = cap === null ? pool.length : Math.min(cap, pool.length);

  const selected = rng.shuffle([...pool]).slice(0, targetCount);
  selected.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const episodes: RecoveryEpisode[] = [];
  const cases: RecoveryCase[] = [];
  const actions: RecoveryAction[] = [];
  const outcomes: RecoveryOutcome[] = [];

  // Running per-customer state, advanced in chronological order so every episode sees
  // only what was knowable when it happened.
  const state = new Map<
    string,
    {
      successCount: number;
      failureCount: number;
      lifetimeValueMinor: number;
      lastSuccessAt: string | null;
      recoveryAttempts: number;
      recoverySuccesses: number;
      successfulMethods: Set<PaymentMethod>;
      attemptsOnCase: number;
    }
  >();

  const ensureState = (customerId: string) => {
    let entry = state.get(customerId);
    if (!entry) {
      entry = {
        successCount: 0,
        failureCount: 0,
        lifetimeValueMinor: 0,
        lastSuccessAt: null,
        recoveryAttempts: 0,
        recoverySuccesses: 0,
        successfulMethods: new Set<PaymentMethod>(),
        attemptsOnCase: 0,
      };
      state.set(customerId, entry);
    }
    return entry;
  };

  // Walk the whole payment history in order, updating state, and emit an episode when we
  // reach a selected failure. This is what guarantees causal ordering.
  const selectedIds = new Set(selected.map((p) => p.id));
  let episodeIndex = input.holdoutMode ? 900_000 : 0;

  for (const payment of payments) {
    const entry = ensureState(payment.customerId);

    if (payment.status === 'captured') {
      entry.successCount += 1;
      entry.lifetimeValueMinor += payment.amountMinor;
      entry.lastSuccessAt = payment.createdAt;
      entry.successfulMethods.add(payment.method);
      continue;
    }

    entry.failureCount += 1;
    if (!selectedIds.has(payment.id) || payment.failureReason === null) continue;

    const customer = customerById.get(payment.customerId);
    const profile = customerProfiles.get(payment.customerId);
    if (!customer || !profile) continue;

    const subscription = subscriptionByCustomer.get(payment.customerId) ?? null;
    const failureProfile = getFailureProfile(payment.failureReason);
    const caseProfile = resolveCaseProfile({
      sourceType: payment.subscriptionId ? 'subscription_dunning' : 'payment_failure',
      failureReason: payment.failureReason,
    });

    // Which strategy was tried, historically. Retries are preferred where structurally
    // possible; otherwise a link or a message. This mirrors what the live engine does,
    // so the training distribution matches the serving distribution.
    const strategy: RecoveryStrategy = !failureProfile.retryPossible
      ? rng.bool(0.62)
        ? 'payment_link'
        : 'customer_notification'
      : rng.bool(0.68)
        ? 'delayed_retry'
        : rng.bool(0.5)
          ? 'immediate_retry'
          : 'payment_link';

    // How long the loss sat before anyone looked at it. Drawn independently of the
    // strategy: at serving time this feature is "elapsed time since detection", so
    // deriving it from the chosen strategy would leak the decision into its own input
    // and produce a feature that means something different in training than in
    // production. That skew is invisible in offline metrics and fatal in the live system.
    const detectionDelayHours = clamp(rng.exponential(3), 0.05, 72);
    // The wait the strategy itself adds. This affects the OUTCOME but is not observable
    // as a feature at decision time, so it feeds the latent process only.
    const strategyDelayHours =
      strategy === 'delayed_retry'
        ? failureProfile.optimalDelayHours + rng.next() * 6
        : strategy === 'immediate_retry'
          ? 0
          : rng.next() * 4;

    const hoursSinceFailure = detectionDelayHours;
    const decisionAtIso = addHours(payment.createdAt, detectionDelayHours);

    // Not every episode is a first attempt. Roughly a third of cases in a real dunning
    // book are already on their second or third try, and the diminishing return on
    // repeated attempts is one of the things the model needs to learn — a feature that
    // never varies teaches it nothing.
    const attemptNumber = rng.weighted<number>([
      [1, 68],
      [2, 21],
      [3, 11],
    ]);
    const localHour = new Date(Date.parse(decisionAtIso)).getUTCHours();

    const inDowntime = downtimes.some(
      (w) => w.issuer === payment.issuer && payment.createdAt >= w.fromIso && payment.createdAt <= w.toIso,
    );

    const successRatio =
      (entry.successCount + 1) / (entry.successCount + entry.failureCount + 2);
    const priorRecoveryRate =
      entry.recoveryAttempts === 0 ? null : entry.recoverySuccesses / entry.recoveryAttempts;

    const subscriptionAgeDays = subscription
      ? Math.max(0, daysBetween(subscription.startedAt, payment.createdAt))
      : null;

    const hasAlternateMethod = [...entry.successfulMethods].some((m) => m !== payment.method);

    const latentProbability = latentRecoveryProbability({
      profileRecoverability: caseProfile.baseRecoverability,
      strategyLift: caseProfile.strategyLift[strategy] ?? 0.5,
      successRatio,
      successCount: entry.successCount,
      priorRecoveryRate,
      isSubscriber: subscription !== null && subscription.status === 'active',
      subscriptionAgeDays,
      hasAlternateMethod,
      amountMinor: payment.amountMinor,
      hoursSinceFailure: detectionDelayHours + strategyDelayHours,
      // The day the retry actually lands on, not the day the payment failed. A retry
      // deferred over a month boundary is the whole point of the effect.
      retryDayOfMonth: new Date(
        Date.parse(addHours(payment.createdAt, detectionDelayHours + strategyDelayHours)),
      ).getUTCDate(),
      liquidityBound:
        payment.failureReason === 'insufficient_funds' ||
        payment.failureReason === 'wallet_insufficient_balance' ||
        payment.failureReason === 'daily_limit_exceeded',
      attemptNumber,
      responsiveness: profile.responsiveness,
      shock: rng.normal(0, 0.45),
    });

    const recovered = rng.next() < latentProbability;
    const interventionCostMinor =
      strategy === 'payment_link' ? 2_100 : strategy === 'customer_notification' ? 1_250 : 250;

    const episode: RecoveryEpisode = {
      caseId: seededId(input.holdoutMode ? 'hcase' : 'case', episodeIndex, 6),
      customerId: customer.id,
      paymentId: payment.id,
      atIso: decisionAtIso,
      amountMinor: payment.amountMinor,
      method: payment.method,
      issuer: payment.issuer,
      segment: customer.segment,
      failureReason: payment.failureReason,
      strategy,
      observed: {
        successCountBefore: entry.successCount,
        failureCountBefore: entry.failureCount,
        lifetimeValueBeforeMinor: entry.lifetimeValueMinor,
        priorRecoveryAttempts: entry.recoveryAttempts,
        priorRecoverySuccesses: entry.recoverySuccesses,
        hoursSinceFailure: round(hoursSinceFailure, 2),
        daysSinceLastSuccess: entry.lastSuccessAt
          ? round(daysBetween(entry.lastSuccessAt, payment.createdAt), 2)
          : null,
        subscriptionAgeDays: subscriptionAgeDays === null ? null : round(subscriptionAgeDays, 1),
        isSubscriber: subscription !== null && subscription.status === 'active',
        attemptNumber,
        hasAlternateSuccessfulMethod: hasAlternateMethod,
        isBusinessHours: localHour >= 9 && localHour < 19,
        bankDowntimeCluster: inDowntime,
      },
      latentProbability: round(latentProbability, 4),
      recovered,
      interventionCostMinor,
    };
    episodes.push(episode);

    entry.recoveryAttempts += 1;
    if (recovered) {
      entry.recoverySuccesses += 1;
      entry.successCount += 1;
      entry.lifetimeValueMinor += payment.amountMinor;
      entry.lastSuccessAt = decisionAtIso;
      entry.successfulMethods.add(payment.method);
    }

    // Holdout episodes exist only as evaluation rows; they are never persisted, so they
    // cannot leak into the application's own history or its graph features.
    if (!input.holdoutMode) {
      const record = buildEpisodeRecords(episode, opts, payment, episodeIndex);
      cases.push(record.recoveryCase);
      actions.push(record.action);
      outcomes.push(record.outcome);
    }

    episodeIndex += 1;
  }

  return { episodes, cases, actions, outcomes };
}

function buildEpisodeRecords(
  episode: RecoveryEpisode,
  opts: GeneratorOptions,
  payment: Payment,
  index: number,
): { recoveryCase: RecoveryCase; action: RecoveryAction; outcome: RecoveryOutcome } {
  const resolvedAt = addHours(episode.atIso, episode.recovered ? 0.2 : 4);
  const status = episode.recovered ? 'recovered' : 'unrecoverable';

  const recoveryCase: RecoveryCase = {
    id: episode.caseId,
    merchantId: opts.merchantId,
    customerId: episode.customerId,
    sourceType: payment.subscriptionId ? 'subscription_dunning' : 'payment_failure',
    sourceId: payment.id,
    amountAtRiskMinor: episode.amountMinor,
    currency: 'INR',
    status,
    failureReason: episode.failureReason,
    method: episode.method,
    recoveryProbability: episode.latentProbability,
    expectedValueMinor: Math.round(
      episode.amountMinor * episode.latentProbability - episode.interventionCostMinor,
    ),
    priorityScore: round((episode.amountMinor / 100) * episode.latentProbability, 2),
    selectedStrategy: episode.strategy,
    attemptCount: episode.strategy.includes('retry') ? 1 : 0,
    notificationCount: episode.strategy === 'customer_notification' || episode.strategy === 'payment_link' ? 1 : 0,
    recoveredAmountMinor: episode.recovered ? episode.amountMinor : 0,
    detectedAt: payment.createdAt,
    updatedAt: resolvedAt,
    lastActionAt: episode.atIso,
    cooldownUntil: null,
    resolvedAt,
    escalationReason: null,
    timeline: [
      {
        at: payment.createdAt,
        kind: 'detected',
        summary: `Payment of ${(episode.amountMinor / 100).toFixed(0)} INR failed: ${getFailureProfile(episode.failureReason).label}.`,
        refId: payment.id,
        amountMinor: episode.amountMinor,
      },
      {
        at: episode.atIso,
        kind: 'action_executed',
        summary: `${episode.strategy.replace(/_/g, ' ')} executed.`,
        refId: null,
        amountMinor: null,
      },
      {
        at: resolvedAt,
        kind: 'outcome_recorded',
        summary: episode.recovered
          ? `Recovered ${(episode.amountMinor / 100).toFixed(0)} INR.`
          : 'Not recovered; case closed.',
        refId: null,
        amountMinor: episode.recovered ? episode.amountMinor : 0,
      },
    ],
  };

  const action: RecoveryAction = {
    id: seededId('hact', index, 6),
    merchantId: opts.merchantId,
    caseId: episode.caseId,
    customerId: episode.customerId,
    strategy: episode.strategy,
    amountMinor: episode.amountMinor,
    status: 'succeeded',
    idempotencyKey: idempotencyKeyFor({ historical: episode.caseId, strategy: episode.strategy }),
    aiDecisionId: null,
    policyDecisionId: null,
    providerRef: `hist_${index}`,
    providerMode: 'demo',
    attempts: 1,
    error: null,
    errorCode: null,
    fallbackOfActionId: null,
    scheduledFor: null,
    createdAt: episode.atIso,
    completedAt: episode.atIso,
    durationMs: 420,
  };

  const outcome: RecoveryOutcome = {
    id: seededId('hout', index, 6),
    merchantId: opts.merchantId,
    caseId: episode.caseId,
    actionId: action.id,
    outcome: episode.recovered ? 'recovered' : 'action_failed',
    recoveredAmountMinor: episode.recovered ? episode.amountMinor : 0,
    amountAtRiskMinor: episode.amountMinor,
    strategy: episode.strategy,
    predictedProbability: episode.latentProbability,
    timeToOutcomeMs: Math.max(0, Date.parse(resolvedAt) - Date.parse(payment.createdAt)),
    recordedAt: resolvedAt,
  };

  return { recoveryCase, action, outcome };
}
