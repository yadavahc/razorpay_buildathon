import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handler, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The System Quality panel reads the report that `npm run test:report` writes after a real
 * test run. It is deliberately a file on disk rather than a number in the source: if the
 * suite has not been run, the page says so instead of quoting a pass rate nobody verified.
 */
interface QualityReport {
  generatedAt: string;
  durationMs: number;
  totals: { suites: number; tests: number; passed: number; failed: number; skipped: number };
  passRate: number;
  suites: Array<{
    name: string;
    file: string;
    category: string;
    tests: number;
    passed: number;
    failed: number;
    durationMs: number;
  }>;
  categories: Array<{
    category: string;
    label: string;
    description: string;
    tests: number;
    passed: number;
    failed: number;
  }>;
}

function findReport(): { path: string; report: QualityReport } | null {
  const candidates = [
    join(process.cwd(), 'public', 'quality-report.json'),
    join(process.cwd(), '..', '..', 'apps', 'web', 'public', 'quality-report.json'),
    join(process.cwd(), '..', '..', 'data', 'quality-report.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return { path, report: JSON.parse(readFileSync(path, 'utf-8')) as QualityReport };
    } catch {
      continue;
    }
  }
  return null;
}

interface QualityPayload {
  available: boolean;
  message: string | null;
  report: QualityReport | null;
}

export const GET = handler(async (startedAt) => {
  const found = findReport();

  const payload: QualityPayload = found
    ? { available: true, message: null, report: found.report }
    : {
        available: false,
        message:
          'No test report found. Run "npm run test:report" to execute the suite and publish its results here.',
        report: null,
      };

  return ok(payload, startedAt);
});
