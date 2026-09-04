'use client';

import { formatCount, formatPercent } from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { Badge, ErrorState, Panel, ProportionBar, Skeleton, cn } from '@/components/ui/primitives';

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

interface QualityPayload {
  available: boolean;
  message: string | null;
  report: QualityReport | null;
}

/**
 * SYSTEM QUALITY
 *
 * The test results, read from a report that a real test run wrote to disk.
 *
 * It is deliberately not a number in the source. If the suite has not been run, this page
 * says so rather than quoting a pass rate nobody verified — a hard-coded "100% passing"
 * badge is worse than no badge at all.
 */
export default function QualityPage() {
  const { data, error, loading, refresh, lastUpdated } = useApi<QualityPayload>('/api/quality');

  if (error) {
    return (
      <>
        <PageHeader title="System quality" description="Test coverage and results." />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="System quality" description="Test coverage and results." />
        <MetricGrid columns={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
      </>
    );
  }

  if (!data) return null;

  if (!data.available || !data.report) {
    return (
      <>
        <PageHeader
          title="System quality"
          description="Test coverage and results, read from a real test run."
        />
        <Panel title="No test report found">
          <p className="text-sm leading-relaxed text-silver-300 text-pretty">
            {data.message}
          </p>
          <pre className="mt-4 rounded-lg bg-ink-950/60 p-4 font-mono text-xs text-mint-400">
            npm run test:report
          </pre>
          <p className="mt-3 text-xs leading-relaxed text-silver-500 text-pretty">
            This page reads a file that a real test run writes. It shows nothing until the suite has
            actually been executed, which is the point — a pass rate that is hard-coded into the UI
            is not evidence of anything.
          </p>
        </Panel>
      </>
    );
  }

  const report = data.report;
  const allPassing = report.totals.failed === 0;

  return (
    <>
      <PageHeader
        title="System quality"
        description={`${formatCount(report.totals.tests)} tests across ${formatCount(report.totals.suites)} suites, run ${new Date(report.generatedAt).toLocaleString('en-IN')}.`}
        lastUpdated={lastUpdated}
      />

      <MetricGrid columns={4}>
        <MetricTile
          label="Pass rate"
          value={formatPercent(report.passRate, 1)}
          definition="Passing tests divided by tests run, from the most recent execution of the suite."
          hint={`${formatCount(report.totals.passed)} of ${formatCount(report.totals.tests)}`}
          tone={allPassing ? 'positive' : 'negative'}
          emphasis={allPassing}
        />
        <MetricTile
          label="Failing"
          value={formatCount(report.totals.failed)}
          definition="Tests that failed in the most recent run."
          tone={report.totals.failed === 0 ? 'positive' : 'negative'}
        />
        <MetricTile
          label="Suites"
          value={formatCount(report.totals.suites)}
          definition="Test files executed, spanning unit, integration, agent, end-to-end and failure-injection categories."
          tone="neutral"
        />
        <MetricTile
          label="Run time"
          value={`${(report.durationMs / 1000).toFixed(1)}s`}
          definition="Wall-clock duration of the complete suite."
          tone="neutral"
        />
      </MetricGrid>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="What is covered"
          description="Each category exists to catch a distinct class of defect."
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-white/[0.05]">
            {report.categories.map((category) => (
              <li key={category.category} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-medium text-silver-100">{category.label}</h3>
                      <Badge tone={category.failed === 0 ? 'positive' : 'negative'}>
                        {category.passed}/{category.tests}
                      </Badge>
                    </div>
                    <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-silver-500 text-pretty">
                      {category.description}
                    </p>
                  </div>
                </div>
                <ProportionBar
                  value={category.tests === 0 ? 0 : category.passed / category.tests}
                  tone={category.failed === 0 ? 'positive' : 'negative'}
                  className="mt-2.5"
                  label={`${category.label} pass rate`}
                />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Suites" description="Every test file, with its result." bodyClassName="p-0">
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">Test suites and results</caption>
              <thead className="sticky top-0 bg-ink-900">
                <tr className="border-b border-white/[0.06]">
                  <th scope="col" className="px-5 py-2.5 text-left font-medium text-silver-500">
                    Suite
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium text-silver-500">
                    Tests
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium text-silver-500">
                    Passed
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium text-silver-500">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.suites.map((suite) => (
                  <tr key={suite.file} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-5 py-2.5">
                      <span className="block text-silver-200">{suite.name}</span>
                      <span className="block truncate font-mono text-[10px] text-silver-600">
                        {suite.file}
                      </span>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-silver-400">{suite.tests}</td>
                    <td
                      className={cn(
                        'tnum px-3 py-2.5 text-right',
                        suite.failed === 0 ? 'text-mint-400' : 'text-loss-400',
                      )}
                    >
                      {suite.passed}
                      {suite.failed > 0 && ` (${suite.failed} failed)`}
                    </td>
                    <td className="tnum px-5 py-2.5 text-right text-silver-600">
                      {suite.durationMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel
        className="mt-6"
        title="What these tests actually assert"
        description="The properties the suite exists to protect."
      >
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: 'Money is never double-charged',
              body: 'The idempotency key is claimed before the provider call. Replaying an action returns the original result and never reaches the provider a second time.',
            },
            {
              title: 'The model cannot move money',
              body: 'The analyst agent holds read scopes only. An attempt to call a write tool fails at the registry gate, before any handler runs.',
            },
            {
              title: 'Guardrails cannot be argued with',
              body: 'A denied action stays denied regardless of expected value. Consent, mandate validity and chargeback history are hard gates with no economic override.',
            },
            {
              title: 'Failure produces a fallback, not a hang',
              body: 'Timeouts, gateway errors and model outages each resolve into a bounded retry, a fallback strategy, or an escalation — and the case reaches a terminal state either way.',
            },
            {
              title: 'Arithmetic is exact',
              body: 'Every amount is an integer number of paise. Expected value, goodwill cost and delay decay are asserted to the rupee.',
            },
            {
              title: 'History cannot be rewritten',
              body: 'The audit chain is replayed and every hash recomputed. Mutating any historical record breaks verification.',
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="text-xs font-medium text-silver-200">{item.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-silver-500 text-pretty">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
