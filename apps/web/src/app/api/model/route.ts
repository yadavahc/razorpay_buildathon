import { handler, ok } from '@/lib/api';
import { getEngine } from '@/lib/engine';
import { FEATURE_LABELS, type FeatureName } from '@reclaim/core';

export const dynamic = 'force-dynamic';

/**
 * The model card: how it was trained, how it scores, how well calibrated it is, and what
 * it learned. Read straight from the artifact `npm run train` wrote, so the page cannot
 * drift from the model that is actually serving predictions.
 */
export const GET = handler(async (startedAt) => {
  const engine = await getEngine();
  const artifact = engine.prediction.artifact;

  const weights = artifact.weights
    .map((weight, index) => {
      const feature = artifact.featureNames[index] as FeatureName;
      return {
        feature,
        label: FEATURE_LABELS[feature] ?? feature,
        weight,
        magnitude: Math.abs(weight),
        direction: weight >= 0 ? ('positive' as const) : ('negative' as const),
      };
    })
    .sort((a, b) => b.magnitude - a.magnitude);

  return ok(
    {
      degraded: engine.prediction.isDegraded,
      version: artifact.version,
      algorithm: artifact.algorithm,
      trainedAt: artifact.trainedAt,
      dataset: artifact.dataset,
      training: artifact.training,
      operatingThreshold: artifact.operatingThreshold,
      balancedThreshold: artifact.balancedThreshold,
      evaluation: artifact.evaluation,
      balancedClassification: artifact.balancedClassification,
      holdout: artifact.holdout,
      weights,
      featureCount: artifact.featureNames.length,
    },
    startedAt,
  );
});
