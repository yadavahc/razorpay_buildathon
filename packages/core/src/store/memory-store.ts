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
import { hashObject } from '../util/hash.js';
import { newId } from '../util/id.js';
import type {
  AuditInput,
  DataStore,
  IdempotencyClaim,
  Page,
  QueryFilter,
  QuerySpec,
  Repository,
} from './types.js';

/**
 * In-process store backed by plain Maps.
 *
 * This is not a toy: it is the default persistence layer for demo mode and the substrate
 * for every unit, integration and end-to-end test in the suite. It maintains the same
 * invariants Firestore does — atomic idempotency claims, a hash-chained audit log,
 * cursor pagination — so a behaviour verified here is a behaviour that holds in
 * production. JavaScript's single-threaded execution gives us the atomicity that
 * Firestore gets from transactions.
 */

interface IndexDefinition {
  field: string;
}

class MemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly docs = new Map<string, T>();
  /** field -> value -> ids. Keeps hot lookups (by customer, by case) off the linear path. */
  private readonly indexes = new Map<string, Map<unknown, Set<string>>>();

  constructor(
    readonly name: string,
    indexedFields: readonly IndexDefinition[] = [],
  ) {
    for (const index of indexedFields) this.indexes.set(index.field, new Map());
  }

  private indexAdd(doc: T): void {
    for (const [field, byValue] of this.indexes) {
      const value = (doc as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      let ids = byValue.get(value);
      if (!ids) byValue.set(value, (ids = new Set()));
      ids.add(doc.id);
    }
  }

  private indexRemove(doc: T): void {
    for (const [field, byValue] of this.indexes) {
      const value = (doc as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      byValue.get(value)?.delete(doc.id);
    }
  }

  async get(id: string): Promise<T | null> {
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc) : null;
  }

  async getMany(ids: readonly string[]): Promise<T[]> {
    const out: T[] = [];
    for (const id of ids) {
      const doc = this.docs.get(id);
      if (doc) out.push(structuredClone(doc));
    }
    return out;
  }

  async put(doc: T): Promise<T> {
    const existing = this.docs.get(doc.id);
    if (existing) this.indexRemove(existing);
    const stored = structuredClone(doc);
    this.docs.set(doc.id, stored);
    this.indexAdd(stored);
    return structuredClone(stored);
  }

  async putMany(docs: readonly T[]): Promise<number> {
    for (const doc of docs) await this.put(doc);
    return docs.length;
  }

  async patch(id: string, changes: Partial<T>): Promise<T> {
    const existing = this.docs.get(id);
    if (!existing) throw errors.notFound(this.name, id);
    this.indexRemove(existing);
    const updated = { ...existing, ...structuredClone(changes), id } as T;
    this.docs.set(id, updated);
    this.indexAdd(updated);
    return structuredClone(updated);
  }

  async delete(id: string): Promise<void> {
    const existing = this.docs.get(id);
    if (existing) {
      this.indexRemove(existing);
      this.docs.delete(id);
    }
  }

  /** Pick the most selective indexed equality filter, if any, to avoid a full scan. */
  private candidateIds(filters: readonly QueryFilter[]): Iterable<string> | null {
    let best: Set<string> | null = null;
    for (const filter of filters) {
      if (filter.op !== '==') continue;
      const byValue = this.indexes.get(filter.field);
      if (!byValue) continue;
      const ids = byValue.get(filter.value) ?? new Set<string>();
      if (best === null || ids.size < best.size) best = ids;
    }
    return best;
  }

  async query(spec: QuerySpec = {}): Promise<Page<T>> {
    const filters = spec.where ?? [];
    const candidates = this.candidateIds(filters);

    let rows: T[] = [];
    if (candidates) {
      for (const id of candidates) {
        const doc = this.docs.get(id);
        if (doc && matchesAll(doc, filters)) rows.push(doc);
      }
    } else {
      for (const doc of this.docs.values()) {
        if (matchesAll(doc, filters)) rows.push(doc);
      }
    }

    if (spec.orderBy) {
      const { field, direction } = spec.orderBy;
      const sign = direction === 'desc' ? -1 : 1;
      rows.sort((a, b) => sign * compareValues(readField(a, field), readField(b, field)));
    } else {
      rows.sort((a, b) => compareValues(a.id, b.id));
    }

    let startIndex = 0;
    if (spec.cursor) {
      const idx = rows.findIndex((r) => r.id === spec.cursor);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }

    const limit = spec.limit ?? rows.length;
    const slice = rows.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < rows.length;

    return {
      items: slice.map((r) => structuredClone(r)),
      nextCursor: hasMore ? (slice.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  async list(spec: QuerySpec = {}): Promise<T[]> {
    const page = await this.query({ ...spec, limit: spec.limit ?? Number.MAX_SAFE_INTEGER });
    return page.items;
  }

  async count(spec: QuerySpec = {}): Promise<number> {
    if (!spec.where || spec.where.length === 0) return this.docs.size;
    const page = await this.query({ where: spec.where, limit: Number.MAX_SAFE_INTEGER });
    return page.items.length;
  }

  async clear(): Promise<void> {
    this.docs.clear();
    for (const byValue of this.indexes.values()) byValue.clear();
  }

  /** Direct, clone-free access used only by the corpus loader for bulk seeding speed. */
  bulkLoad(docs: readonly T[]): void {
    for (const doc of docs) {
      this.docs.set(doc.id, doc);
      this.indexAdd(doc);
    }
  }
}

function readField(doc: unknown, field: string): unknown {
  if (!field.includes('.')) return (doc as Record<string, unknown>)[field];
  let current: unknown = doc;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesAll(doc: unknown, filters: readonly QueryFilter[]): boolean {
  for (const filter of filters) if (!matches(doc, filter)) return false;
  return true;
}

function matches(doc: unknown, filter: QueryFilter): boolean {
  const actual = readField(doc, filter.field);
  switch (filter.op) {
    case '==':
      return actual === filter.value;
    case '!=':
      return actual !== filter.value;
    case '<':
      return compareValues(actual, filter.value) < 0;
    case '<=':
      return compareValues(actual, filter.value) <= 0;
    case '>':
      return compareValues(actual, filter.value) > 0;
    case '>=':
      return compareValues(actual, filter.value) >= 0;
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(actual);
    case 'array-contains':
      return Array.isArray(actual) && actual.includes(filter.value);
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : 1;
}

export class MemoryStore implements DataStore {
  readonly kind = 'memory' as const;

  readonly merchants = new MemoryRepository<Merchant>('merchants');
  readonly users = new MemoryRepository<User>('users', [{ field: 'merchantId' }, { field: 'email' }]);
  readonly customers = new MemoryRepository<Customer>('customers', [
    { field: 'merchantId' },
    { field: 'segment' },
  ]);
  readonly payments = new MemoryRepository<Payment>('payments', [
    { field: 'customerId' },
    { field: 'merchantId' },
    { field: 'status' },
    { field: 'subscriptionId' },
    { field: 'invoiceId' },
    { field: 'recoveryCaseId' },
  ]);
  readonly paymentAttempts = new MemoryRepository<PaymentAttempt>('payment_attempts', [
    { field: 'paymentId' },
    { field: 'customerId' },
  ]);
  readonly subscriptions = new MemoryRepository<Subscription>('subscriptions', [
    { field: 'customerId' },
    { field: 'merchantId' },
    { field: 'status' },
  ]);
  readonly invoices = new MemoryRepository<Invoice>('invoices', [
    { field: 'customerId' },
    { field: 'merchantId' },
    { field: 'status' },
  ]);
  readonly checkoutSessions = new MemoryRepository<CheckoutSession>('checkout_sessions', [
    { field: 'customerId' },
    { field: 'merchantId' },
  ]);
  readonly cases = new MemoryRepository<RecoveryCase>('recovery_cases', [
    { field: 'merchantId' },
    { field: 'customerId' },
    { field: 'status' },
    { field: 'sourceId' },
    { field: 'sourceType' },
  ]);
  readonly actions = new MemoryRepository<RecoveryAction>('recovery_actions', [
    { field: 'caseId' },
    { field: 'customerId' },
    { field: 'merchantId' },
    { field: 'status' },
  ]);
  readonly outcomes = new MemoryRepository<RecoveryOutcome>('recovery_outcomes', [
    { field: 'caseId' },
    { field: 'merchantId' },
    { field: 'outcome' },
  ]);
  readonly aiDecisions = new MemoryRepository<AIDecision>('ai_decisions', [
    { field: 'caseId' },
    { field: 'merchantId' },
  ]);
  readonly policyDecisions = new MemoryRepository<PolicyDecision>('policy_decisions', [
    { field: 'caseId' },
    { field: 'merchantId' },
    { field: 'verdict' },
  ]);
  readonly auditLogs = new MemoryRepository<AuditLog>('audit_logs', [
    { field: 'merchantId' },
    { field: 'caseId' },
    { field: 'event' },
  ]);
  readonly notifications = new MemoryRepository<Notification>('notifications', [
    { field: 'caseId' },
    { field: 'customerId' },
    { field: 'merchantId' },
  ]);
  readonly paymentLinks = new MemoryRepository<PaymentLink>('payment_links', [
    { field: 'caseId' },
    { field: 'customerId' },
  ]);

  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly auditChain = new Map<string, { seq: number; hash: string }>();

  async claimIdempotency(input: {
    key: string;
    merchantId: string;
    scope: string;
    actionId: string;
  }): Promise<IdempotencyClaim> {
    const existing = this.idempotency.get(input.key);
    if (existing) return { claimed: false, record: { ...existing } };

    const record: IdempotencyRecord = {
      key: input.key,
      merchantId: input.merchantId,
      scope: input.scope,
      actionId: input.actionId,
      resultRef: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.idempotency.set(input.key, record);
    return { claimed: true, record: { ...record } };
  }

  async settleIdempotency(key: string, status: ActionStatus, resultRef: string | null): Promise<void> {
    const record = this.idempotency.get(key);
    if (!record) return;
    this.idempotency.set(key, { ...record, status, resultRef });
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const record = this.idempotency.get(key);
    return record ? { ...record } : null;
  }

  async appendAudit(entry: AuditInput): Promise<AuditLog> {
    const head = this.auditChain.get(entry.merchantId) ?? { seq: -1, hash: GENESIS_HASH };
    const seq = head.seq + 1;
    const body = buildAuditBody(entry, seq, head.hash);
    const log: AuditLog = { ...body, hash: hashObject(body) };
    this.auditChain.set(entry.merchantId, { seq, hash: log.hash });
    await this.auditLogs.put(log);
    return log;
  }

  async stats(): Promise<Record<string, number>> {
    return {
      merchants: await this.merchants.count(),
      users: await this.users.count(),
      customers: await this.customers.count(),
      payments: await this.payments.count(),
      payment_attempts: await this.paymentAttempts.count(),
      subscriptions: await this.subscriptions.count(),
      invoices: await this.invoices.count(),
      checkout_sessions: await this.checkoutSessions.count(),
      recovery_cases: await this.cases.count(),
      recovery_actions: await this.actions.count(),
      recovery_outcomes: await this.outcomes.count(),
      ai_decisions: await this.aiDecisions.count(),
      policy_decisions: await this.policyDecisions.count(),
      audit_logs: await this.auditLogs.count(),
      notifications: await this.notifications.count(),
      payment_links: await this.paymentLinks.count(),
      idempotency_keys: this.idempotency.size,
    };
  }

  async reset(): Promise<void> {
    await Promise.all([
      this.merchants.clear(),
      this.users.clear(),
      this.customers.clear(),
      this.payments.clear(),
      this.paymentAttempts.clear(),
      this.subscriptions.clear(),
      this.invoices.clear(),
      this.checkoutSessions.clear(),
      this.cases.clear(),
      this.actions.clear(),
      this.outcomes.clear(),
      this.aiDecisions.clear(),
      this.policyDecisions.clear(),
      this.auditLogs.clear(),
      this.notifications.clear(),
      this.paymentLinks.clear(),
    ]);
    this.idempotency.clear();
    this.auditChain.clear();
  }

  /** Fast path for loading the seeded corpus without per-document cloning. */
  bulkLoad(collection: keyof MemoryStore, docs: readonly { id: string }[]): void {
    const repo = this[collection] as unknown as MemoryRepository<{ id: string }>;
    repo.bulkLoad(docs);
  }
}

export const GENESIS_HASH = '0'.repeat(64);

export function buildAuditBody(entry: AuditInput, seq: number, prevHash: string): Omit<AuditLog, 'hash'> {
  return {
    id: newId('aud'),
    merchantId: entry.merchantId,
    seq,
    at: entry.at ?? new Date().toISOString(),
    actor: entry.actor,
    event: entry.event,
    caseId: entry.caseId ?? null,
    customerId: entry.customerId ?? null,
    amountMinor: entry.amountMinor ?? null,
    trigger: entry.trigger,
    aiDecisionId: entry.aiDecisionId ?? null,
    policyDecisionId: entry.policyDecisionId ?? null,
    actionId: entry.actionId ?? null,
    actionStatus: entry.actionStatus ?? null,
    failure: entry.failure ?? null,
    fallback: entry.fallback ?? null,
    finalOutcome: entry.finalOutcome ?? null,
    metadata: entry.metadata ?? {},
    prevHash,
  };
}

/**
 * Replay the chain and confirm nothing has been altered. Exposed through the audit API so
 * the integrity claim on the dashboard is something the user can actually check, not a
 * badge we print.
 */
export function verifyAuditChain(logs: readonly AuditLog[]): {
  valid: boolean;
  checked: number;
  brokenAt: string | null;
  reason: string | null;
} {
  const ordered = [...logs].sort((a, b) => a.seq - b.seq);
  let expectedPrev = GENESIS_HASH;

  for (const log of ordered) {
    if (log.prevHash !== expectedPrev) {
      return {
        valid: false,
        checked: ordered.length,
        brokenAt: log.id,
        reason: `sequence ${log.seq} expected prevHash ${expectedPrev.slice(0, 12)}… but stored ${log.prevHash.slice(0, 12)}…`,
      };
    }
    const { hash, ...body } = log;
    const recomputed = hashObject(body);
    if (recomputed !== hash) {
      return {
        valid: false,
        checked: ordered.length,
        brokenAt: log.id,
        reason: `sequence ${log.seq} content does not match its recorded hash`,
      };
    }
    expectedPrev = hash;
  }

  return { valid: true, checked: ordered.length, brokenAt: null, reason: null };
}

export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}
