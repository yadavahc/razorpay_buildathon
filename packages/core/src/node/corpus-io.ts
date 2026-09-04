import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ModelArtifact } from '../ml/model.js';
import type { LabelledExample } from '../ml/train.js';
import type { CorpusStats, GeneratedCorpus, RecoveryEpisode } from '../seed/generator.js';
import type { MemoryStore } from '../store/memory-store.js';
import type { DataStore } from '../store/types.js';

/**
 * Filesystem I/O for the generated corpus and the trained model artifact.
 *
 * Isolated in `@reclaim/core/node` and deliberately absent from the package's main entry
 * point, so importing `@reclaim/core` from a browser bundle can never pull `node:fs` in.
 */

export const CORPUS_FILES = {
  merchant: 'merchant.json',
  users: 'users.json',
  customers: 'customers.json',
  payments: 'payments.json',
  paymentAttempts: 'payment-attempts.json',
  subscriptions: 'subscriptions.json',
  invoices: 'invoices.json',
  checkoutSessions: 'checkout-sessions.json',
  cases: 'recovery-cases.json',
  actions: 'recovery-actions.json',
  outcomes: 'recovery-outcomes.json',
  holdout: 'holdout-episodes.json',
  stats: 'corpus-stats.json',
  model: 'model.json',
} as const;

/**
 * Resolve the data directory, searching upward from the current working directory.
 *
 * The corpus lives once at the repository root, but it is read from several different
 * working directories: the CLI scripts run from the root, the Next.js server runs from
 * `apps/web`, and Vitest runs from wherever it was invoked. Walking up until the
 * directory is found means none of them need to know where they are, and an absolute
 * `RECLAIM_DATA_DIR` still wins outright.
 */
export function resolveDataDir(dataDir: string): string {
  if (isAbsolute(dataDir)) return dataDir;

  let current = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const candidate = resolve(current, dataDir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Nothing found: return the cwd-relative path so callers report a sensible location.
  return resolve(process.cwd(), dataDir);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf-8');
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

export interface WriteCorpusResult {
  dataDir: string;
  files: Array<{ file: string; records: number; bytes: number }>;
  totalBytes: number;
}

export function writeCorpus(corpus: GeneratedCorpus, dataDir: string): WriteCorpusResult {
  const dir = resolveDataDir(dataDir);
  mkdirSync(dir, { recursive: true });

  const entries: Array<[string, unknown, number]> = [
    [CORPUS_FILES.merchant, corpus.merchant, 1],
    [CORPUS_FILES.users, corpus.users, corpus.users.length],
    [CORPUS_FILES.customers, corpus.customers, corpus.customers.length],
    [CORPUS_FILES.payments, corpus.payments, corpus.payments.length],
    [CORPUS_FILES.paymentAttempts, corpus.paymentAttempts, corpus.paymentAttempts.length],
    [CORPUS_FILES.subscriptions, corpus.subscriptions, corpus.subscriptions.length],
    [CORPUS_FILES.invoices, corpus.invoices, corpus.invoices.length],
    [CORPUS_FILES.checkoutSessions, corpus.checkoutSessions, corpus.checkoutSessions.length],
    [CORPUS_FILES.cases, corpus.historicalCases, corpus.historicalCases.length],
    [CORPUS_FILES.actions, corpus.historicalActions, corpus.historicalActions.length],
    [CORPUS_FILES.outcomes, corpus.historicalOutcomes, corpus.historicalOutcomes.length],
    [CORPUS_FILES.holdout, corpus.holdoutEpisodes, corpus.holdoutEpisodes.length],
    [CORPUS_FILES.stats, corpus.stats, 1],
  ];

  const files: WriteCorpusResult['files'] = [];
  let totalBytes = 0;

  for (const [file, value, records] of entries) {
    const path = join(dir, file);
    const json = JSON.stringify(value);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json, 'utf-8');
    const bytes = Buffer.byteLength(json, 'utf-8');
    totalBytes += bytes;
    files.push({ file, records, bytes });
  }

  return { dataDir: dir, files, totalBytes };
}

/**
 * The training episodes are kept alongside the corpus. They are derived from it, but
 * regenerating them independently would risk drift, so they are written once and read
 * back by both the trainer and the evaluator.
 */
export function writeTrainingEpisodes(episodes: readonly RecoveryEpisode[], dataDir: string): void {
  writeJson(join(resolveDataDir(dataDir), 'training-episodes.json'), episodes);
}

export function readTrainingEpisodes(dataDir: string): RecoveryEpisode[] {
  return readJson<RecoveryEpisode[]>(join(resolveDataDir(dataDir), 'training-episodes.json')) ?? [];
}

export function readHoldoutEpisodes(dataDir: string): RecoveryEpisode[] {
  return readJson<RecoveryEpisode[]>(join(resolveDataDir(dataDir), CORPUS_FILES.holdout)) ?? [];
}

export function writeModelArtifact(artifact: ModelArtifact, dataDir: string): string {
  const path = join(resolveDataDir(dataDir), CORPUS_FILES.model);
  writeJson(path, artifact);
  return path;
}

export function readModelArtifact(dataDir: string): ModelArtifact | null {
  return readJson<ModelArtifact>(join(resolveDataDir(dataDir), CORPUS_FILES.model));
}

export function readCorpusStats(dataDir: string): CorpusStats | null {
  return readJson<CorpusStats>(join(resolveDataDir(dataDir), CORPUS_FILES.stats));
}

export function corpusExists(dataDir: string): boolean {
  return existsSync(join(resolveDataDir(dataDir), CORPUS_FILES.customers));
}

/**
 * Load the corpus from disk into a store. The in-memory store gets a bulk path that skips
 * per-document cloning; anything else goes through the ordinary repository writes so the
 * same function seeds Firestore.
 */
export async function loadCorpusIntoStore(
  store: DataStore,
  dataDir: string,
  options: { onProgress?: (collection: string, count: number) => void } = {},
): Promise<Record<string, number>> {
  const dir = resolveDataDir(dataDir);
  const counts: Record<string, number> = {};

  const read = <T>(file: string): T[] => readJson<T[]>(join(dir, file)) ?? [];

  const merchant = readJson<Record<string, unknown>>(join(dir, CORPUS_FILES.merchant));
  if (!merchant) {
    throw new Error(
      `No corpus found in ${dir}. Run "npm run seed" to generate the synthetic dataset.`,
    );
  }

  const isMemory = store.kind === 'memory';
  const bulk = isMemory ? (store as unknown as MemoryStore) : null;

  const collections: Array<[string, keyof DataStore, unknown[]]> = [
    ['merchants', 'merchants', [merchant]],
    ['users', 'users', read(CORPUS_FILES.users)],
    ['customers', 'customers', read(CORPUS_FILES.customers)],
    ['payments', 'payments', read(CORPUS_FILES.payments)],
    ['paymentAttempts', 'paymentAttempts', read(CORPUS_FILES.paymentAttempts)],
    ['subscriptions', 'subscriptions', read(CORPUS_FILES.subscriptions)],
    ['invoices', 'invoices', read(CORPUS_FILES.invoices)],
    ['checkoutSessions', 'checkoutSessions', read(CORPUS_FILES.checkoutSessions)],
    ['cases', 'cases', read(CORPUS_FILES.cases)],
    ['actions', 'actions', read(CORPUS_FILES.actions)],
    ['outcomes', 'outcomes', read(CORPUS_FILES.outcomes)],
  ];

  for (const [label, key, docs] of collections) {
    if (docs.length === 0) {
      counts[label] = 0;
      continue;
    }
    if (bulk) {
      bulk.bulkLoad(key as never, docs as { id: string }[]);
    } else {
      const repository = store[key] as unknown as {
        putMany(docs: readonly { id: string }[]): Promise<number>;
      };
      await repository.putMany(docs as { id: string }[]);
    }
    counts[label] = docs.length;
    options.onProgress?.(label, docs.length);
  }

  return counts;
}

/** CSV export, for inspecting the corpus in a spreadsheet or loading it elsewhere. */
export function writeCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  path: string,
): number {
  mkdirSync(dirname(path), { recursive: true });
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(','));
  writeFileSync(path, lines.join('\n'), 'utf-8');
  return rows.length;
}

export function exportCorpusCsv(corpus: GeneratedCorpus, dataDir: string): Array<{ file: string; rows: number }> {
  const dir = resolveDataDir(dataDir);
  const exports: Array<{ file: string; rows: number }> = [];

  exports.push({
    file: 'customers.csv',
    rows: writeCsv(
      corpus.customers,
      [
        'id', 'name', 'email', 'segment', 'createdAt', 'lifetimeValueMinor',
        'successfulPaymentCount', 'failedPaymentCount', 'priorRecoveryAttempts',
        'priorRecoverySuccesses', 'preferredMethod', 'contactPreference',
        'contactOptOut', 'doNotRetry', 'chargebackCount', 'timezone',
      ],
      join(dir, 'customers.csv'),
    ),
  });

  exports.push({
    file: 'payments.csv',
    rows: writeCsv(
      corpus.payments,
      [
        'id', 'customerId', 'amountMinor', 'method', 'issuer', 'network', 'status',
        'source', 'failureReason', 'errorCode', 'createdAt', 'subscriptionId',
      ],
      join(dir, 'payments.csv'),
    ),
  });

  exports.push({
    file: 'subscriptions.csv',
    rows: writeCsv(
      corpus.subscriptions,
      [
        'id', 'customerId', 'planId', 'planName', 'planAmountMinor', 'interval',
        'status', 'startedAt', 'completedCycles', 'failedCycles', 'method', 'mandateActive',
      ],
      join(dir, 'subscriptions.csv'),
    ),
  });

  exports.push({
    file: 'invoices.csv',
    rows: writeCsv(
      corpus.invoices,
      ['id', 'customerId', 'number', 'amountMinor', 'status', 'issuedAt', 'dueAt', 'paidAt'],
      join(dir, 'invoices.csv'),
    ),
  });

  // Flatten the episode's nested `observed` block so the CSV is analysable directly.
  const flatEpisodes = corpus.holdoutEpisodes.map((episode) => ({
    caseId: episode.caseId,
    customerId: episode.customerId,
    paymentId: episode.paymentId,
    atIso: episode.atIso,
    amountMinor: episode.amountMinor,
    method: episode.method,
    issuer: episode.issuer,
    segment: episode.segment,
    failureReason: episode.failureReason,
    strategy: episode.strategy,
    ...episode.observed,
    latentProbability: episode.latentProbability,
    recovered: episode.recovered ? 1 : 0,
  }));

  exports.push({
    file: 'holdout-episodes.csv',
    rows: writeCsv(
      flatEpisodes,
      Object.keys(flatEpisodes[0] ?? { caseId: '' }),
      join(dir, 'holdout-episodes.csv'),
    ),
  });

  return exports;
}

export type { LabelledExample };
