/**
 * Train the recovery-probability model on the seeded corpus.
 *
 *   npm run train
 *   npm run train -- --epochs 1500 --l2 0.0005
 *
 * Writes `data/model.json`, which the application loads at startup. Every metric printed
 * here is computed on data the model never saw during fitting.
 */
import { episodesToExamples } from '@reclaim/core/seed';
import {
  readHoldoutEpisodes,
  readTrainingEpisodes,
  writeModelArtifact,
} from '@reclaim/core/node';
import { formatMinor, trainRecoveryModel } from '@reclaim/core';
import { colors, loadEnv, parseArgs, percent, printTable, section } from './lib/cli.js';

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.string('data') ?? process.env.RECLAIM_DATA_DIR ?? 'data';

  const trainingEpisodes = readTrainingEpisodes(dataDir);
  const holdoutEpisodes = readHoldoutEpisodes(dataDir);

  if (trainingEpisodes.length === 0) {
    console.error(
      colors.red(
        `\nNo training episodes found in "${dataDir}". Run "npm run seed" first.\n`,
      ),
    );
    process.exit(1);
  }

  section('RECLAIM — recovery probability model');
  console.log(
    `${trainingEpisodes.length.toLocaleString('en-IN')} training episodes, ${holdoutEpisodes.length.toLocaleString('en-IN')} held-out evaluation episodes`,
  );

  const examples = episodesToExamples(trainingEpisodes);
  const holdout = episodesToExamples(holdoutEpisodes);

  const started = Date.now();
  const { artifact, splits } = trainRecoveryModel(
    examples,
    {
      seed: args.number('seed') ?? 20260901,
      version: args.string('version') ?? 'recovery-probability-v1',
      options: {
        ...(args.number('epochs') !== undefined ? { epochs: args.number('epochs')! } : {}),
        ...(args.number('l2') !== undefined ? { l2: args.number('l2')! } : {}),
        ...(args.number('lr') !== undefined ? { learningRate: args.number('lr')! } : {}),
      },
    },
    holdout,
  );
  const trainingMs = Date.now() - started;

  const path = writeModelArtifact(artifact, dataDir);

  section('Splits');
  printTable(
    ['split', 'rows', 'positive rate', 'purpose'],
    [
      [
        'train',
        splits.train.length.toLocaleString('en-IN'),
        percent(splits.train.reduce((s, e) => s + e.label, 0) / Math.max(1, splits.train.length)),
        'fit weights + categorical encoders',
      ],
      [
        'validation',
        splits.validation.length.toLocaleString('en-IN'),
        percent(
          splits.validation.reduce((s, e) => s + e.label, 0) / Math.max(1, splits.validation.length),
        ),
        'calibration + operating threshold',
      ],
      [
        'test',
        splits.test.length.toLocaleString('en-IN'),
        percent(splits.test.reduce((s, e) => s + e.label, 0) / Math.max(1, splits.test.length)),
        'reported metrics (read once)',
      ],
      [
        'holdout',
        holdout.length.toLocaleString('en-IN'),
        percent(holdout.reduce((s, e) => s + e.label, 0) / Math.max(1, holdout.length)),
        'independent episodes, disjoint payments',
      ],
    ],
  );

  const { classification: cls, probabilistic: prob, cost } = artifact.evaluation;

  section('Test-set metrics');
  printTable(
    ['metric', 'value'],
    [
      ['operating threshold', artifact.operatingThreshold.toFixed(2)],
      ['precision', cls.precision.toFixed(3)],
      ['recall', cls.recall.toFixed(3)],
      ['F1', cls.f1.toFixed(3)],
      ['accuracy', cls.accuracy.toFixed(3)],
      ['specificity', cls.specificity.toFixed(3)],
      ['Matthews correlation', cls.matthewsCorrelation.toFixed(3)],
      ['ROC AUC', prob.rocAuc.toFixed(3)],
      ['PR AUC', prob.prAuc.toFixed(3)],
      ['Brier score', prob.brierScore.toFixed(4)],
      ['log loss', prob.logLoss.toFixed(4)],
      ['calibration error (ECE)', prob.calibrationError.toFixed(4)],
      ['base rate', percent(prob.baseRate)],
    ],
  );

  const bal = artifact.balancedClassification;

  section('Two operating points');
  printTable(
    ['', `value-optimal (${artifact.operatingThreshold.toFixed(2)})`, `balanced (${artifact.balancedThreshold.toFixed(2)})`],
    [
      ['precision', cls.precision.toFixed(3), bal.precision.toFixed(3)],
      ['recall', cls.recall.toFixed(3), bal.recall.toFixed(3)],
      ['F1', cls.f1.toFixed(3), bal.f1.toFixed(3)],
      ['specificity', cls.specificity.toFixed(3), bal.specificity.toFixed(3)],
      ['Matthews correlation', cls.matthewsCorrelation.toFixed(3), bal.matthewsCorrelation.toFixed(3)],
    ],
  );
  for (const line of [
    '',
    'RECLAIM operates at the value-optimal point. It sits low because a retry costs a',
    'fraction of what a missed recovery costs, so acting is usually right — the binding',
    'constraint on action is the policy engine, not the classifier. The balanced point is',
    'reported because it is the one that shows how well the model separates the classes.',
  ]) {
    console.log(colors.dim(line));
  }

  section(`Confusion matrix at the balanced threshold (${artifact.balancedThreshold.toFixed(2)})`);
  printTable(
    ['', 'predicted recover', 'predicted lost'],
    [
      ['actually recovered', String(bal.confusion.truePositive), String(bal.confusion.falseNegative)],
      ['actually lost', String(bal.confusion.falsePositive), String(bal.confusion.trueNegative)],
    ],
  );

  section(`Confusion matrix at the operating threshold (${artifact.operatingThreshold.toFixed(2)})`);
  printTable(
    ['', 'predicted recover', 'predicted lost'],
    [
      ['actually recovered', String(cls.confusion.truePositive), String(cls.confusion.falseNegative)],
      ['actually lost', String(cls.confusion.falsePositive), String(cls.confusion.trueNegative)],
    ],
  );

  section('Cost of being wrong');
  printTable(
    ['metric', 'value', 'meaning'],
    [
      [
        'false-positive cost',
        formatMinor(cost.falsePositiveCostMinor, { whole: true }),
        'intervention spend on cases that never recover',
      ],
      [
        'false-negative cost',
        formatMinor(cost.falseNegativeCostMinor, { whole: true }),
        'revenue left on the table by not acting',
      ],
      [
        'net value at threshold',
        formatMinor(cost.netValueMinor, { whole: true }),
        'what the model earns versus doing nothing',
      ],
      [
        'net value intervening on all',
        formatMinor(cost.netValueInterveneAllMinor, { whole: true }),
        'the naive baseline the model must beat',
      ],
    ],
  );

  const upliftMinor = cost.netValueMinor - cost.netValueInterveneAllMinor;
  console.log(
    upliftMinor >= 0
      ? colors.green(
          `\nSelective intervention beats intervening on everything by ${formatMinor(upliftMinor, { whole: true })} on the test split.`,
        )
      : colors.yellow(
          `\nOn this split, intervening on everything would have earned ${formatMinor(-upliftMinor, { whole: true })} more. The value floor is doing more work than the model here.`,
        ),
  );

  if (artifact.holdout) {
    section('Held-out evaluation set (independent episodes)');
    printTable(
      ['metric', 'value'],
      [
        ['precision', artifact.holdout.classification.precision.toFixed(3)],
        ['recall', artifact.holdout.classification.recall.toFixed(3)],
        ['F1', artifact.holdout.classification.f1.toFixed(3)],
        ['ROC AUC', artifact.holdout.probabilistic.rocAuc.toFixed(3)],
        ['Brier score', artifact.holdout.probabilistic.brierScore.toFixed(4)],
        ['calibration error', artifact.holdout.probabilistic.calibrationError.toFixed(4)],
      ],
    );
  }

  section('Top learned weights');
  const ranked = artifact.weights
    .map((weight, index) => ({ feature: String(artifact.featureNames[index]), weight }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 10);
  printTable(
    ['feature', 'weight', 'direction'],
    ranked.map((r) => [
      r.feature,
      r.weight.toFixed(4),
      r.weight >= 0 ? 'raises recovery odds' : 'lowers recovery odds',
    ]),
  );

  console.log(
    `\nTrained in ${trainingMs}ms over ${artifact.training.epochsRun} epochs (converged: ${artifact.training.converged}).`,
  );
  console.log(`Artifact written to ${path}`);
  console.log('Next: npm run dev\n');
}

main().catch((error) => {
  console.error('\nTraining failed:', error);
  process.exit(1);
});
