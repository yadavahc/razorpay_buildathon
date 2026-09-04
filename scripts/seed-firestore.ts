/**
 * Load the generated corpus into Cloud Firestore.
 *
 *   npm run seed:firestore
 *   npm run seed:firestore -- --clear
 *
 * Requires FIREBASE_PROJECT_ID plus either a service-account key, Application Default
 * Credentials, or FIRESTORE_EMULATOR_HOST. Writes go through batched commits, so a
 * 24,000-payment corpus lands in a few dozen round trips rather than 24,000.
 */
import { createFirestoreDataStore, corpusExists, loadCorpusIntoStore } from '@reclaim/core/node';
import { loadConfig } from '@reclaim/core';
import { colors, loadEnv, parseArgs, printTable, section } from './lib/cli.js';

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ ...process.env, RECLAIM_STORE: 'firestore' });

  section('RECLAIM — Firestore seeding');
  console.log(
    `project=${config.firebase.projectId}  ${config.firebase.emulatorHost ? `emulator=${config.firebase.emulatorHost}` : 'target=production project'}`,
  );

  if (!corpusExists(config.dataDir)) {
    console.error(
      colors.red(`\nNo corpus found in "${config.dataDir}". Run "npm run seed" first.\n`),
    );
    process.exit(1);
  }

  if (!config.firebase.emulatorHost) {
    console.log(
      colors.yellow(
        '\nWriting to a real Firestore project. This will create documents and consume quota.',
      ),
    );
  }

  const store = await createFirestoreDataStore(config.firebase);

  if (args.boolean('clear')) {
    console.log('\nClearing existing collections...');
    await store.reset();
  }

  console.log('\nUploading...');
  const started = Date.now();
  const counts = await loadCorpusIntoStore(store, config.dataDir, {
    onProgress: (collection, count) =>
      console.log(colors.dim(`  ${collection.padEnd(20)} ${count.toLocaleString('en-IN')}`)),
  });
  const durationMs = Date.now() - started;

  const stats = await store.stats();
  section('Firestore contents');
  printTable(
    ['collection', 'documents'],
    Object.entries(stats).map(([k, v]) => [k, v.toLocaleString('en-IN')]),
  );

  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  console.log(
    colors.green(
      `\nUploaded ${total.toLocaleString('en-IN')} documents in ${(durationMs / 1000).toFixed(1)}s.`,
    ),
  );
  console.log('Set RECLAIM_STORE=firestore in .env.local to serve the app from Firestore.\n');
}

main().catch((error) => {
  console.error('\nFirestore seeding failed:', error);
  process.exit(1);
});
