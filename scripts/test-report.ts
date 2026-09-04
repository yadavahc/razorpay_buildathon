/**
 * Run the test suite and publish its results for the System Quality page.
 *
 *   npm run test:report
 *
 * The page reads the file this writes. That indirection is deliberate: a pass rate that
 * lives in the UI source is not evidence of anything, and a page that shows "no report
 * found" until the suite has actually been run is more honest than one that always shows
 * a green badge.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { colors, loadEnv, printTable, section } from './lib/cli.js';

interface VitestAssertion {
  status: 'passed' | 'failed' | 'pending' | 'skipped';
  title: string;
  duration?: number;
}

interface VitestSuite {
  name: string;
  status: 'passed' | 'failed';
  startTime?: number;
  endTime?: number;
  assertionResults: VitestAssertion[];
}

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  startTime: number;
  testResults: VitestSuite[];
  success: boolean;
}

/**
 * What each test category exists to catch. Shown on the quality page so a reader knows
 * what the numbers cover rather than just how many there are.
 */
const CATEGORIES: Record<string, { label: string; description: string }> = {
  unit: {
    label: 'Unit',
    description:
      'The deterministic core in isolation: the policy engine against every guardrail, the expected-value engine asserted to the rupee, integer money arithmetic, the audit hash chain, and the internal consistency of the failure taxonomy.',
  },
  integration: {
    label: 'Integration',
    description:
      'The persistence layer and the services on top of it, running against a real store: repository semantics, atomic idempotency claims under concurrency, case-lifecycle transitions, detection across all four loss channels, and analytics that agree with the underlying records.',
  },
  agent: {
    label: 'Agent',
    description:
      'Whether the agent can do something it should not: tool authorisation by scope, argument validation against hostile input, idempotent tool calls, tool-failure handling, and the guarantee that the analyst agent holds no write scope at all.',
  },
  e2e: {
    label: 'End-to-end',
    description:
      'The complete pipeline — failure, detection, prediction, AI decision, policy, action, outcome — with nothing stubbed but the outside world. Includes batch processing and the assertion that money is booked exactly once.',
  },
  failure: {
    label: 'Failure injection',
    description:
      'Every fault the Failure Lab can arm, asserted to produce a recovery rather than a crash: timeouts, gateway errors, duplicate requests, invalid transactions, model outages and policy rejections.',
  },
};

/** Vitest's CLI wants forward slashes even on Windows. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function categoryOf(file: string): string {
  const normalised = file.replace(/\\/g, '/');
  for (const key of Object.keys(CATEGORIES)) {
    if (normalised.includes(`/tests/${key}/`)) return key;
  }
  return 'unit';
}

function suiteName(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? file;
  return base
    .replace(/\.test\.ts$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

async function main(): Promise<void> {
  loadEnv();
  const repoRoot = process.cwd();
  const rawRelative = 'node_modules/.tmp/vitest-report.json';
  const rawPath = join(repoRoot, rawRelative);
  mkdirSync(dirname(rawPath), { recursive: true });

  section('RECLAIM — test suite');
  console.log('Running every suite. This executes the real pipeline, not a mock of it.\n');

  const started = Date.now();
  let suiteFailed = false;

  try {
    // Vitest's binary is invoked through Node directly rather than through `npx`.
    // On Windows the npx shim is a `.cmd`, which `execFileSync` has refused to spawn
    // without a shell since Node 18.20, and going through a shell would mean quoting a
    // repository path that contains a space.
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        // Two reporters at once needs the per-reporter output form, so the human-readable
        // run still streams to the terminal while the JSON is captured for the report.
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${rawRelative}`,
      ],
      { stdio: 'inherit', cwd: repoRoot },
    );
  } catch {
    // A failing suite still produces a report, and the report is the point.
    suiteFailed = true;
  }

  const durationMs = Date.now() - started;

  if (!existsSync(rawPath)) {
    console.error(colors.red('\nVitest produced no JSON report; cannot publish results.\n'));
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(rawPath, 'utf-8')) as VitestJson;

  const suites = raw.testResults.map((suite) => {
    const passed = suite.assertionResults.filter((a) => a.status === 'passed').length;
    const failed = suite.assertionResults.filter((a) => a.status === 'failed').length;
    return {
      name: suiteName(suite.name),
      file: relative(repoRoot, suite.name).replace(/\\/g, '/'),
      category: categoryOf(suite.name),
      tests: suite.assertionResults.length,
      passed,
      failed,
      durationMs: Math.round(Math.max(0, (suite.endTime ?? 0) - (suite.startTime ?? 0))),
    };
  });

  const categories = Object.entries(CATEGORIES).map(([key, meta]) => {
    const inCategory = suites.filter((s) => s.category === key);
    return {
      category: key,
      label: meta.label,
      description: meta.description,
      tests: inCategory.reduce((sum, s) => sum + s.tests, 0),
      passed: inCategory.reduce((sum, s) => sum + s.passed, 0),
      failed: inCategory.reduce((sum, s) => sum + s.failed, 0),
    };
  });

  const totals = {
    suites: suites.length,
    tests: raw.numTotalTests,
    passed: raw.numPassedTests,
    failed: raw.numFailedTests,
    skipped: raw.numPendingTests,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs,
    totals,
    passRate: totals.tests === 0 ? 0 : totals.passed / totals.tests,
    suites: suites.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    categories,
  };

  const outputPath = resolve(repoRoot, 'apps', 'web', 'public', 'quality-report.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  rmSync(rawPath, { force: true });

  section('Results by category');
  printTable(
    ['category', 'tests', 'passed', 'failed'],
    categories
      .filter((c) => c.tests > 0)
      .map((c) => [c.label, String(c.tests), String(c.passed), String(c.failed)]),
  );

  section('Suites');
  printTable(
    ['suite', 'category', 'tests', 'passed', 'time'],
    report.suites.map((s) => [
      s.name,
      s.category,
      String(s.tests),
      String(s.passed),
      `${s.durationMs}ms`,
    ]),
  );

  console.log(
    `\n${totals.passed}/${totals.tests} passing across ${totals.suites} suites in ${(durationMs / 1000).toFixed(1)}s.`,
  );
  console.log(`Report written to ${relative(repoRoot, outputPath).replace(/\\/g, '/')}`);

  if (totals.failed > 0 || suiteFailed) {
    console.log(colors.red(`\n${totals.failed} test(s) failing.\n`));
    process.exit(1);
  }
  console.log(colors.green('\nAll tests passing.\n'));
}

main().catch((error) => {
  console.error('\nTest report failed:', error);
  process.exit(1);
});
