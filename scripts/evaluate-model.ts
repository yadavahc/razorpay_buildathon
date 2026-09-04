/**
 * Evaluate the trained model against the held-out episodes.
 *
 *   npm run evaluate
 *
 * Beyond the usual metrics, this reports two reference points that make the headline
 * numbers interpretable:
 *
 *   ORACLE   — AUC achieved by scoring with the latent probability the outcomes were
 *              actually drawn against. Because the generative process includes noise the
 *              features cannot see (customer responsiveness, per-event shocks), no model
 *              can exceed this. It is the ceiling.
 *   BASELINE — AUC from the failure-taxonomy prior alone, with no learning at all. This
 *              is the floor a model must clear to have earned its place.
 *
 * A model sitting close to the oracle and well above the baseline is doing its job. A
 * headline AUC quoted without either reference is close to meaningless, which is why
 * both are printed here and surfaced on the model page in the app.
 */
import { episodesToExamples } from '@reclaim/core/seed';
import { readHoldoutEpisodes, readModelArtifact, readTrainingEpisodes } from '@reclaim/core/node';
import {
  RecoveryModel,
  brierScore,
  classificationMetrics,
  evaluate,
  formatMinor,
  rocAuc,
} from '@reclaim/core';
import { colors, loadEnv, parseArgs, percent, printTable, section } from './lib/cli.js';

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.string('data') ?? process.env.RECLAIM_DATA_DIR ?? 'data';

  const artifact = readModelArtifact(dataDir);
  if (!artifact) {
    console.error(colors.red('\nNo model artifact found. Run "npm run train" first.\n'));
    process.exit(1);
  }

  const holdoutEpisodes = readHoldoutEpisodes(dataDir);
  const trainingEpisodes = readTrainingEpisodes(dataDir);
  if (holdoutEpisodes.length === 0) {
    console.error(colors.red('\nNo held-out episodes found. Run "npm run seed" first.\n'));
    process.exit(1);
  }

  const model = RecoveryModel.fromArtifact(artifact);
  const examples = episodesToExamples(holdoutEpisodes);
  const labels = examples.map((e) => e.label);

  const predictions = examples.map((e) => model.predict(e.features).probability);
  const report = evaluate(
    predictions,
    labels,
    {
      amountsMinor: examples.map((e) => e.amountMinor),
      interventionCostsMinor: examples.map((e) => e.interventionCostMinor),
    },
    artifact.operatingThreshold,
  );

  // Reference points.
  const oracleScores = holdoutEpisodes.map((e) => e.latentProbability);
  const baselineScores = examples.map((e) => e.features.baseRecoverability);

  const modelAuc = report.probabilistic.rocAuc;
  const oracleAuc = rocAuc(oracleScores, labels);
  const baselineAuc = rocAuc(baselineScores, labels);
  const achievable = oracleAuc - 0.5;
  const captured = achievable <= 0 ? 0 : (modelAuc - 0.5) / achievable;

  section('RECLAIM — held-out evaluation');
  console.log(
    `model ${artifact.version}, trained ${artifact.trainedAt.slice(0, 19).replace('T', ' ')} UTC on ${artifact.dataset.trainRows.toLocaleString('en-IN')} rows`,
  );
  console.log(
    `evaluating ${holdoutEpisodes.length.toLocaleString('en-IN')} held-out episodes drawn from payments disjoint from the ${trainingEpisodes.length.toLocaleString('en-IN')} training episodes`,
  );

  section('Discrimination against its reference points');
  printTable(
    ['scorer', 'ROC AUC', 'Brier', 'what it represents'],
    [
      [
        'taxonomy prior only',
        baselineAuc.toFixed(3),
        brierScore(baselineScores, labels).toFixed(4),
        'no learning — the floor',
      ],
      [
        'trained model',
        modelAuc.toFixed(3),
        report.probabilistic.brierScore.toFixed(4),
        'what actually ships',
      ],
      [
        'oracle (latent truth)',
        oracleAuc.toFixed(3),
        brierScore(oracleScores, labels).toFixed(4),
        'unreachable ceiling — noise sets it',
      ],
    ],
  );
  console.log(
    `\nThe model captures ${percent(captured)} of the discrimination that is theoretically available above chance.`,
  );
  console.log(
    colors.dim(
      'The remaining gap is customer responsiveness and per-event shocks, which the generative process hides from the feature set by design.',
    ),
  );

  section('Classification at the operating threshold');
  printTable(
    ['metric', 'value'],
    [
      ['threshold', artifact.operatingThreshold.toFixed(2)],
      ['precision', report.classification.precision.toFixed(3)],
      ['recall', report.classification.recall.toFixed(3)],
      ['F1', report.classification.f1.toFixed(3)],
      ['specificity', report.classification.specificity.toFixed(3)],
      ['accuracy', report.classification.accuracy.toFixed(3)],
      ['Matthews correlation', report.classification.matthewsCorrelation.toFixed(3)],
    ],
  );

  section('Calibration');
  printTable(
    ['predicted band', 'cases', 'mean predicted', 'observed rate', 'gap'],
    report.calibrationBins
      .filter((bin) => bin.count > 0)
      .map((bin) => [
        bin.bucket,
        String(bin.count),
        percent(bin.predictedMean),
        percent(bin.observedRate),
        `${bin.predictedMean - bin.observedRate >= 0 ? '+' : ''}${percent(bin.predictedMean - bin.observedRate)}`,
      ]),
  );
  console.log(
    `\nExpected calibration error ${report.probabilistic.calibrationError.toFixed(4)} — the average distance between what the model promises and what happens.`,
  );

  section('Threshold sweep (net recovered value)');
  printTable(
    ['threshold', 'precision', 'recall', 'F1', 'net value'],
    report.thresholdSweep.map((row) => [
      row.threshold.toFixed(2),
      row.precision.toFixed(3),
      row.recall.toFixed(3),
      row.f1.toFixed(3),
      formatMinor(row.netValueMinor, { whole: true }),
    ]),
  );

  const bestByF1 = report.thresholdSweep.reduce((a, b) => (b.f1 > a.f1 ? b : a));
  const bestByValue = report.thresholdSweep.reduce((a, b) =>
    b.netValueMinor > a.netValueMinor ? b : a,
  );
  console.log(
    `\nBest F1 sits at threshold ${bestByF1.threshold.toFixed(2)}, but the best NET VALUE sits at ${bestByValue.threshold.toFixed(2)} — worth ${formatMinor(bestByValue.netValueMinor - bestByF1.netValueMinor, { whole: true })} more.`,
  );
  console.log(
    colors.dim(
      'That divergence is why RECLAIM selects its operating point by rupees rather than by F1: a retry costs a fraction of what a missed recovery costs, so the economically correct threshold is far below the balanced-accuracy one.',
    ),
  );

  section('Cost of being wrong on the held-out set');
  printTable(
    ['metric', 'value'],
    [
      ['false-positive cost', formatMinor(report.cost.falsePositiveCostMinor, { whole: true })],
      ['false-negative cost', formatMinor(report.cost.falseNegativeCostMinor, { whole: true })],
      ['net value at operating threshold', formatMinor(report.cost.netValueMinor, { whole: true })],
      ['net value if we acted on everything', formatMinor(report.cost.netValueInterveneAllMinor, { whole: true })],
      ['average recovered amount', formatMinor(report.cost.averageRecoveredAmountMinor, { whole: true })],
    ],
  );

  const perClass = classificationMetrics(predictions, labels, 0.5);
  console.log(
    colors.dim(
      `\nFor reference, at a naive 0.5 threshold the same model scores precision ${perClass.precision.toFixed(3)} / recall ${perClass.recall.toFixed(3)} / F1 ${perClass.f1.toFixed(3)}.\n`,
    ),
  );
}

main().catch((error) => {
  console.error('\nEvaluation failed:', error);
  process.exit(1);
});
