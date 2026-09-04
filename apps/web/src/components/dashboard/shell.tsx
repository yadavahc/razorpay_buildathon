'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import type { PublicRuntimeInfo } from '@reclaim/core';
import { useApi } from '@/lib/use-api';
import { Badge, Button, cn } from '@/components/ui/primitives';

/**
 * The dashboard chrome.
 *
 * The status rail across the top is not decoration. A viewer must be able to tell at a
 * glance whether they are looking at a live Razorpay integration or the offline
 * simulator, whether a real model is scoring or the fallback prior is, and which reasoner
 * wrote the explanations they are reading. Getting that wrong is how a demo becomes a
 * misrepresentation.
 */

interface RuntimePayload {
  runtime: PublicRuntimeInfo & {
    model: { version: string; degraded: boolean; trainedAt: string | null; rocAuc: number; threshold: number };
    reasonerId: string;
    storeKind: 'memory' | 'firestore';
  };
  corpus: { customers: number; payments: number } | null;
  boot: { ms: number; at: string };
  detection: { casesOpenedOnBoot: number };
  warnings: string[];
}

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ href: string; label: string; description: string }>;
}> = [
  {
    label: 'Operate',
    items: [
      { href: '/dashboard', label: 'Control tower', description: 'Revenue at risk, funnel, live feed' },
      { href: '/dashboard/cases', label: 'Recovery cases', description: 'The work queue' },
      { href: '/dashboard/copilot', label: 'Revenue copilot', description: 'Ask about leakage' },
    ],
  },
  {
    label: 'Analyse',
    items: [
      { href: '/dashboard/leakage', label: 'Leakage intelligence', description: 'Where money goes' },
      {
        href: '/dashboard/incidents',
        label: 'Systemic incidents',
        description: 'Correlated failures',
      },
      { href: '/dashboard/model', label: 'Recovery model', description: 'Metrics and calibration' },
      {
        href: '/dashboard/timing',
        label: 'Recovery timing',
        description: 'When to retry',
      },
      { href: '/dashboard/simulator', label: 'Strategy simulator', description: 'Compare policies' },
    ],
  },
  {
    label: 'Assure',
    items: [
      { href: '/dashboard/policy', label: 'Policy & guardrails', description: 'What is enforced' },
      {
        href: '/dashboard/regret',
        label: 'Regret ledger',
        description: 'What safety costs',
      },
      { href: '/dashboard/audit', label: 'Audit trail', description: 'Hash-chained history' },
      { href: '/dashboard/lab', label: 'Failure lab', description: 'Inject faults' },
      { href: '/dashboard/quality', label: 'System quality', description: 'Test results' },
    ],
  },
  {
    label: 'Demo',
    items: [{ href: '/dashboard/demo', label: 'Demo mode', description: 'Run the full story' }],
  },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const { data } = useApi<RuntimePayload>('/api/runtime', { pollMs: 60_000 });

  return (
    <div className="min-h-screen bg-ink-950">
      <StatusRail runtime={data ?? null} />

      <div className="mx-auto flex max-w-[1600px] gap-0">
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-white/[0.06] bg-ink-900/95 pt-[52px] backdrop-blur-xl transition-transform duration-300 ease-smooth lg:sticky lg:top-[52px] lg:h-[calc(100vh-52px)] lg:translate-x-0 lg:bg-transparent lg:pt-0',
            navOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-6" aria-label="Dashboard">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="label-eyebrow px-3 pb-2">{group.label}</p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const active =
                      item.href === '/dashboard'
                        ? pathname === '/dashboard'
                        : pathname.startsWith(item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setNavOpen(false)}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'group flex flex-col gap-0.5 rounded-lg px-3 py-2 transition-colors',
                            active
                              ? 'bg-white/[0.06] text-silver-50'
                              : 'text-silver-400 hover:bg-white/[0.03] hover:text-silver-100',
                          )}
                        >
                          <span className="flex items-center gap-2 text-xs font-medium">
                            {active && (
                              <span className="h-1 w-1 rounded-full bg-mint-400" aria-hidden />
                            )}
                            {item.label}
                          </span>
                          <span className="text-2xs text-silver-600">{item.description}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            <div className="mt-auto px-3 pt-4">
              <Link href="/" className="text-2xs text-silver-600 hover:text-silver-400">
                ← Back to overview
              </Link>
            </div>
          </nav>
        </aside>

        {navOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            className="fixed inset-0 z-30 bg-ink-950/70 backdrop-blur-sm lg:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}

        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="mb-4 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-xs text-silver-300 lg:hidden"
          >
            Menu
          </button>

          {data && data.warnings.length > 0 && (
            <div
              role="status"
              className="mb-6 rounded-xl border border-risk-500/25 bg-risk-500/[0.06] px-4 py-3"
            >
              <p className="text-xs font-medium text-risk-400">Setup incomplete</p>
              <ul className="mt-1.5 space-y-1">
                {data.warnings.map((warning) => (
                  <li key={warning} className="text-xs leading-relaxed text-silver-400">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {children}
        </main>
      </div>
    </div>
  );
}

function StatusRail({ runtime }: { runtime: RuntimePayload | null }) {
  const r = runtime?.runtime;

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
      <div className="mx-auto flex h-[52px] max-w-[1600px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="relative block h-5 w-5">
            <span className="absolute inset-0 rounded border border-mint-500/40 bg-mint-500/10" />
            <span className="absolute inset-[5px] rounded-sm bg-mint-400/80" />
          </span>
          <span className="text-xs font-medium tracking-[0.2em] text-silver-200">RECLAIM</span>
        </Link>

        <div className="scroll-fade-x ml-auto flex items-center gap-2 overflow-x-auto">
          {r ? (
            <>
              <Badge
                dot
                tone={r.paymentProvider.live ? 'positive' : 'neutral'}
                title={
                  r.paymentProvider.live
                    ? 'Actions call the Razorpay test API.'
                    : 'Actions run against the deterministic offline simulator. Nothing leaves this process.'
                }
              >
                {r.paymentProvider.name}
              </Badge>

              <Badge
                dot
                tone={r.reasoner.live ? 'accent' : 'neutral'}
                title={
                  r.reasoner.live
                    ? `Explanations are written by ${r.reasoner.model}.`
                    : 'No model API key is configured. Explanations come from the built-in deterministic reasoner, composed from measured quantities.'
                }
              >
                {r.reasoner.live ? r.reasoner.model : 'Deterministic reasoner'}
              </Badge>

              <Badge
                dot
                tone={r.model.degraded ? 'warning' : 'positive'}
                title={
                  r.model.degraded
                    ? 'No trained artifact found; predictions use the taxonomy prior.'
                    : `Trained model, ROC AUC ${r.model.rocAuc.toFixed(3)} on the held-out test split.`
                }
              >
                {r.model.degraded ? 'Model: untrained' : `Model ${r.model.rocAuc.toFixed(3)} AUC`}
              </Badge>

              <Badge tone="neutral" className="hidden sm:inline-flex" title="Persistence layer">
                {r.storeKind === 'firestore' ? 'Firestore' : 'In-memory store'}
              </Badge>
            </>
          ) : (
            <Badge tone="neutral">Connecting…</Badge>
          )}

          <Link href="/dashboard/demo" className="shrink-0">
            <Button size="sm" variant="primary">
              Demo
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
