'use client';

import { motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatMinorCompact, formatPercent } from '@reclaim/core/presentation';
import { AnimatedNumber } from './animated-number';
import { RevenueFlow } from './revenue-flow';
import { Badge, Button, Surface, cn } from '@/components/ui/primitives';

export interface LandingStats {
  grossRevenueMinor: number;
  leakedRevenueMinor: number;
  leakageRate: number;
  recoveredRevenueMinor: number;
  recoveryRate: number;
  revenueAtRiskMinor: number;
  activeCases: number;
  customers: number;
  payments: number;
  modelAuc: number;
  modelVersion: string;
  modelDegraded: boolean;
  reasoner: string;
  reasonerLive: boolean;
  provider: string;
  providerLive: boolean;
  interventionsExecuted: number;
  interventionsBlocked: number;
  duplicatesPrevented: number;
}

/* -------------------------------------------------------------------------- */
/* Motion helpers                                                              */
/* -------------------------------------------------------------------------- */

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 24 }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                        */
/* -------------------------------------------------------------------------- */

export function Hero({ stats }: { stats: LandingStats }) {
  const reduced = useReducedMotion();

  return (
    <section className="relative isolate min-h-[100svh] overflow-hidden">
      {/* The flow field sits behind everything, masked so it never fights the type. */}
      <RevenueFlow className="pointer-events-none absolute inset-0 -z-10 opacity-70" />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-radial-fade" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-64 bg-gradient-to-t from-ink-950 to-transparent" />

      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <Mark />
          <span className="text-sm font-medium tracking-[0.2em] text-silver-200">RECLAIM</span>
        </div>
        <nav className="flex items-center gap-2">
          <Link
            href="#how"
            className="hidden rounded-lg px-3 py-2 text-xs text-silver-400 transition-colors hover:text-silver-100 sm:block"
          >
            How it works
          </Link>
          <Link
            href="#architecture"
            className="hidden rounded-lg px-3 py-2 text-xs text-silver-400 transition-colors hover:text-silver-100 sm:block"
          >
            Architecture
          </Link>
          <Link
            href="#impact"
            className="hidden rounded-lg px-3 py-2 text-xs text-silver-400 transition-colors hover:text-silver-100 sm:block"
          >
            Impact
          </Link>
          <Link href="/dashboard">
            <Button size="sm" variant="primary">
              Launch control tower
            </Button>
          </Link>
        </nav>
      </header>

      <div className="relative z-10 mx-auto flex max-w-7xl flex-col justify-center px-6 pb-24 pt-16 sm:pt-24">
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 28 }}
          animate={reduced ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-4xl"
        >
          <Badge tone="neutral" size="md" className="mb-8">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mint-400" />
            Track 03 — AI Revenue Recovery
          </Badge>

          <h1 className="text-6xl font-light tracking-[-0.04em] text-silver-50 sm:text-8xl lg:text-9xl">
            RECLAIM
          </h1>

          <p className="mt-6 max-w-2xl text-xl font-light tracking-tight text-silver-300 sm:text-2xl text-balance">
            Autonomous Revenue Recovery Infrastructure
          </p>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-silver-500 text-pretty">
            Find the revenue slipping away. Decide what to do. Recover it safely.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link href="/dashboard">
              <Button size="lg" variant="primary">
                Launch control tower
              </Button>
            </Link>
            <Link href="/dashboard/demo">
              <Button size="lg" variant="secondary">
                Run a live recovery
              </Button>
            </Link>
          </div>

          <p className="mt-8 max-w-xl text-xs leading-relaxed text-silver-600 text-pretty">
            Running on {stats.payments.toLocaleString('en-IN')} synthetic payments across{' '}
            {stats.customers.toLocaleString('en-IN')} customers. Every figure on this page is computed
            from that corpus at request time — none of it is illustrative.
          </p>
        </motion.div>

        <motion.dl
          initial={reduced ? false : { opacity: 0, y: 20 }}
          animate={reduced ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="mt-20 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.06] sm:grid-cols-4"
        >
          <HeroStat
            label="Revenue leaked"
            value={
              <AnimatedNumber value={stats.leakedRevenueMinor} format={formatMinorCompact} />
            }
            hint={`${formatPercent(stats.leakageRate)} of processed volume`}
            tone="loss"
          />
          <HeroStat
            label="Currently at risk"
            value={
              <AnimatedNumber value={stats.revenueAtRiskMinor} format={formatMinorCompact} />
            }
            hint={`${stats.activeCases.toLocaleString('en-IN')} open cases`}
            tone="risk"
          />
          <HeroStat
            label="Recovered"
            value={
              <AnimatedNumber value={stats.recoveredRevenueMinor} format={formatMinorCompact} />
            }
            hint={`${formatPercent(stats.recoveryRate)} recovery rate`}
            tone="mint"
          />
          <HeroStat
            label="Model discrimination"
            value={
              <AnimatedNumber
                value={stats.modelAuc}
                format={(v) => v.toFixed(3)}
              />
            }
            hint="ROC AUC, held-out test split"
            tone="silver"
          />
        </motion.dl>
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  tone: 'loss' | 'risk' | 'mint' | 'silver';
}) {
  const toneClass = {
    loss: 'text-loss-400',
    risk: 'text-risk-400',
    mint: 'text-mint-400',
    silver: 'text-silver-200',
  }[tone];

  return (
    <div className="bg-ink-900/80 px-5 py-5 backdrop-blur-xl">
      <dt className="label-eyebrow">{label}</dt>
      <dd className={cn('mt-2 text-2xl font-medium tracking-tight', toneClass)}>{value}</dd>
      <p className="mt-1.5 text-2xs text-silver-600">{hint}</p>
    </div>
  );
}

function Mark() {
  return (
    <div className="relative h-7 w-7">
      <div className="absolute inset-0 rounded-md border border-mint-500/40 bg-mint-500/10" />
      <div className="absolute inset-[6px] rounded-sm bg-mint-400/80" />
      <div className="absolute inset-0 animate-pulse-ring rounded-md border border-mint-500/30" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The problem                                                                 */
/* -------------------------------------------------------------------------- */

export function ProblemSection({ stats }: { stats: LandingStats }) {
  return (
    <section className="relative mx-auto max-w-7xl px-6 py-28">
      <Reveal>
        <p className="label-eyebrow">The gap</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-tight text-silver-100 sm:text-4xl text-balance">
          Payment systems tell you a charge failed. They do not tell you whether it is worth
          chasing.
        </h2>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-silver-500 text-pretty">
          Razorpay and its peers give merchants excellent payment infrastructure and rich failure
          signals. What sits above that layer is unsolved: given thousands of revenue-loss events,
          which are actually recoverable, what should be done about each one, and what does that
          produce? RECLAIM is that decisioning layer.
        </p>
      </Reveal>

      <div className="mt-16 grid gap-6 md:grid-cols-3">
        {[
          {
            question: 'Which losses are recoverable?',
            answer:
              'An expired card and an insufficient-balance decline look identical in a dashboard. One can never be retried; the other recovers most of the time if you wait for the account to be funded.',
            metric: `${formatMinorCompact(stats.leakedRevenueMinor)} leaked`,
          },
          {
            question: 'What is the right intervention?',
            answer:
              'Retry, wait and retry, send a payment link, message the customer, escalate to a human, or stop. Each has a different cost, a different success rate, and a different effect on the relationship.',
            metric: '6 priced options per case',
          },
          {
            question: 'Did it actually work?',
            answer:
              'Recovery is only real when money is captured. RECLAIM records the predicted probability against the measured outcome, so the model can be checked rather than trusted.',
            metric: `${formatPercent(stats.recoveryRate)} measured recovery`,
          },
        ].map((item, index) => (
          <Reveal key={item.question} delay={index * 0.08}>
            <Surface className="h-full p-6">
              <p className="text-sm font-medium text-silver-100">{item.question}</p>
              <p className="mt-3 text-sm leading-relaxed text-silver-500 text-pretty">
                {item.answer}
              </p>
              <p className="mt-5 border-t border-white/[0.06] pt-4 font-mono text-xs text-mint-400">
                {item.metric}
              </p>
            </Surface>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

const LOOP_STAGES = [
  {
    key: 'detect',
    title: 'Detect',
    body: 'Failed payments, abandoned checkouts, failing subscription renewals and overdue receivables all become recovery cases. Detection is idempotent, so a replayed event never opens a second case competing for the same rupees.',
  },
  {
    key: 'diagnose',
    title: 'Diagnose',
    body: 'The analyst agent classifies the failure against a taxonomy of seventeen bank and gateway conditions, each carrying its own recoverability profile, optimal retry window and structural limits.',
  },
  {
    key: 'predict',
    title: 'Predict',
    body: 'A calibrated model scores how likely the money is to come back, using relational features drawn from the customer graph — not just the failed row.',
  },
  {
    key: 'decide',
    title: 'Decide',
    body: 'Every one of six interventions is priced: success probability x amount, minus direct cost, minus the goodwill cost of asking the customer again. Doing nothing scores exactly zero, so every action has a hurdle to clear.',
  },
  {
    key: 'guard',
    title: 'Guard',
    body: 'A deterministic policy engine authorises or refuses. Retry limits, cooldowns, transaction ceilings, quiet hours, consent, mandate validity and duplicate prevention are enforced in code, never by the model.',
  },
  {
    key: 'execute',
    title: 'Execute',
    body: 'The idempotency key is claimed before the provider is called. Retries are bounded and backed off, a circuit breaker fails fast when the provider is down, and a blocked action falls back to the next best permitted one.',
  },
  {
    key: 'measure',
    title: 'Measure',
    body: 'Only captured money counts as recovered. A link that was issued but not yet paid is recorded as awaiting the customer, because calling it revenue would make every number on the dashboard a lie.',
  },
  {
    key: 'learn',
    title: 'Learn',
    body: 'Predicted probability is stored against the measured outcome. The calibration curve on the model page is computed from those pairs, so drift is visible rather than assumed away.',
  },
] as const;

export function LoopSection() {
  return (
    <section id="how" className="relative border-y border-white/[0.06] bg-ink-900/40">
      <div className="mx-auto max-w-7xl px-6 py-28">
        <Reveal>
          <p className="label-eyebrow">The closed loop</p>
          <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-tight text-silver-100 sm:text-4xl text-balance">
            Eight stages, and the system can stop at any one of them.
          </h2>
        </Reveal>

        <div className="mt-16 grid gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
          {LOOP_STAGES.map((stage, index) => (
            <Reveal key={stage.key} delay={index * 0.05}>
              <div className="h-full bg-ink-900 p-6">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-2xs text-mint-500">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3 className="text-sm font-medium text-silver-100">{stage.title}</h3>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-silver-500 text-pretty">
                  {stage.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Architecture                                                                */
/* -------------------------------------------------------------------------- */

export function ArchitectureSection({ stats }: { stats: LandingStats }) {
  const layers = [
    {
      name: 'Reasoning layer',
      detail: stats.reasonerLive
        ? `${stats.reasoner} — diagnosis, strategy justification, copilot language`
        : `${stats.reasoner} — offline deterministic reasoner (no model key configured)`,
      note: 'Explains and chooses among priced options. Cannot compute an amount, authorise an action, or move money.',
      tone: 'accent' as const,
    },
    {
      name: 'Recovery probability model',
      detail: `${stats.modelVersion} — logistic regression, ROC AUC ${stats.modelAuc.toFixed(3)}`,
      note: 'Auditable by construction: every prediction decomposes into per-feature contributions a merchant can read.',
      tone: 'accent' as const,
    },
    {
      name: 'Expected-value engine',
      detail: 'Pure integer arithmetic over six bounded strategies',
      note: 'Prices each option in paise. Reproducible to the rupee and unit-tested.',
      tone: 'neutral' as const,
    },
    {
      name: 'Policy & guardrail engine',
      detail: `${stats.interventionsBlocked.toLocaleString('en-IN')} actions blocked so far`,
      note: 'Deterministic, total, and independent of the model. The AI recommends; this authorises.',
      tone: 'warning' as const,
    },
    {
      name: 'Action executor',
      detail: `${stats.interventionsExecuted.toLocaleString('en-IN')} executed · ${stats.duplicatesPrevented.toLocaleString('en-IN')} duplicates prevented`,
      note: 'Claims the idempotency key before the provider call, never after. Bounded retries, circuit breaker, fallback chain.',
      tone: 'positive' as const,
    },
    {
      name: 'Payment provider',
      detail: stats.providerLive
        ? `${stats.provider} — live test-mode API calls`
        : `${stats.provider} — deterministic offline simulator`,
      note: 'One interface, two implementations. Every result records whether it was simulated.',
      tone: 'neutral' as const,
    },
    {
      name: 'Firestore + audit trail',
      detail: 'Hash-chained, append-only, verified on read',
      note: 'Each entry embeds its predecessor’s hash, so tampering is detectable rather than merely discouraged.',
      tone: 'positive' as const,
    },
  ];

  return (
    <section id="architecture" className="mx-auto max-w-7xl px-6 py-28">
      <Reveal>
        <p className="label-eyebrow">Architecture</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-tight text-silver-100 sm:text-4xl text-balance">
          The model never touches money.
        </h2>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-silver-500 text-pretty">
          Language models are good at reading a messy situation and explaining a judgement. They are
          not good at arithmetic you cannot check, and they should never be the thing standing
          between a customer and a charge. RECLAIM puts a deterministic engine in that position
          instead.
        </p>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-14 overflow-hidden rounded-xl border border-white/[0.07]">
          {layers.map((layer, index) => (
            <div
              key={layer.name}
              className={cn(
                'grid gap-3 bg-ink-900/60 px-6 py-5 sm:grid-cols-[minmax(0,15rem)_1fr]',
                index !== layers.length - 1 && 'border-b border-white/[0.06]',
              )}
            >
              <div className="flex items-start gap-3">
                <span className="mt-1.5 font-mono text-2xs text-silver-600">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <p className="text-sm font-medium text-silver-100">{layer.name}</p>
                  <Badge tone={layer.tone} className="mt-2">
                    {layer.detail}
                  </Badge>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-silver-500 sm:pt-1 text-pretty">
                {layer.note}
              </p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Impact                                                                      */
/* -------------------------------------------------------------------------- */

export function ImpactSection({ stats }: { stats: LandingStats }) {
  return (
    <section id="impact" className="relative border-t border-white/[0.06] bg-ink-900/40">
      <div className="mx-auto max-w-7xl px-6 py-28">
        <Reveal>
          <p className="label-eyebrow">Measurable impact</p>
          <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-tight text-silver-100 sm:text-4xl text-balance">
            Every number here was computed when this page loaded.
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-silver-500 text-pretty">
            The corpus is synthetic and seed-locked, so these figures are reproducible on any
            machine. They are not reproducible because they are hard-coded — they are reproducible
            because the generator is deterministic and the pipeline that produced them is the same
            one that runs in the dashboard.
          </p>
        </Reveal>

        <div className="mt-16 grid gap-6 lg:grid-cols-3">
          <Reveal>
            <Surface className="h-full p-7">
              <p className="label-eyebrow">Business</p>
              <dl className="mt-5 space-y-4">
                <ImpactRow
                  label="Processed volume"
                  value={formatMinorCompact(stats.grossRevenueMinor)}
                />
                <ImpactRow
                  label="Leaked to failures"
                  value={formatMinorCompact(stats.leakedRevenueMinor)}
                  tone="loss"
                />
                <ImpactRow
                  label="Recovered"
                  value={formatMinorCompact(stats.recoveredRevenueMinor)}
                  tone="mint"
                />
                <ImpactRow label="Recovery rate" value={formatPercent(stats.recoveryRate)} tone="mint" />
              </dl>
            </Surface>
          </Reveal>

          <Reveal delay={0.08}>
            <Surface className="h-full p-7">
              <p className="label-eyebrow">Model</p>
              <dl className="mt-5 space-y-4">
                <ImpactRow label="Version" value={stats.modelVersion} />
                <ImpactRow label="ROC AUC (test)" value={stats.modelAuc.toFixed(3)} />
                <ImpactRow
                  label="Status"
                  value={stats.modelDegraded ? 'Untrained — prior only' : 'Trained'}
                  tone={stats.modelDegraded ? 'risk' : 'mint'}
                />
                <ImpactRow label="Reasoner" value={stats.reasoner} />
              </dl>
            </Surface>
          </Reveal>

          <Reveal delay={0.16}>
            <Surface className="h-full p-7">
              <p className="label-eyebrow">Safety</p>
              <dl className="mt-5 space-y-4">
                <ImpactRow
                  label="Actions executed"
                  value={stats.interventionsExecuted.toLocaleString('en-IN')}
                />
                <ImpactRow
                  label="Blocked by policy"
                  value={stats.interventionsBlocked.toLocaleString('en-IN')}
                  tone="risk"
                />
                <ImpactRow
                  label="Duplicates prevented"
                  value={stats.duplicatesPrevented.toLocaleString('en-IN')}
                  tone="mint"
                />
                <ImpactRow label="Audit chain" value="Verified on read" tone="mint" />
              </dl>
            </Surface>
          </Reveal>
        </div>

        <Reveal delay={0.2}>
          <div className="mt-16 flex flex-col items-center gap-6 rounded-2xl border border-white/[0.07] bg-gradient-to-b from-ink-850 to-ink-900 px-8 py-14 text-center">
            <h3 className="max-w-2xl text-2xl font-light tracking-tight text-silver-100 text-balance">
              RECLAIM does not just detect lost revenue. It decides what can be recovered, chooses
              the safest economically valuable intervention, executes it, handles failure, and
              proves how much money came back.
            </h3>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link href="/dashboard">
                <Button size="lg" variant="primary">
                  Open the control tower
                </Button>
              </Link>
              <Link href="/dashboard/demo">
                <Button size="lg" variant="secondary">
                  Watch a recovery run
                </Button>
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function ImpactRow({
  label,
  value,
  tone = 'silver',
}: {
  label: string;
  value: string;
  tone?: 'silver' | 'mint' | 'loss' | 'risk';
}) {
  const toneClass = {
    silver: 'text-silver-200',
    mint: 'text-mint-400',
    loss: 'text-loss-400',
    risk: 'text-risk-400',
  }[tone];

  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.05] pb-3 last:border-0 last:pb-0">
      <dt className="text-xs text-silver-500">{label}</dt>
      <dd className={cn('tnum text-sm font-medium', toneClass)}>{value}</dd>
    </div>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Mark />
          <span className="text-xs tracking-[0.2em] text-silver-500">RECLAIM</span>
        </div>
        <p className="max-w-xl text-2xs leading-relaxed text-silver-600 text-pretty">
          Built on synthetic data. No real customer records, no real payment credentials, and no
          messages are dispatched to anyone. Payment-provider results are labelled wherever an
          operation was simulated rather than performed.
        </p>
      </div>
    </footer>
  );
}
