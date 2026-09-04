import type { ReclaimConfig } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import { DeterministicReasoner } from './deterministic-reasoner.js';
import { LlmReasoner } from './llm-reasoner.js';
import { createLlmProvider } from './providers.js';
import type { Reasoner } from './reasoner.js';

export * from './types.js';
export * from './reasoner.js';
export * from './deterministic-reasoner.js';
export * from './llm-reasoner.js';
export * from './providers.js';

/**
 * Resolve the active reasoner from configuration.
 *
 * With an API key present the hosted model runs with the deterministic engine wired in
 * behind it as a fallback. With no key, the deterministic engine runs directly. Either
 * way the caller gets a total `Reasoner` that cannot throw, and `identity` tells the UI
 * exactly which one produced any given piece of text.
 */
export function createReasoner(config: ReclaimConfig, logger?: Logger): Reasoner {
  const provider = createLlmProvider(config.llm);
  if (!provider) return new DeterministicReasoner();
  return new LlmReasoner({
    provider,
    logger,
    fallback: new DeterministicReasoner(),
  });
}
