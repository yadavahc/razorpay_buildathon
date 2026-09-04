/**
 * A small, dependency-free logistic regression trained with Adam and L2 regularisation.
 *
 * The choice is deliberate. A gradient-boosted ensemble would score a point or two higher
 * on AUC, but this model is *auditable*: every prediction decomposes into per-feature
 * logit contributions that a merchant can read in the Decision Inspector, and the whole
 * artifact is a few kilobytes of JSON that ships with the repository. For a system whose
 * output authorises spending money, explainability beats the last point of AUC.
 */

export interface TrainOptions {
  learningRate: number;
  epochs: number;
  l2: number;
  /** Weight applied to positive examples; corrects for class imbalance. */
  positiveWeight: number;
  tolerance: number;
  verbose?: (epoch: number, loss: number) => void;
}

export const DEFAULT_TRAIN_OPTIONS: TrainOptions = {
  learningRate: 0.08,
  epochs: 900,
  l2: 1e-4,
  positiveWeight: 1,
  tolerance: 1e-7,
};

export interface LogisticModel {
  weights: number[];
  bias: number;
  /** Loss at the final epoch; recorded so training runs are comparable over time. */
  finalLoss: number;
  epochsRun: number;
  converged: boolean;
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predictLogit(model: Pick<LogisticModel, 'weights' | 'bias'>, x: readonly number[]): number {
  let z = model.bias;
  for (let j = 0; j < x.length; j++) z += model.weights[j]! * x[j]!;
  return z;
}

export function predictProbability(
  model: Pick<LogisticModel, 'weights' | 'bias'>,
  x: readonly number[],
): number {
  return sigmoid(predictLogit(model, x));
}

/** Per-feature logit contribution, the basis of every explanation the UI renders. */
export function contributions(
  model: Pick<LogisticModel, 'weights' | 'bias'>,
  x: readonly number[],
): number[] {
  return x.map((value, j) => model.weights[j]! * value);
}

export function trainLogistic(
  X: readonly number[][],
  y: readonly number[],
  options: Partial<TrainOptions> = {},
): LogisticModel {
  const opts = { ...DEFAULT_TRAIN_OPTIONS, ...options };
  const n = X.length;
  if (n === 0) throw new Error('trainLogistic: empty training set');
  const d = X[0]!.length;

  const weights = new Array<number>(d).fill(0);
  let bias = 0;

  // Adam moments.
  const mW = new Array<number>(d).fill(0);
  const vW = new Array<number>(d).fill(0);
  let mB = 0;
  let vB = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;

  const sampleWeight = (label: number): number => (label === 1 ? opts.positiveWeight : 1);
  let totalWeight = 0;
  for (const label of y) totalWeight += sampleWeight(label);

  let previousLoss = Number.POSITIVE_INFINITY;
  let finalLoss = 0;
  let epochsRun = 0;
  let converged = false;

  for (let epoch = 1; epoch <= opts.epochs; epoch++) {
    const gradW = new Array<number>(d).fill(0);
    let gradB = 0;
    let loss = 0;

    for (let i = 0; i < n; i++) {
      const row = X[i]!;
      const label = y[i]!;
      const w = sampleWeight(label);
      const p = sigmoid(predictLogit({ weights, bias }, row));
      const clipped = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
      loss += -w * (label * Math.log(clipped) + (1 - label) * Math.log(1 - clipped));
      const error = (p - label) * w;
      for (let j = 0; j < d; j++) gradW[j]! += error * row[j]!;
      gradB += error;
    }

    loss /= totalWeight;
    for (let j = 0; j < d; j++) {
      gradW[j] = gradW[j]! / totalWeight + opts.l2 * weights[j]!;
      loss += (opts.l2 / 2) * weights[j]! ** 2;
    }
    gradB /= totalWeight;

    const biasCorrection1 = 1 - beta1 ** epoch;
    const biasCorrection2 = 1 - beta2 ** epoch;

    for (let j = 0; j < d; j++) {
      mW[j] = beta1 * mW[j]! + (1 - beta1) * gradW[j]!;
      vW[j] = beta2 * vW[j]! + (1 - beta2) * gradW[j]! ** 2;
      const mHat = mW[j]! / biasCorrection1;
      const vHat = vW[j]! / biasCorrection2;
      weights[j]! -= (opts.learningRate * mHat) / (Math.sqrt(vHat) + eps);
    }
    mB = beta1 * mB + (1 - beta1) * gradB;
    vB = beta2 * vB + (1 - beta2) * gradB ** 2;
    bias -= (opts.learningRate * (mB / biasCorrection1)) / (Math.sqrt(vB / biasCorrection2) + eps);

    finalLoss = loss;
    epochsRun = epoch;
    opts.verbose?.(epoch, loss);

    if (Math.abs(previousLoss - loss) < opts.tolerance) {
      converged = true;
      break;
    }
    previousLoss = loss;
  }

  return { weights, bias, finalLoss, epochsRun, converged };
}

/**
 * Platt-style calibration on a held-out split. Raw logistic outputs are usually close to
 * calibrated already, but the recovery model's decisions are multiplied by rupee amounts,
 * so a systematic 5% optimism would silently distort every expected-value calculation.
 */
export interface Calibrator {
  slope: number;
  intercept: number;
}

export const IDENTITY_CALIBRATOR: Calibrator = { slope: 1, intercept: 0 };

export function fitCalibrator(rawProbabilities: readonly number[], y: readonly number[]): Calibrator {
  const logits = rawProbabilities.map((p) => {
    const clipped = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
    return Math.log(clipped / (1 - clipped));
  });
  const model = trainLogistic(
    logits.map((z) => [z]),
    y,
    { learningRate: 0.05, epochs: 500, l2: 1e-6 },
  );
  return { slope: model.weights[0]!, intercept: model.bias };
}

export function applyCalibration(calibrator: Calibrator, probability: number): number {
  const clipped = Math.min(Math.max(probability, 1e-9), 1 - 1e-9);
  const logit = Math.log(clipped / (1 - clipped));
  return sigmoid(calibrator.slope * logit + calibrator.intercept);
}
