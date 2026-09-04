import { errors } from '../errors/index.js';
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
import { chunk } from '../util/collections.js';
import { hashObject } from '../util/hash.js';
import { GENESIS_HASH, buildAuditBody } from './memory-store.js';
import type {
  AuditInput,
  CollectionName,
  DataStore,
  IdempotencyClaim,
  Page,
  QuerySpec,
  Repository,
} from './types.js';

/**
 * Cloud Firestore implementation of the persistence contract.
 *
 * `@reclaim/core` has no compile-time dependency on `firebase-admin`: the Firestore
 * surface we use is described structurally below and the SDK is injected by the caller.
 * That keeps the core package importable from the browser bundle, from Cloud Functions
 * and from test processes without dragging the Admin SDK along, and it makes the whole
 * store trivially mockable.
 */

export interface FirestoreDocumentSnapshot {
  readonly exists: boolean;
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreQuerySnapshot {
  readonly docs: FirestoreDocumentSnapshot[];
  readonly size: number;
  readonly empty: boolean;
}

export interface FirestoreQuery {
  where(field: string, op: string, value: unknown): FirestoreQuery;
  orderBy(field: string, direction?: 'asc' | 'desc'): FirestoreQuery;
  limit(n: number): FirestoreQuery;
  /** Accepts either field values or a DocumentSnapshot as the cursor anchor. */
  startAfter(...values: unknown[]): FirestoreQuery;
  get(): Promise<FirestoreQuerySnapshot>;
  count?(): { get(): Promise<{ data(): { count: number } }> };
}

export interface FirestoreDocumentReference {
  readonly id: string;
  get(): Promise<FirestoreDocumentSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface FirestoreCollectionReference extends FirestoreQuery {
  doc(id: string): FirestoreDocumentReference;
}

export interface FirestoreWriteBatch {
  set(ref: FirestoreDocumentReference, data: Record<string, unknown>): FirestoreWriteBatch;
  delete(ref: FirestoreDocumentReference): FirestoreWriteBatch;
  commit(): Promise<unknown>;
}

export interface FirestoreTransaction {
  get(ref: FirestoreDocumentReference): Promise<FirestoreDocumentSnapshot>;
  get(query: FirestoreQuery): Promise<FirestoreQuerySnapshot>;
  set(ref: FirestoreDocumentReference, data: Record<string, unknown>): FirestoreTransaction;
  update(ref: FirestoreDocumentReference, data: Record<string, unknown>): FirestoreTransaction;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionReference;
  batch(): FirestoreWriteBatch;
  runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T>;
}

/** Firestore caps a batch at 500 writes. */
const BATCH_LIMIT = 450;

class FirestoreRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    readonly name: string,
    private readonly db: FirestoreLike,
    private readonly collectionPath: string,
  ) {}

  private get collection(): FirestoreCollectionReference {
    return this.db.collection(this.collectionPath);
  }

  async get(id: string): Promise<T | null> {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? (snapshot.data() as T) : null;
  }

  async getMany(ids: readonly string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    // Firestore `in` filters take at most 30 values, so page the id list.
    const results: T[] = [];
    for (const group of chunk(ids, 30)) {
      const snapshot = await this.collection.where('id', 'in', group).get();
      for (const doc of snapshot.docs) results.push(doc.data() as T);
    }
    return results;
  }

  async put(doc: T): Promise<T> {
    await this.collection.doc(doc.id).set(stripUndefined(doc));
    return doc;
  }

  async putMany(docs: readonly T[]): Promise<number> {
    let written = 0;
    for (const group of chunk(docs, BATCH_LIMIT)) {
      const batch = this.db.batch();
      for (const doc of group) batch.set(this.collection.doc(doc.id), stripUndefined(doc));
      await batch.commit();
      written += group.length;
    }
    return written;
  }

  async patch(id: string, changes: Partial<T>): Promise<T> {
    const ref = this.collection.doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw errors.notFound(this.name, id);
    await ref.update(stripUndefined(changes as Record<string, unknown>));
    const updated = await ref.get();
    return updated.data() as T;
  }

  async delete(id: string): Promise<void> {
    await this.collection.doc(id).delete();
  }

  /**
   * Build the Firestore query.
   *
   * Ordering is applied ONLY when the caller asked for it. An earlier version defaulted to
   * `orderBy('id')` for stable iteration, which quietly forced a composite index on every
   * single filtered read — Firestore indexes single fields automatically, but the moment
   * an equality filter is combined with an ordering on a different field it demands a
   * composite. That turned a zero-configuration adapter into one that failed on its first
   * query against a fresh project.
   *
   * Without an explicit ordering Firestore returns documents in `__name__` order, which is
   * stable enough for the paging this store does.
   */
  private buildQuery(spec: QuerySpec): FirestoreQuery {
    let query: FirestoreQuery = this.collection;
    for (const filter of spec.where ?? []) {
      query = query.where(filter.field, filter.op, filter.value);
    }
    if (spec.orderBy) query = query.orderBy(spec.orderBy.field, spec.orderBy.direction);
    if (spec.limit) query = query.limit(spec.limit);
    return query;
  }

  async query(spec: QuerySpec = {}): Promise<Page<T>> {
    let query = this.buildQuery(spec);

    // Cursor pagination anchored on the document snapshot rather than on a field value.
    // Firestore resolves the cursor position from the snapshot against whatever ordering
    // is in effect — including the implicit `__name__` ordering when none was requested —
    // so this works for both ordered and unordered queries without the caller having to
    // know which it is.
    if (spec.cursor) {
      const anchor = await this.collection.doc(spec.cursor).get();
      if (anchor.exists) query = query.startAfter(anchor);
    }

    const snapshot = await query.get();
    const items = snapshot.docs.map((d) => d.data() as T);
    const limit = spec.limit ?? items.length;
    const hasMore = spec.limit !== undefined && items.length === limit;

    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  async list(spec: QuerySpec = {}): Promise<T[]> {
    const page = await this.query(spec);
    return page.items;
  }

  async count(spec: QuerySpec = {}): Promise<number> {
    const query = this.buildQuery({ ...spec, limit: undefined });
    if (typeof query.count === 'function') {
      const aggregate = await query.count().get();
      return aggregate.data().count;
    }
    const snapshot = await query.get();
    return snapshot.size;
  }

  async clear(): Promise<void> {
    // Paged delete; Firestore has no truncate. Only used by the reset flow.
    for (;;) {
      const snapshot = await this.collection.limit(BATCH_LIMIT).get();
      if (snapshot.empty) return;
      const batch = this.db.batch();
      for (const doc of snapshot.docs) batch.delete(this.collection.doc(doc.id));
      await batch.commit();
      if (snapshot.size < BATCH_LIMIT) return;
    }
  }
}

/** Firestore rejects `undefined`; normalise to `null` at the boundary. */
function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[key] = v && typeof v === 'object' && !Array.isArray(v) ? stripUndefined(v as Record<string, unknown>) : v;
  }
  return out;
}

export interface FirestoreStoreOptions {
  db: FirestoreLike;
  /** Optional prefix so several environments can share one project safely. */
  namespace?: string;
}

export class FirestoreStore implements DataStore {
  readonly kind = 'firestore' as const;

  readonly merchants: Repository<Merchant>;
  readonly users: Repository<User>;
  readonly customers: Repository<Customer>;
  readonly payments: Repository<Payment>;
  readonly paymentAttempts: Repository<PaymentAttempt>;
  readonly subscriptions: Repository<Subscription>;
  readonly invoices: Repository<Invoice>;
  readonly checkoutSessions: Repository<CheckoutSession>;
  readonly cases: Repository<RecoveryCase>;
  readonly actions: Repository<RecoveryAction>;
  readonly outcomes: Repository<RecoveryOutcome>;
  readonly aiDecisions: Repository<AIDecision>;
  readonly policyDecisions: Repository<PolicyDecision>;
  readonly auditLogs: Repository<AuditLog>;
  readonly notifications: Repository<Notification>;
  readonly paymentLinks: Repository<PaymentLink>;

  private readonly db: FirestoreLike;
  private readonly prefix: string;

  constructor(options: FirestoreStoreOptions) {
    this.db = options.db;
    this.prefix = options.namespace ? `${options.namespace}_` : '';

    const repo = <T extends { id: string }>(name: CollectionName): Repository<T> =>
      new FirestoreRepository<T>(name, this.db, `${this.prefix}${name}`);

    this.merchants = repo<Merchant>('merchants');
    this.users = repo<User>('users');
    this.customers = repo<Customer>('customers');
    this.payments = repo<Payment>('payments');
    this.paymentAttempts = repo<PaymentAttempt>('payment_attempts');
    this.subscriptions = repo<Subscription>('subscriptions');
    this.invoices = repo<Invoice>('invoices');
    this.checkoutSessions = repo<CheckoutSession>('checkout_sessions');
    this.cases = repo<RecoveryCase>('recovery_cases');
    this.actions = repo<RecoveryAction>('recovery_actions');
    this.outcomes = repo<RecoveryOutcome>('recovery_outcomes');
    this.aiDecisions = repo<AIDecision>('ai_decisions');
    this.policyDecisions = repo<PolicyDecision>('policy_decisions');
    this.auditLogs = repo<AuditLog>('audit_logs');
    this.notifications = repo<Notification>('notifications');
    this.paymentLinks = repo<PaymentLink>('payment_links');
  }

  private collection(name: CollectionName): FirestoreCollectionReference {
    return this.db.collection(`${this.prefix}${name}`);
  }

  /**
   * Idempotency claim as a Firestore transaction. The read and the write happen inside
   * the same transaction, so two concurrent executors racing on the same key cannot both
   * observe "unused" and both charge the customer.
   */
  async claimIdempotency(input: {
    key: string;
    merchantId: string;
    scope: string;
    actionId: string;
  }): Promise<IdempotencyClaim> {
    const ref = this.collection('idempotency_keys').doc(input.key);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        return { claimed: false, record: snapshot.data() as IdempotencyRecord };
      }
      const record: IdempotencyRecord = {
        key: input.key,
        merchantId: input.merchantId,
        scope: input.scope,
        actionId: input.actionId,
        resultRef: null,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      tx.set(ref, record as unknown as Record<string, unknown>);
      return { claimed: true, record };
    });
  }

  async settleIdempotency(key: string, status: ActionStatus, resultRef: string | null): Promise<void> {
    await this.collection('idempotency_keys').doc(key).set({ status, resultRef }, { merge: true });
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const snapshot = await this.collection('idempotency_keys').doc(key).get();
    return snapshot.exists ? (snapshot.data() as IdempotencyRecord) : null;
  }

  /**
   * Append to the hash chain transactionally. The chain head lives in its own document
   * so the transaction reads exactly one row rather than scanning the log.
   */
  async appendAudit(entry: AuditInput): Promise<AuditLog> {
    // The head lives in its own collection, NOT alongside the entries it points at.
    // Storing it in `audit_logs` made it match every merchant-scoped read of the trail,
    // so chain verification received a document with no `hash` or `prevHash` and the
    // audit screen listed a row that was not an audit event.
    const headRef = this.collection('audit_chain_heads').doc(entry.merchantId);
    return this.db.runTransaction(async (tx) => {
      const headSnapshot = await tx.get(headRef);
      const head = headSnapshot.exists
        ? (headSnapshot.data() as { seq: number; hash: string })
        : { seq: -1, hash: GENESIS_HASH };

      const seq = head.seq + 1;
      const body = buildAuditBody(entry, seq, head.hash);
      const log: AuditLog = { ...body, hash: hashObject(body) };

      tx.set(this.collection('audit_logs').doc(log.id), log as unknown as Record<string, unknown>);
      tx.set(headRef, { id: entry.merchantId, merchantId: entry.merchantId, seq, hash: log.hash });
      return log;
    });
  }

  async stats(): Promise<Record<string, number>> {
    const names: CollectionName[] = [
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
      'audit_chain_heads',
    ];
    const out: Record<string, number> = {};
    for (const name of names) {
      const collection = this.collection(name);
      if (typeof collection.count === 'function') {
        const aggregate = await collection.count().get();
        out[name] = aggregate.data().count;
      } else {
        out[name] = (await collection.get()).size;
      }
    }
    return out;
  }

  async reset(): Promise<void> {
    const repositories = [
      this.merchants,
      this.users,
      this.customers,
      this.payments,
      this.paymentAttempts,
      this.subscriptions,
      this.invoices,
      this.checkoutSessions,
      this.cases,
      this.actions,
      this.outcomes,
      this.aiDecisions,
      this.policyDecisions,
      this.auditLogs,
      this.notifications,
      this.paymentLinks,
    ];
    for (const repository of repositories) await repository.clear();

    // Collections without a typed repository still need clearing on reset.
    for (const name of ['idempotency_keys', 'audit_chain_heads'] as const) {
      for (;;) {
        const snapshot = await this.collection(name).limit(BATCH_LIMIT).get();
        if (snapshot.empty) break;
        const batch = this.db.batch();
        for (const doc of snapshot.docs) batch.delete(this.collection(name).doc(doc.id));
        await batch.commit();
        if (snapshot.size < BATCH_LIMIT) break;
      }
    }
  }
}

export function createFirestoreStore(options: FirestoreStoreOptions): DataStore {
  return new FirestoreStore(options);
}
