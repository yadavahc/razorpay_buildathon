import { round } from '../util/collections.js';

/**
 * Evaluation metrics computed on a held-out test split.
 *
 * Nothing here is hard-coded or illustrative: `npm run train` writes these numbers into
 * the model artifact and the dashboard reads them back. If the dataset changes, the
 * numbers on screen change with it.
 */

export interface ConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

export interface ClassificationMetrics {
  threshold: number;
  accuracy: number;
  precision: number;
  recall: number;
  specificity: number;
  f1: number;
  matthewsCorrelation: number;
  confusion: ConfusionMatrix;
  support: { positive: number; negative: number; total: number };
}

export interface ProbabilisticMetrics {
  rocAuc: number;
  prAuc: number;
  brierScore: number;
  logLoss: number;
  /** Mean predicted probability minus observed rate; near zero means well calibrated. */
  calibrationError: number;
  baseRate: number;
}

export interface CalibrationBin {
  bucket: string;
  lower: number;
  upper: number;
  count: number;
  predictedMean: number;
  observedRate: number;
}

/**
 * Cost analysis is what turns a classifier into a business decision.
 *
 * A false positive means we spent an intervention on a case that was never going to
 * recover — we lose the intervention cost. A false negative means we declined to act on
 * a case that would have recovered — we lose the whole amount. The asymmetry is enormous,
 * which is why the operating threshold is chosen by net value rather than by F1.
 */
export interface CostAnalysis {
  falsePositiveCostMinor: number;
  falseNegativeCostMinor: number;
  totalCostMinor: number;
  /** Net value captured at this threshold versus doing nothing at all. */
  netValueMinor: number;
  /** Net value if we intervened on every single case, for comparison. */
  netValueInterveneAllMinor: number;
  averageInterventionCostMinor: number;
  averageRecoveredAmountMinor: number;
}

export interface EvaluationReport {
  classification: ClassificationMetrics;
  probabilistic: ProbabilisticMetrics;
  calibrationBins: CalibrationBin[];
  cost: CostAnalysis;
  /** Metrics recomputed at a grid of thresholds; drives the threshold-sweep chart. */
  thresholdSweep: Array<{
    threshold: number;
    precision: number;
    recall: number;
    f1: number;
    netValueMinor: number;
  }>;
}

export function confusionAt(
  probabilities: readonly number[],
  labels: readonly number[],
  threshold: number,
): ConfusionMatrix {
  const m: ConfusionMatrix = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  for (let i = 0; i < probabilities.length; i++) {
    const predicted = probabilities[i]! >= threshold ? 1 : 0;
    const actual = labels[i]!;
    if (predicted === 1 && actual === 1) m.truePositive++;
    else if (predicted === 1 && actual === 0) m.falsePositive++;
    else if (predicted === 0 && actual === 0) m.trueNegative++;
    else m.falseNegative++;
  }
  return m;
}

export function classificationMetrics(
  probabilities: readonly number[],
  labels: readonly number[],
  threshold: number,
): ClassificationMetrics {
  const c = confusionAt(probabilities, labels, threshold);
  const precision = safeDiv(c.truePositive, c.truePositive + c.falsePositive);
  const recall = safeDiv(c.truePositive, c.truePositive + c.falseNegative);
  const specificity = safeDiv(c.trueNegative, c.trueNegative + c.falsePositive);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const total = probabilities.length;
  const accuracy = safeDiv(c.truePositive + c.trueNegative, total);

  const mccDenominator = Math.sqrt(
    (c.truePositive + c.falsePositive) *
      (c.truePositive + c.falseNegative) *
      (c.trueNegative + c.falsePositive) *
      (c.trueNegative + c.falseNegative),
  );
  const mcc =
    mccDenominator === 0
      ? 0
      : (c.truePositive * c.trueNegative - c.falsePositive * c.falseNegative) / mccDenominator;

  return {
    threshold: round(threshold, 4),
    accuracy: round(accuracy),
    precision: round(precision),
    recall: round(recall),
    specificity: round(specificity),
    f1: round(f1),
    matthewsCorrelation: round(mcc),
    confusion: c,
    support: {
      positive: c.truePositive + c.falseNegative,
      negative: c.trueNegative + c.falsePositive,
      total,
    },
  };
}

/** Rank-based ROC AUC (Mann-Whitney U), tie-aware. */
export function rocAuc(probabilities: readonly number[], labels: readonly number[]): number {
  const paired = probabilities.map((p, i) => ({ p, y: labels[i]! }));
  paired.sort((a, b) => a.p - b.p);

  const ranks = new Array<number>(paired.length);
  let i = 0;
  while (i < paired.length) {
    let j = i;
    while (j + 1 < paired.length && paired[j + 1]!.p === paired[i]!.p) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = averageRank;
    i = j + 1;
  }

  let positives = 0;
  let rankSum = 0;
  for (let k = 0; k < paired.length; k++) {
    if (paired[k]!.y === 1) {
      positives++;
      rankSum += ranks[k]!;
    }
  }
  const negatives = paired.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  return round((rankSum - (positives * (positives + 1)) / 2) / (positives * negatives));
}

/** Average-precision approximation of the area under the precision-recall curve. */
export function prAuc(probabilities: readonly number[], labels: readonly number[]): number {
  const paired = probabilities
    .map((p, i) => ({ p, y: labels[i]! }))
    .sort((a, b) => b.p - a.p);
  const totalPositives = paired.reduce((sum, r) => sum + r.y, 0);
  if (totalPositives === 0) return 0;

  let truePositives = 0;
  let falsePositives = 0;
  let previousRecall = 0;
  let area = 0;

  for (const row of paired) {
    if (row.y === 1) truePositives++;
    else falsePositives++;
    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / totalPositives;
    area += precision * (recall - previousRecall);
    previousRecall = recall;
  }
  return round(area);
}

export function brierScore(probabilities: readonly number[], labels: readonly number[]): number {
  if (probabilities.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < probabilities.length; i++) sum += (probabilities[i]! - labels[i]!) ** 2;
  return round(sum / probabilities.length);
}

export function logLoss(probabilities: readonly number[], labels: readonly number[]): number {
  if (probabilities.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = Math.min(Math.max(probabilities[i]!, 1e-12), 1 - 1e-12);
    sum += -(labels[i]! * Math.log(p) + (1 - labels[i]!) * Math.log(1 - p));
  }
  return round(sum / probabilities.length);
}

export function calibrationBins(
  probabilities: readonly number[],
  labels: readonly number[],
  binCount = 10,
): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b++) {
    const lower = b / binCount;
    const upper = (b + 1) / binCount;
    const idx: number[] = [];
    for (let i = 0; i < probabilities.length; i++) {
      const p = probabilities[i]!;
      if (p >= lower && (b === binCount - 1 ? p <= upper : p < upper)) idx.push(i);
    }
    const count = idx.length;
    bins.push({
      bucket: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      lower,
      upper,
      count,
      predictedMean: count === 0 ? 0 : round(idx.reduce((s, i) => s + probabilities[i]!, 0) / count),
      observedRate: count === 0 ? 0 : round(idx.reduce((s, i) => s + labels[i]!, 0) / count),
    });
  }
  return bins;
}

export function expectedCalibrationError(bins: readonly CalibrationBin[], total: number): number {
  if (total === 0) return 0;
  let error = 0;
  for (const bin of bins) {
    error += (bin.count / total) * Math.abs(bin.predictedMean - bin.observedRate);
  }
  return round(error);
}

export interface CostInputs {
  /** Per-row amount at risk, aligned with `probabilities`. */
  amountsMinor: readonly number[];
  /** Per-row intervention cost if we act on it. */
  interventionCostsMinor: readonly number[];
}

export function costAnalysis(
  probabilities: readonly number[],
  labels: readonly number[],
  inputs: CostInputs,
  threshold: number,
): CostAnalysis {
  let falsePositiveCost = 0;
  let falseNegativeCost = 0;
  let netValue = 0;
  let netValueAll = 0;
  let interventionCostSum = 0;
  let recoveredSum = 0;
  let recoveredCount = 0;

  for (let i = 0; i < probabilities.length; i++) {
    const act = probabilities[i]! >= threshold;
    const recovers = labels[i]! === 1;
    const amount = inputs.amountsMinor[i] ?? 0;
    const cost = inputs.interventionCostsMinor[i] ?? 0;

    interventionCostSum += cost;
    if (recovers) {
      recoveredSum += amount;
      recoveredCount++;
    }

    netValueAll += (recovers ? amount : 0) - cost;

    if (act && recovers) netValue += amount - cost;
    else if (act && !recovers) {
      falsePositiveCost += cost;
      netValue -= cost;
    } else if (!act && recovers) {
      falseNegativeCost += amount;
    }
  }

  return {
    falsePositiveCostMinor: Math.round(falsePositiveCost),
    falseNegativeCostMinor: Math.round(falseNegativeCost),
    totalCostMinor: Math.round(falsePositiveCost + falseNegativeCost),
    netValueMinor: Math.round(netValue),
    netValueInterveneAllMinor: Math.round(netValueAll),
    averageInterventionCostMinor:
      probabilities.length === 0 ? 0 : Math.round(interventionCostSum / probabilities.length),
    averageRecoveredAmountMinor: recoveredCount === 0 ? 0 : Math.round(recoveredSum / recoveredCount),
  };
}

/**
 * Choose the operating threshold that maximises net recovered value on a validation
 * split. This is the single most consequential hyper-parameter in the system, and
 * picking it by money rather than by F1 is the point.
 */
export function selectOperatingThreshold(
  probabilities: readonly number[],
  labels: readonly number[],
  inputs: CostInputs,
): { threshold: number; netValueMinor: number } {
  let best = { threshold: 0.5, netValueMinor: Number.NEGATIVE_INFINITY };
  for (let t = 5; t <= 90; t += 1) {
    const threshold = t / 100;
    const analysis = costAnalysis(probabilities, labels, inputs, threshold);
    if (analysis.netValueMinor > best.netValueMinor) {
      best = { threshold, netValueMinor: analysis.netValueMinor };
    }
  }
  return best;
}

/**
 * The threshold that maximises F1.
 *
 * RECLAIM does not operate here — it operates at the value-maximising point — but the
 * two are reported side by side because they answer different questions. The balanced
 * threshold says how well the model *separates* the classes; the value threshold says
 * where to *act*. Quoting only one of them tells half the story, and it is usually the
 * half that flatters the model.
 */
export function selectBalancedThreshold(
  probabilities: readonly number[],
  labels: readonly number[],
): { threshold: number; f1: number } {
  let best = { threshold: 0.5, f1: -1 };
  for (let t = 5; t <= 95; t += 1) {
    const threshold = t / 100;
    const { f1 } = classificationMetrics(probabilities, labels, threshold);
    if (f1 > best.f1) best = { threshold, f1 };
  }
  return best;
}

export function evaluate(
  probabilities: readonly number[],
  labels: readonly number[],
  inputs: CostInputs,
  threshold: number,
): EvaluationReport {
  const bins = calibrationBins(probabilities, labels);
  const baseRate = labels.length === 0 ? 0 : labels.reduce((s, y) => s + y, 0) / labels.length;

  const sweep: EvaluationReport['thresholdSweep'] = [];
  for (let t = 5; t <= 90; t += 5) {
    const th = t / 100;
    const cm = classificationMetrics(probabilities, labels, th);
    const ca = costAnalysis(probabilities, labels, inputs, th);
    sweep.push({
      threshold: th,
      precision: cm.precision,
      recall: cm.recall,
      f1: cm.f1,
      netValueMinor: ca.netValueMinor,
    });
  }

  return {
    classification: classificationMetrics(probabilities, labels, threshold),
    probabilistic: {
      rocAuc: rocAuc(probabilities, labels),
      prAuc: prAuc(probabilities, labels),
      brierScore: brierScore(probabilities, labels),
      logLoss: logLoss(probabilities, labels),
      calibrationError: expectedCalibrationError(bins, labels.length),
      baseRate: round(baseRate),
    },
    calibrationBins: bins,
    cost: costAnalysis(probabilities, labels, inputs, threshold),
    thresholdSweep: sweep,
  };
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
