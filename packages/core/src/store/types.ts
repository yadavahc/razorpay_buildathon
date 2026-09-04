import type {
  AIDecision,
  AuditLog,
  IdempotencyRecord,
  PolicyDecision,
  RecoveryAction,
  RecoveryOutcome,
} from '../types/decisions.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Merchant,
  Notification,
  Payment,
  PaymentAttempt,
  PaymentLink,
  RecoveryCase,
  Subscription,
  User,
} from '../types/entities.js';
import type { ActionStatus } from '../types/enums.js';

/**
 * The persistence contract.
 *
 * Two implementations satisfy it: an in-process store backed by the seeded corpus, and
 * Cloud Firestore via the Admin SDK. Every service in the system talks to this interface
 * and nothing else, which is what lets the whole application — including the agent loop,
 * the executor and the audit chain — run in a unit test with no emulator, and run
 * unchanged against a real Firestore project in deployment.
 *
 * The query surface is deliberately narrow. It is exactly what Firestore can serve
 * efficiently with composite indexes, so no query that works in memory can quietly
 * become a full-collection scan in production.
 */

export type ComparisonOperator = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';

export interface QueryFilter {
  field: string;
  op: ComparisonOperator;
  value: unknown;
}

export interface QuerySpec {
  where?: QueryFilter[];
  orderBy?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
  /** Opaque continuation token returned by the previous page. */
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  /** Null when the result set is exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Repository<T extends { id: string }> {
  readonly name: string;
  get(id: string): Promise<T | null>;
  getMany(ids: readonly string[]): Promise<T[]>;
  put(doc: T): Promise<T>;
  putMany(docs: readonly T[]): Promise<number>;
  /** Partial update. Throws NOT_FOUND if the document does not exist. */
  patch(id: string, changes: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  query(spec?: QuerySpec): Promise<Page<T>>;
  /** Convenience for the analytics layer; returns every document in the collection. */
  list(spec?: QuerySpec): Promise<T[]>;
  count(spec?: QuerySpec): Promise<number>;
  clear(): Promise<void>;
}

/** Result of attempting to reserve an idempotency key before a side effect. */
export interface IdempotencyClaim {
  claimed: boolean;
  record: IdempotencyRecord;
}

export interface AuditInput {
  merchantId: string;
  actor: AuditLog['actor'];
  event: string;
  trigger: string;
  caseId?: string | null;
  customerId?: string | null;
  amountMinor?: number | null;
  aiDecisionId?: string | null;
  policyDecisionId?: string | null;
  actionId?: string | null;
  actionStatus?: AuditLog['actionStatus'];
  failure?: string | null;
  fallback?: string | null;
  finalOutcome?: AuditLog['finalOutcome'];
  metadata?: AuditLog['metadata'];
  at?: string;
}

export interface DataStore {
  readonly kind: 'memory' | 'firestore';

  merchants: Repository<Merchant>;
  users: Repository<User>;
  customers: Repository<Customer>;
  payments: Repository<Payment>;
  paymentAttempts: Repository<PaymentAttempt>;
  subscriptions: Repository<Subscription>;
  invoices: Repository<Invoice>;
  checkoutSessions: Repository<CheckoutSession>;
  cases: Repository<RecoveryCase>;
  actions: Repository<RecoveryAction>;
  outcomes: Repository<RecoveryOutcome>;
  aiDecisions: Repository<AIDecision>;
  policyDecisions: Repository<PolicyDecision>;
  auditLogs: Repository<AuditLog>;
  notifications: Repository<Notification>;
  paymentLinks: Repository<PaymentLink>;

  /**
   * Atomically reserve an idempotency key. Returns `claimed: false` together with the
   * existing record when the key has already been used, which is the single mechanism
   * preventing duplicate financial side effects across the whole system.
   */
  claimIdempotency(input: {
    key: string;
    merchantId: string;
    scope: string;
    actionId: string;
  }): Promise<IdempotencyClaim>;

  /** Record the terminal status of a claimed key so replays return the original result. */
  settleIdempotency(key: string, status: ActionStatus, resultRef: string | null): Promise<void>;

  getIdempotency(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Append to the hash-chained audit log. Sequence number and previous-hash linkage are
   * assigned inside a transaction, so concurrent writers cannot fork the chain.
   */
  appendAudit(entry: AuditInput): Promise<AuditLog>;

  /** Document counts per collection; powers the ops panel and the reset script. */
  stats(): Promise<Record<string, number>>;

  /** Remove every document. Used by the demo reset flow and by integration tests. */
  reset(): Promise<void>;
}

export const COLLECTION_NAMES = [
  'merchants',
  'users',
  'customers',
  'payments',
  'payment_attempts',
  'subscriptions',
  'invoices',
  'checkout_sessions',
  'recovery_cases',
  'recovery_actions',
  'recovery_outcomes',
  'ai_decisions',
  'policy_decisions',
  'audit_logs',
  'notifications',
  'payment_links',
  'idempotency_keys',
  // Chain-head pointers, one per merchant. Kept out of `audit_logs` so a merchant-scoped
  // read of the trail returns only real entries.
  'audit_chain_heads',
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];
