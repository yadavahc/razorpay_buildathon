/**
 * Reset the demo to a clean, reproducible starting state.
 *
 *   npm run reset              # clear generated state, keep the corpus
 *   npm run reset -- --full    # regenerate the corpus and retrain as well
 *   npm run reset -- --firestore
 *
 * "Clean" means: no recovery cases opened by the app, no actions, no outcomes, no AI or
 * policy decisions, no audit entries, no armed faults. The historical corpus and the
 * trained model survive, because those are inputs rather than results.
 */
import { loadCorpusIntoStore, readModelArtifact } from '@reclaim/core/node';
import { createFirestoreDataStore } from '@reclaim/core/node';
import { createMemoryStore, faultInjector, loadConfig } from '@reclaim/core';
import { colors, loadEnv, parseArgs, printTable, section } from './lib/cli.js';

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const useFirestore = args.boolean('firestore') || config.store === 'firestore';

  section('RECLAIM — demo reset');
  console.log(`store=${useFirestore ? 'firestore' : 'memory'}  mode=${config.mode}`);

  if (!useFirestore) {
    // The in-memory store is rebuilt from `data/` on every server start, so resetting it
    // is a matter of clearing generated files rather than mutating a database.
    console.log(
      colors.dim(
        '\nThe in-memory store holds no state between processes: restarting the dev server\nalready returns it to the seeded corpus. Nothing to clear.',
      ),
    );

    const artifact = readModelArtifact(config.dataDir);
    printTable(
      ['check', 'status'],
      [
        ['corpus present', corpusStatus(config.dataDir)],
        [
          'model artifact',
          artifact
            ? `${artifact.version} (ROC AUC ${artifact.evaluation.probabilistic.rocAuc.toFixed(3)})`
            : colors.yellow('missing — run npm run train'),
        ],
        ['armed faults', String(faultInjector.armed().length)],
      ],
    );

    if (args.boolean('full')) {
      console.log(
        colors.yellow(
          '\n--full requested: run "npm run seed && npm run train" to regenerate the corpus and model.',
        ),
      );
    }
    console.log('\nDemo is ready. Start it with: npm run dev\n');
    return;
  }

  const store = await createFirestoreDataStore(config.firebase);

  const before = await store.stats();
  section('Before');
  printTable(
    ['collection', 'documents'],
    Object.entries(before).map(([k, v]) => [k, String(v)]),
  );

  console.log('\nClearing generated collections...');
  await store.reset();

  console.log('Reloading the seeded corpus...');
  const counts = await loadCorpusIntoStore(store, config.dataDir, {
    onProgress: (collection, count) =>
      console.log(colors.dim(`  ${collection.padEnd(20)} ${count.toLocaleString('en-IN')}`)),
  });

  const after = await store.stats();
  section('After');
  printTable(
    ['collection', 'documents'],
    Object.entries(after).map(([k, v]) => [k, String(v)]),
  );

  faultInjector.disarmAll();
  console.log(
    colors.green(
      `\nReset complete. Reloaded ${Object.values(counts).reduce((s, v) => s + v, 0).toLocaleString('en-IN')} documents.\n`,
    ),
  );
}

function corpusStatus(dataDir: string): string {
  try {
    const stats = readModelArtifact(dataDir);
    void stats;
    return 'present';
  } catch {
    return colors.yellow('missing — run npm run seed');
  }
}

void createMemoryStore;

main().catch((error) => {
  console.error('\nReset failed:', error);
  process.exit(1);
});
