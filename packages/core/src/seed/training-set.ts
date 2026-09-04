import { resolveCaseProfile } from '../domain/case-profiles.js';
import type { LabelledExample } from '../ml/train.js';
import type { RecoveryFeatureInput } from '../ml/features.js';
import type { RecoveryEpisode } from './generator.js';

/**
 * Project historical recovery episodes into the model's feature contract.
 *
 * The mapping is deliberately mechanical: every field comes from `episode.observed`,
 * which the generator populated with the customer's state at decision time and nothing
 * else. `latentProbability` — the quantity the outcome was actually drawn against — is
 * never touched here. It exists only for diagnostics, and letting it near the feature
 * vector would produce a model that scores beautifully and predicts nothing.
 */
export function episodeToExample(episode: RecoveryEpisode): LabelledExample {
  const profile = resolveCaseProfile({
    sourceType: 'payment_failure',
    failureReason: episode.failureReason,
  });

  const features: RecoveryFeatureInput = {
    amountMinor: episode.amountMinor,
    profileKey: profile.key,
    baseRecoverability: profile.baseRecoverability,
    selfResolving: profile.selfResolving,
    customerActionRequired: profile.customerActionRequired,
    method: episode.method,
    issuer: episode.issuer,
    segment: episode.segment,
    sourceType: 'payment_failure',
    customerSuccessCount: episode.observed.successCountBefore,
    customerFailureCount: episode.observed.failureCountBefore,
    customerLifetimeValueMinor: episode.observed.lifetimeValueBeforeMinor,
    priorRecoveryAttempts: episode.observed.priorRecoveryAttempts,
    priorRecoverySuccesses: episode.observed.priorRecoverySuccesses,
    hoursSinceFailure: episode.observed.hoursSinceFailure,
    daysSinceLastSuccess: episode.observed.daysSinceLastSuccess,
    subscriptionAgeDays: episode.observed.subscriptionAgeDays,
    isSubscription: episode.observed.isSubscriber,
    attemptNumber: episode.observed.attemptNumber,
    hasAlternateSuccessfulMethod: episode.observed.hasAlternateSuccessfulMethod,
    isBusinessHours: episode.observed.isBusinessHours,
    bankDowntimeCluster: episode.observed.bankDowntimeCluster,
  };

  return {
    features,
    label: episode.recovered ? 1 : 0,
    amountMinor: episode.amountMinor,
    interventionCostMinor: episode.interventionCostMinor,
  };
}

export function episodesToExamples(episodes: readonly RecoveryEpisode[]): LabelledExample[] {
  return episodes.map(episodeToExample);
}
