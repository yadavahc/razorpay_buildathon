import type { DecisionSignal } from '../types/decisions.js';
import { clamp, round } from '../util/collections.js';
import {
  FEATURE_COUNT,
  FEATURE_LABELS,
  FEATURE_NAMES,
  type FeatureEncoders,
  type FeatureName,
  type RecoveryFeatureInput,
  type Scaler,
  applyScaler,
  vectorize,
} from './features.js';
import {
  type Calibrator,
  IDENTITY_CALIBRATOR,
  applyCalibration,
  contributions,
  predictLogit,
  sigmoid,
} from './logistic-regression.js';
import type { ClassificationMetrics, EvaluationReport } from './metrics.js';

/**
 * The serialised model artifact. This is the complete contract between
 * `npm run train` and the running application: weights, the encoders needed to
 * reproduce them, the operating threshold, and the evaluation report that justifies it.
 */
export interface ModelArtifact {
  version: string;
  trainedAt: string;
  algorithm: 'logistic_regression_l2';
  featureNames: readonly string[];
  weights: number[];
  bias: number;
  scaler: Scaler;
  encoders: FeatureEncoders;
  calibrator: Calibrator;
  /** Probability above which acting is expected to be net-positive. Where we operate. */
  operatingThreshold: number;
  /**
   * The F1-maximising threshold, reported for interpretability only. The gap between
   * this and `operatingThreshold` is the value of pricing the decision rather than
   * classifying it.
   */
  balancedThreshold: number;
  dataset: {
    totalRows: number;
    trainRows: number;
    validationRows: number;
    testRows: number;
    positiveRate: number;
    seed: number;
  };
  training: {
    epochsRun: number;
    finalLoss: number;
    converged: boolean;
    learningRate: number;
    l2: number;
  };
  evaluation: EvaluationReport;
  /** Test-split classification at `balancedThreshold`, for a readable confusion matrix. */
  balancedClassification: ClassificationMetrics;
  /** Held-out evaluation slice metrics, reported separately from the test split. */
  holdout: EvaluationReport | null;
}

export interface Prediction {
  probability: number;
  /** Raw, uncalibrated model output; kept for diagnostics. */
  rawProbability: number;
  logit: number;
  /** Whether the probability clears the value-optimised operating threshold. */
  aboveThreshold: boolean;
  threshold: number;
  modelVersion: string;
  /** Top drivers, largest absolute logit contribution first. */
  drivers: Array<{
    feature: FeatureName;
    label: string;
    contribution: number;
    direction: 'positive' | 'negative';
    value: number;
  }>;
}

/**
 * The runtime face of the model. Construct once and reuse: prediction is a dot product,
 * so a single instance comfortably serves a whole batch run.
 */
export class RecoveryModel {
  private constructor(readonly artifact: ModelArtifact) {}

  static fromArtifact(artifact: ModelArtifact): RecoveryModel {
    if (artifact.weights.length !== FEATURE_COUNT) {
      throw new Error(
        `model artifact has ${artifact.weights.length} weights but the feature contract declares ${FEATURE_COUNT}. Re-run "npm run train".`,
      );
    }
    return new RecoveryModel(artifact);
  }

  get version(): string {
    return this.artifact.version;
  }

  get threshold(): number {
    return this.artifact.operatingThreshold;
  }

  predict(input: RecoveryFeatureInput): Prediction {
    const raw = vectorize(input, this.artifact.encoders);
    const scaled = applyScaler(raw, this.artifact.scaler);
    const logit = predictLogit({ weights: this.artifact.weights, bias: this.artifact.bias }, scaled);
    const rawProbability = sigmoid(logit);
    const probability = clamp(applyCalibration(this.artifact.calibrator, rawProbability), 0.001, 0.999);

    const contribs = contributions(
      { weights: this.artifact.weights, bias: this.artifact.bias },
      scaled,
    );
    const drivers = contribs
      .map((contribution, index) => ({
        feature: FEATURE_NAMES[index]!,
        label: FEATURE_LABELS[FEATURE_NAMES[index]!],
        contribution: round(contribution, 4),
        direction: (contribution >= 0 ? 'positive' : 'negative') as 'positive' | 'negative',
        value: round(raw[index]!, 4),
      }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    return {
      probability: round(probability, 4),
      rawProbability: round(rawProbability, 4),
      logit: round(logit, 4),
      aboveThreshold: probability >= this.artifact.operatingThreshold,
      threshold: this.artifact.operatingThreshold,
      modelVersion: this.artifact.version,
      drivers,
    };
  }

  /** Project a prediction into the signal shape the Decision Inspector renders. */
  toSignals(prediction: Prediction, limit = 6): DecisionSignal[] {
    return prediction.drivers.slice(0, limit).map((driver) => ({
      key: driver.feature,
      label: driver.label,
      value: driver.value,
      contribution: driver.contribution,
      direction:
        Math.abs(driver.contribution) < 0.01
          ? ('neutral' as const)
          : driver.direction === 'positive'
            ? ('positive' as const)
            : ('negative' as const),
    }));
  }
}

/**
 * A conservative stand-in used only when no trained artifact is present — a fresh clone
 * before `npm run train`, or a Cloud Function whose artifact failed to load.
 *
 * It is not a silent fallback: it reports a distinct version string, the API surfaces it
 * as `degraded`, and the dashboard shows a warning banner instead of pretending the real
 * model is running. It uses the taxonomy prior blended with the customer's own success
 * ratio, which is defensible but noticeably weaker than the trained model.
 */
export function createFallbackModel(): RecoveryModel {
  const zeroReport = emptyEvaluation();
  return RecoveryModel.fromArtifact({
    version: 'fallback-prior-v1',
    trainedAt: new Date(0).toISOString(),
    algorithm: 'logistic_regression_l2',
    featureNames: FEATURE_NAMES,
    weights: new Array<number>(FEATURE_COUNT).fill(0),
    bias: 0,
    scaler: { mean: new Array<number>(FEATURE_COUNT).fill(0), std: new Array<number>(FEATURE_COUNT).fill(1) },
    encoders: {
      profile: { globalMean: 0.5, smoothing: 30, values: {} },
      method: { globalMean: 0.5, smoothing: 40, values: {} },
      segment: { globalMean: 0.5, smoothing: 40, values: {} },
      issuer: { globalMean: 0.5, smoothing: 25, values: {} },
      source: { globalMean: 0.5, smoothing: 40, values: {} },
    },
    calibrator: IDENTITY_CALIBRATOR,
    operatingThreshold: 0.5,
    balancedThreshold: 0.5,
    dataset: { totalRows: 0, trainRows: 0, validationRows: 0, testRows: 0, positiveRate: 0, seed: 0 },
    training: { epochsRun: 0, finalLoss: 0, converged: false, learningRate: 0, l2: 0 },
    evaluation: zeroReport,
    balancedClassification: zeroReport.classification,
    holdout: null,
  });
}

/**
 * The prior-only estimate the fallback path uses. Kept as a standalone function because
 * the strategy engine also uses it as a sanity bound on model output.
 */
export function priorEstimate(input: RecoveryFeatureInput): number {
  const successRatio =
    (input.customerSuccessCount + 1) / (input.customerSuccessCount + input.customerFailureCount + 2);
  const recoveryHistory =
    input.priorRecoveryAttempts > 0
      ? (input.priorRecoverySuccesses + 1) / (input.priorRecoveryAttempts + 2)
      : 0.5;
  const blended = 0.55 * input.baseRecoverability + 0.28 * successRatio + 0.17 * recoveryHistory;
  return clamp(round(blended, 4), 0.02, 0.95);
}

function emptyEvaluation(): EvaluationReport {
  return {
    classification: {
      threshold: 0.5,
      accuracy: 0,
      precision: 0,
      recall: 0,
      specificity: 0,
      f1: 0,
      matthewsCorrelation: 0,
      confusion: { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 },
      support: { positive: 0, negative: 0, total: 0 },
    },
    probabilistic: {
      rocAuc: 0,
      prAuc: 0,
      brierScore: 0,
      logLoss: 0,
      calibrationError: 0,
      baseRate: 0,
    },
    calibrationBins: [],
    cost: {
      falsePositiveCostMinor: 0,
      falseNegativeCostMinor: 0,
      totalCostMinor: 0,
      netValueMinor: 0,
      netValueInterveneAllMinor: 0,
      averageInterventionCostMinor: 0,
      averageRecoveredAmountMinor: 0,
    },
    thresholdSweep: [],
  };
}
