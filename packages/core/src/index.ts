/**
 * @reclaim/core — the RECLAIM domain.
 *
 * Everything the product does that is not rendering lives here: the failure taxonomy,
 * the recovery-probability model, the expected-value engine, the deterministic policy
 * engine, the agent tool layer, the action executor, the provider abstraction, and the
 * synthetic corpus generator.
 *
 * The package has exactly one runtime dependency (zod) and no framework coupling, so the
 * same code runs in the Next.js server, in Cloud Functions, in the CLI scripts, and in
 * the test suite.
 */

export * from './types/money.js';
export * from './types/enums.js';
export * from './types/entities.js';
export * from './types/decisions.js';

export * from './config/index.js';
export * from './errors/index.js';
export * from './logging/index.js';
export * from './resilience/index.js';

export * from './util/collections.js';
export * from './util/hash.js';
export * from './util/id.js';
export * from './util/rng.js';
export * from './util/time.js';

export * from './domain/failure-taxonomy.js';
export * from './domain/case-profiles.js';
export * from './domain/intervention-economics.js';

export * from './ml/index.js';
export * from './graph/opportunity-graph.js';
export * from './analytics/regret-ledger.js';
export * from './analytics/incident-detector.js';
export * from './analytics/timing-engine.js';
export * from './strategy/expected-value.js';
export * from './strategy/strategy-engine.js';
export * from './policy/policy-engine.js';

export * from './store/types.js';
export * from './store/memory-store.js';
export * from './store/firestore-store.js';

export * from './llm/index.js';
export * from './providers/index.js';
export * from './agents/index.js';
export * from './services/index.js';

export * from './container.js';
