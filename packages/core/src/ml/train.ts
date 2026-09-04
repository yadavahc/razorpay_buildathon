import { createRng } from '../util/rng.js';
import { round } from '../util/collections.js';
import {
  type FeatureEncoders,
  FEATURE_NAMES,
  type RecoveryFeatureInput,
  applyScaler,
  fitEncoders,
  fitScaler,
  vectorize,
} from './features.js';
import {
  DEFAULT_TRAIN_OPTIONS,
  type TrainOptions,
  applyCalibration,
  fitCalibrator,
  predictProbability,
} from './logistic-regression.js';
import { trainLogistic } from './logistic-regression.js';
import { classificationMetrics, evaluate, selectBalancedThreshold, selectOperatingThreshold } from './metrics.js';
import type { ModelArtifact } from './model.js';

/**
 * One labelled training example.
 *
 * `label` is the ground truth from the synthetic corpus: did an intervention on this
 * revenue-loss event actually recover the money? `amountMinor` and
 * `interventionCostMinor` are carried alongside because the operating threshold is
 * chosen by net rupees recovered, not by classification accuracy.
 */
export interface LabelledExample {
  features: RecoveryFeatureInput;
  label: 0 | 1;
  amountMinor: number;
  interventionCostMinor: number;
}

export interface TrainingConfig {
  seed: number;
  trainRatio: number;
  validationRatio: number;
  options: Partial<TrainOptions>;
  version: string;
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  seed: 20260901,
  trainRatio: 0.6,
  validationRatio: 0.2,
  options: {},
  version: 'recovery-probability-v1',
};

export interface TrainingResult {
  artifact: ModelArtifact;
  splits: { train: LabelledExample[]; validation: LabelledExample[]; test: LabelledExample[] };
}

/**
 * Train the recovery-probability model.
 *
 * The split is done once, up front, and every subsequent step respects it:
 *  - categorical target encoders are fitted on TRAIN only, so no label from validation
 *    or test can leak into a feature value;
 *  - the probability calibrator is fitted on VALIDATION, which is also where the
 *    operating threshold is chosen;
 *  - TEST is touched exactly once, at the end, to produce the reported metrics.
 */
export function trainRecoveryModel(
  examples: readonly LabelledExample[],
  config: Partial<TrainingConfig> = {},
  holdout: readonly LabelledExample[] = [],
): TrainingResult {
  const cfg = { ...DEFAULT_TRAINING_CONFIG, ...config };
  if (examples.length < 50) {
    throw new Error(`trainRecoveryModel: need at least 50 examples, received ${examples.length}`);
  }

  const shuffled = createRng(cfg.seed).shuffle([...examples]);
  const trainEnd = Math.floor(shuffled.length * cfg.trainRatio);
  const validationEnd = trainEnd + Math.floor(shuffled.length * cfg.validationRatio);
  const train = shuffled.slice(0, trainEnd);
  const validation = shuffled.slice(trainEnd, validationEnd);
  const test = shuffled.slice(validationEnd);

  const encoders: FeatureEncoders = fitEncoders(
    train.map((e) => e.features),
    train.map((e) => e.label),
  );

  const rawTrain = train.map((e) => vectorize(e.features, encoders));
  const scaler = fitScaler(rawTrain);
  const X = rawTrain.map((row) => applyScaler(row, scaler));
  const y = train.map((e) => e.label);

  const positives = y.reduce<number>((sum, v) => sum + v, 0);
  const negatives = y.length - positives;
  // Re-balance so the minority class cannot be ignored by the optimiser.
  const positiveWeight = positives === 0 ? 1 : Math.min(3, Math.max(0.5, negatives / positives));

  const options: Partial<TrainOptions> = {
    ...DEFAULT_TRAIN_OPTIONS,
    positiveWeight,
    ...cfg.options,
  };
  const fitted = trainLogistic(X, y, options);

  const scoreRaw = (example: LabelledExample): number =>
    predictProbability(fitted, applyScaler(vectorize(example.features, encoders), scaler));

  const validationRaw = validation.map(scoreRaw);
  const calibrator =
    validation.length >= 50
      ? fitCalibrator(
          validationRaw,
          validation.map((e) => e.label),
        )
      : { slope: 1, intercept: 0 };

  const calibrate = (p: number): number => applyCalibration(calibrator, p);
  const validationProbabilities = validationRaw.map(calibrate);

  const { threshold } = selectOperatingThreshold(
    validationProbabilities,
    validation.map((e) => e.label),
    {
      amountsMinor: validation.map((e) => e.amountMinor),
      interventionCostsMinor: validation.map((e) => e.interventionCostMinor),
    },
  );

  const balanced = selectBalancedThreshold(
    validationProbabilities,
    validation.map((e) => e.label),
  );

  const testProbabilities = test.map((e) => calibrate(scoreRaw(e)));
  const evaluation = evaluate(
    testProbabilities,
    test.map((e) => e.label),
    {
      amountsMinor: test.map((e) => e.amountMinor),
      interventionCostsMinor: test.map((e) => e.interventionCostMinor),
    },
    threshold,
  );

  const holdoutReport =
    holdout.length > 0
      ? evaluate(
          holdout.map((e) => calibrate(scoreRaw(e))),
          holdout.map((e) => e.label),
          {
            amountsMinor: holdout.map((e) => e.amountMinor),
            interventionCostsMinor: holdout.map((e) => e.interventionCostMinor),
          },
          threshold,
        )
      : null;

  const artifact: ModelArtifact = {
    version: cfg.version,
    trainedAt: new Date().toISOString(),
    algorithm: 'logistic_regression_l2',
    featureNames: FEATURE_NAMES,
    weights: fitted.weights.map((w) => round(w, 6)),
    bias: round(fitted.bias, 6),
    scaler: {
      mean: scaler.mean.map((v) => round(v, 6)),
      std: scaler.std.map((v) => round(v, 6)),
    },
    encoders,
    calibrator: { slope: round(calibrator.slope, 6), intercept: round(calibrator.intercept, 6) },
    operatingThreshold: threshold,
    balancedThreshold: balanced.threshold,
    dataset: {
      totalRows: examples.length,
      trainRows: train.length,
      validationRows: validation.length,
      testRows: test.length,
      positiveRate: round(examples.reduce<number>((s, e) => s + e.label, 0) / examples.length),
      seed: cfg.seed,
    },
    training: {
      epochsRun: fitted.epochsRun,
      finalLoss: round(fitted.finalLoss, 6),
      converged: fitted.converged,
      learningRate: options.learningRate ?? DEFAULT_TRAIN_OPTIONS.learningRate,
      l2: options.l2 ?? DEFAULT_TRAIN_OPTIONS.l2,
    },
    evaluation,
    balancedClassification: classificationMetrics(
      testProbabilities,
      test.map((e) => e.label),
      balanced.threshold,
    ),
    holdout: holdoutReport,
  };

  return { artifact, splits: { train, validation, test } };
}
