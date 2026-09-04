/**
 * Verify the Firestore integration against the configured project.
 *
 *   npm run check:firestore
 *
 * Writes a handful of documents into a throwaway namespace, exercises the two operations
 * that are easy to get wrong — the transactional idempotency claim and the transactional
 * audit-chain append — reads them back, verifies the chain, and then deletes everything
 * it created.
 *
 * Deliberately small. It proves the adapter works against a real project without
 * consuming the write quota that seeding the full corpus would.
 */
import { createFirestoreDataStore } from '@reclaim/core/node';
import { loadConfig, verifyAuditChain } from '@reclaim/core';
import { colors, loadEnv, printTable, section } from './lib/cli.js';

const NAMESPACE = 'reclaim_check';

async function main(): Promise<void> {
  loadEnv();
  const config = loadConfig({ ...process.env, RECLAIM_STORE: 'firestore' });

  section('RECLAIM — Firestore connectivity check');
  console.log(`project: ${config.firebase.projectId}`);
  console.log(
    `credentials: ${
      config.firebase.emulatorHost
        ? `emulator at ${config.firebase.emulatorHost}`
        : config.firebase.usesAdc
          ? 'application default (GOOGLE_APPLICATION_CREDENTIALS)'
          : 'inline service account'
    }`,
  );
  console.log(colors.dim(`namespace: ${NAMESPACE}_* (created and deleted by this script)\n`));

  const started = Date.now();
  const store = await createFirestoreDataStore(config.firebase, NAMESPACE);
  const merchantId = 'merch_connectivity_check';

  const results: Array<[string, string, string]> = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    results.push([name, ok ? 'PASS' : 'FAIL', detail]);
    if (!ok) process.exitCode = 1;
  };

  // Clear first, not just afterwards. A previous run that crashed before its cleanup
  // would otherwise leave audit entries behind and the chain check would report their
  // sequence numbers as a break — a false failure caused by the harness, not the code.
  await store.reset();

  // --- 1. Write and read back -----------------------------------------------
  const nowIso = new Date().toISOString();
  await store.merchants.put({
    id: merchantId,
    name: 'Connectivity Check',
    legalName: 'Connectivity Check Pvt Ltd',
    mcc: '5817',
    currency: 'INR',
    createdAt: nowIso,
    policyOverrides: {},
  });
  const readBack = await store.merchants.get(merchantId);
  check('write + read', readBack?.name === 'Connectivity Check', `round-tripped ${merchantId}`);

  // --- 2. Query with a filter -----------------------------------------------
  const queried = await store.merchants.list({
    where: [{ field: 'id', op: '==', value: merchantId }],
  });
  check('filtered query', queried.length === 1, `${queried.length} document(s) matched`);

  // --- 3. Transactional idempotency claim -----------------------------------
  // The critical property: concurrent callers racing on one key, exactly one winner.
  const key = `idem_check_${Date.now()}`;
  const race = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.claimIdempotency({ key, merchantId, scope: 'check', actionId: `act_${i}` }),
    ),
  );
  const winners = race.filter((r) => r.claimed).length;
  check(
    'idempotency transaction',
    winners === 1,
    `${winners} of 8 concurrent claims succeeded (must be exactly 1)`,
  );

  await store.settleIdempotency(key, 'succeeded', 'check-ref');
  const settled = await store.getIdempotency(key);
  check('idempotency settle', settled?.status === 'succeeded', `status ${settled?.status}`);

  // --- 4. Transactional hash-chained audit append ---------------------------
  for (let i = 0; i < 5; i++) {
    await store.appendAudit({
      merchantId,
      actor: { kind: 'system', id: 'connectivity_check' },
      event: `check.step_${i}`,
      trigger: 'firestore connectivity check',
      amountMinor: i * 1_000,
    });
  }
  const logs = await store.auditLogs.list({
    where: [{ field: 'merchantId', op: '==', value: merchantId }],
  });
  const chain = verifyAuditChain(logs);
  check(
    'audit chain',
    chain.valid && logs.length === 5,
    `${logs.length} entries, chain ${chain.valid ? 'verified' : `BROKEN: ${chain.reason}`}`,
  );

  const sequences = logs.map((l) => l.seq).sort((a, b) => a - b);
  check(
    'sequence assignment',
    JSON.stringify(sequences) === JSON.stringify([0, 1, 2, 3, 4]),
    `sequences ${sequences.join(', ')}`,
  );

  // --- 5. Batched write ------------------------------------------------------
  const batchStart = Date.now();
  await store.customers.putMany(
    Array.from({ length: 20 }, (_, i) => ({
      id: `cust_check_${i}`,
      merchantId,
      name: `Check Customer ${i}`,
      email: `check${i}@example.test`,
      phone: '+919800000000',
      segment: 'consumer' as const,
      createdAt: nowIso,
      lifetimeValueMinor: 0,
      successfulPaymentCount: 0,
      failedPaymentCount: 0,
      priorRecoveryAttempts: 0,
      priorRecoverySuccesses: 0,
      lastSuccessfulPaymentAt: null,
      lastFailedPaymentAt: null,
      preferredMethod: 'upi' as const,
      contactPreference: 'email' as const,
      contactOptOut: false,
      doNotRetry: false,
      chargebackCount: 0,
      timezone: 'Asia/Kolkata',
    })),
  );
  const customerCount = await store.customers.count();
  check(
    'batched write',
    customerCount === 20,
    `${customerCount} documents in one batch, ${Date.now() - batchStart}ms`,
  );

  section('Results');
  printTable(['check', 'result', 'detail'], results);

  // --- Clean up --------------------------------------------------------------
  console.log('\nCleaning up the check namespace...');
  await store.reset();
  const remaining = await store.merchants.count();
  console.log(
    remaining === 0
      ? colors.green('Namespace removed; nothing left behind.')
      : colors.yellow(`${remaining} document(s) remain — remove ${NAMESPACE}_* manually.`),
  );

  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(
    failed === 0
      ? colors.green(`\nFirestore integration verified in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`)
      : colors.red(`\n${failed} check(s) failed.\n`),
  );
}

main().catch((error) => {
  console.error(colors.red('\nFirestore check failed:'), error instanceof Error ? error.message : error);
  console.error(
    colors.dim(
      '\nCommon causes: the Firestore database has not been created in the console yet,\n' +
        'the service account lacks the Cloud Datastore User role, or the project id is wrong.\n',
    ),
  );
  process.exit(1);
});
