import 'server-only';

import {
  type DataStore,
  type RecoveryEngine,
  createMemoryStore,
  createRecoveryEngine,
  loadConfig,
} from '@reclaim/core';
import {
  corpusExists,
  createFirestoreDataStore,
  loadCorpusIntoStore,
  readCorpusStats,
  readModelArtifact,
} from '@reclaim/core/node';
import type { CorpusStats } from '@reclaim/core/seed';

/**
 * The server-side engine singleton.
 *
 * The corpus is a few tens of megabytes of JSON and the model artifact is a few kilobytes;
 * both are loaded exactly once per server process and shared by every request. The
 * initialisation promise is cached rather than the result, so concurrent first requests
 * wait on one load instead of racing to start several.
 *
 * In Firestore mode nothing is loaded into memory at all — the store reads through to the
 * database and the same engine code runs unchanged.
 */

interface EngineBundle {
  engine: RecoveryEngine;
  store: DataStore;
  corpusStats: CorpusStats | null;
  bootMs: number;
  bootedAt: string;
  warnings: string[];
}

// Next.js dev mode re-evaluates modules on change; stashing the promise on globalThis
// keeps the corpus loaded across hot reloads instead of re-reading 27MB on every edit.
const globalRef = globalThis as typeof globalThis & {
  __reclaimEngine?: Promise<EngineBundle>;
};

async function bootstrap(): Promise<EngineBundle> {
  const started = Date.now();
  const warnings: string[] = [];
  const config = loadConfig(process.env);

  const modelArtifact = readModelArtifact(config.dataDir);
  if (!modelArtifact) {
    warnings.push(
      'No trained model artifact was found. Recovery probabilities are using the taxonomy prior. Run "npm run train" to fit the model.',
    );
  }

  let store: DataStore;
  let corpusStats: CorpusStats | null = null;

  if (config.store === 'firestore') {
    store = await createFirestoreDataStore(config.firebase);
    const merchantCount = await store.merchants.count();
    if (merchantCount === 0) {
      warnings.push(
        'Firestore contains no merchant record. Run "npm run seed:firestore" to upload the corpus.',
      );
    }
  } else {
    store = createMemoryStore();
    if (corpusExists(config.dataDir)) {
      await loadCorpusIntoStore(store, config.dataDir);
      corpusStats = readCorpusStats(config.dataDir);
    } else {
      warnings.push(
        `No corpus found in "${config.dataDir}". Run "npm run seed" to generate the synthetic dataset; the dashboard will be empty until then.`,
      );
    }
  }

  const engine = createRecoveryEngine({ config, store, modelArtifact });

  return {
    engine,
    store,
    corpusStats,
    bootMs: Date.now() - started,
    bootedAt: new Date().toISOString(),
    warnings,
  };
}

export function getEngineBundle(): Promise<EngineBundle> {
  globalRef.__reclaimEngine ??= bootstrap();
  return globalRef.__reclaimEngine;
}

export async function getEngine(): Promise<RecoveryEngine> {
  return (await getEngineBundle()).engine;
}

/**
 * Detection runs lazily on first access rather than at boot.
 *
 * The seeded corpus deliberately leaves recent failures without cases so that ingestion
 * has genuine work to do. Running it on demand means a fresh clone shows a populated work
 * queue on the first dashboard load, without paying for it during startup.
 */
const detectionRef = globalThis as typeof globalThis & {
  __reclaimDetection?: Promise<number>;
};

export async function ensureDetectionRun(): Promise<number> {
  detectionRef.__reclaimDetection ??= (async () => {
    const { engine } = await getEngineBundle();
    const existing = await engine.store.cases.count({
      where: [
        { field: 'merchantId', op: '==', value: engine.merchantId },
        { field: 'status', op: '==', value: 'detected' },
      ],
    });
    // Only run if the queue is empty; a restart must not re-detect what is already open.
    if (existing > 0) return existing;

    const summary = await engine.ingestion.ingest(engine.merchantId, { maxCases: 400 });
    const created =
      summary.created.paymentFailure +
      summary.created.subscriptionDunning +
      summary.created.checkoutAbandonment +
      summary.created.overdueInvoice;

    // Score every freshly detected case immediately.
    //
    // Prediction is a dot product over two dozen features, so scoring the whole queue
    // costs milliseconds. Doing it here means "recoverable revenue", "expected value" and
    // the priority ranking are populated the moment the dashboard opens, rather than
    // showing zero until someone happens to click into each case.
    await scoreOpenCases(engine);
    return created;
  })();
  return detectionRef.__reclaimDetection;
}

/**
 * Score and rank every unscored open case. Runs the model and the expected-value engine
 * but takes no action and writes no decision record: this is ranking, not deciding.
 */
async function scoreOpenCases(engine: RecoveryEngine): Promise<number> {
  const cases = await engine.cases.listWorkQueue(engine.merchantId, { limit: 1000 });
  const unscored = cases.filter((c) => c.recoveryProbability === null);
  const nowIso = new Date().toISOString();
  let scored = 0;

  for (const recoveryCase of unscored) {
    try {
      const context = await engine.context.buildContextForCase(recoveryCase, nowIso);
      const prediction = engine.prediction.predict(context.modelInput);
      const evaluation = engine.strategist.evaluate(context, prediction.probability);

      await engine.cases.recordPrediction(recoveryCase.id, {
        probability: prediction.probability,
        expectedValueMinor: evaluation.best.expectedValueMinor,
        isSubscriber: context.features.isSubscriber,
        lifetimeValueMinor: context.features.lifetimeValueMinor,
        at: nowIso,
      });
      scored += 1;
    } catch {
      // A case whose context cannot be built is skipped rather than blocking the queue.
      continue;
    }
  }
  return scored;
}

/** Drop the cached engine so the next request rebuilds it. Used by the demo reset flow. */
export function invalidateEngine(): void {
  delete globalRef.__reclaimEngine;
  delete detectionRef.__reclaimDetection;
}
