/**
 * Generate the synthetic corpus and write it to `data/`.
 *
 *   npm run seed
 *   npm run seed -- --customers 2000 --payments 4000 --seed 7
 *
 * The output is fully determined by the seed, so two runs with the same flags produce
 * identical files. That is what lets the README quote specific numbers.
 */
import { DEFAULT_GENERATOR_OPTIONS, generateCorpus, type GeneratorOptions } from '@reclaim/core/seed';
import { exportCorpusCsv, writeCorpus, writeTrainingEpisodes } from '@reclaim/core/node';
import { formatMinorCompact } from '@reclaim/core';
import { loadEnv, parseArgs, printTable, section, formatBytes } from './lib/cli.js';

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const options: Partial<GeneratorOptions> = {
    seed: args.number('seed') ?? Number(process.env.RECLAIM_SEED ?? 20260901),
    merchantId: args.string('merchant') ?? process.env.RECLAIM_MERCHANT_ID ?? 'merch_reclaim_demo',
    customerCount: args.number('customers') ?? DEFAULT_GENERATOR_OPTIONS.customerCount,
    paymentCount: args.number('payments') ?? DEFAULT_GENERATOR_OPTIONS.paymentCount,
    trainingEpisodeCap: args.number('episodes') ?? DEFAULT_GENERATOR_OPTIONS.trainingEpisodeCap,
    holdoutEpisodeCap: args.number('holdout') ?? DEFAULT_GENERATOR_OPTIONS.holdoutEpisodeCap,
    historyDays: args.number('history-days') ?? DEFAULT_GENERATOR_OPTIONS.historyDays,
    liveWindowDays: args.number('live-days') ?? DEFAULT_GENERATOR_OPTIONS.liveWindowDays,
  };
  const dataDir = args.string('out') ?? process.env.RECLAIM_DATA_DIR ?? 'data';

  section('RECLAIM — synthetic corpus generation');
  console.log(
    `seed=${options.seed}  customers=${options.customerCount}  payments=${options.paymentCount}  history=${options.historyDays}d  live window=${options.liveWindowDays}d`,
  );

  const started = Date.now();
  const corpus = generateCorpus(options);
  const generationMs = Date.now() - started;

  const written = writeCorpus(corpus, dataDir);
  writeTrainingEpisodes(corpus.trainingEpisodes, dataDir);
  const csvFiles = args.boolean('no-csv') ? [] : exportCorpusCsv(corpus, dataDir);

  section('Corpus');
  printTable(
    ['collection', 'records', 'size'],
    written.files.map((f) => [f.file, f.records.toLocaleString('en-IN'), formatBytes(f.bytes)]),
  );

  if (csvFiles.length > 0) {
    section('CSV exports');
    printTable(
      ['file', 'rows'],
      csvFiles.map((f) => [f.file, f.rows.toLocaleString('en-IN')]),
    );
  }

  const stats = corpus.stats;
  section('Dataset shape');
  printTable(
    ['metric', 'value'],
    [
      ['history window', `${stats.historyFrom.slice(0, 10)} → ${stats.historyTo.slice(0, 10)}`],
      ['customers', stats.customers.toLocaleString('en-IN')],
      ['payments', stats.payments.toLocaleString('en-IN')],
      ['  captured', `${stats.capturedPayments.toLocaleString('en-IN')} (${formatMinorCompact(stats.grossCapturedMinor)})`],
      ['  failed', `${stats.failedPayments.toLocaleString('en-IN')} (${formatMinorCompact(stats.grossFailedMinor)})`],
      ['failure rate', `${(stats.failureRate * 100).toFixed(1)}%`],
      ['subscriptions', stats.subscriptions.toLocaleString('en-IN')],
      ['invoices', stats.invoices.toLocaleString('en-IN')],
      ['abandoned checkouts', stats.checkoutSessions.toLocaleString('en-IN')],
      ['historical recovery episodes', stats.historicalEpisodes.toLocaleString('en-IN')],
      ['  observed recovery rate', `${(stats.historicalRecoveryRate * 100).toFixed(1)}%`],
      ['held-out evaluation episodes', stats.holdoutEpisodes.toLocaleString('en-IN')],
      ['live failures awaiting detection', stats.liveFailuresAwaitingDetection.toLocaleString('en-IN')],
    ],
  );

  console.log(
    `\nGenerated in ${generationMs}ms, wrote ${formatBytes(written.totalBytes)} to ${written.dataDir}`,
  );
  console.log('Next: npm run train\n');
}

main().catch((error) => {
  console.error('\nSeed failed:', error);
  process.exit(1);
});
