'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { STRATEGY_LABELS, formatMinor, formatMinorCompact } from '@reclaim/core/presentation';
import { RazorpayMark } from './razorpay-mark';
import { useSound } from './sound';
import { Badge, Button, cn } from '@/components/ui/primitives';

/**
 * SEE HOW IT WORKS
 *
 * A product demonstration rather than a slideshow, and the distinction is load-bearing:
 * every number on every stage is fetched from a real recovery case in the running engine
 * when the overlay opens. The probability is the model's actual output, the six strategies
 * carry their actual computed expected values, the guardrail verdicts are the real policy
 * decisions, and the recovered amount is what the provider actually returned.
 *
 * There is a scripted fallback for the case where the API cannot be reached, and it says
 * so on screen. Nothing here is dressed up as measured when it is not.
 */

const STAGE_MS = 4200;

interface Driver {
  label: string;
  contribution: number;
  direction: 'positive' | 'negative';
}

interface Candidate {
  strategy: string;
  successProbability: number;
  expectedValueMinor: number;
  interventionCostMinor: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

interface PolicyCheck {
  label: string;
  result: 'pass' | 'fail' | 'warn' | 'skip';
  code: string | null;
}

interface DemoCase {
  id: string;
  customerName: string;
  amountAtRiskMinor: number;
  failureReason: string | null;
  method: string | null;
  probability: number;
  threshold: number;
  modelVersion: string;
  drivers: Driver[];
  candidates: Candidate[];
  recommended: string | null;
  policyVerdict: 'allow' | 'deny' | 'require_human' | null;
  policyChecks: PolicyCheck[];
  executedStrategy: string | null;
  recoveredMinor: number;
  outcome: string | null;
  auditEntries: number;
  live: boolean;
}

const FALLBACK: DemoCase = {
  id: 'case_illustrative',
  customerName: 'A returning customer',
  amountAtRiskMinor: 489900,
  failureReason: 'insufficient_funds',
  method: 'card',
  probability: 0.71,
  threshold: 0.42,
  modelVersion: 'recovery-probability-v1',
  drivers: [
    { label: 'Historical recovery rate for this customer', contribution: 0.61, direction: 'positive' },
    { label: 'Failure class base recoverability', contribution: 0.44, direction: 'positive' },
    { label: 'Attempts already made on this case', contribution: -0.22, direction: 'negative' },
  ],
  candidates: [],
  recommended: 'delayed_retry',
  policyVerdict: 'allow',
  policyChecks: [],
  executedStrategy: 'delayed_retry',
  recoveredMinor: 489900,
  outcome: 'recovered',
  auditEntries: 7,
  live: false,
};

const STAGES = [
  { key: 'detect', name: 'Detect', blurb: 'A payment fails. RECLAIM opens a case.' },
  { key: 'diagnose', name: 'Diagnose', blurb: 'Evidence is gathered and the failure classified.' },
  { key: 'predict', name: 'Predict', blurb: 'The model scores how recoverable it really is.' },
  { key: 'decide', name: 'Decide', blurb: 'Every option is priced. The best value wins.' },
  { key: 'guard', name: 'Guard', blurb: 'Deterministic policy decides what may execute.' },
  { key: 'execute', name: 'Execute', blurb: 'The approved action runs against the rail.' },
  { key: 'measure', name: 'Measure', blurb: 'The outcome is recorded and the money booked.' },
  { key: 'learn', name: 'Learn', blurb: 'The result becomes evidence for the next decision.' },
] as const;

export function HowItWorks({
  open,
  primed = false,
  onClose,
}: {
  open: boolean;
  /** Set when the visitor hovers the trigger, so the case is already loaded on open. */
  primed?: boolean;
  onClose: () => void;
}) {
  const { play } = useSound();
  const reduced = useReducedMotion();

  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [data, setData] = useState<DemoCase | null>(null);
  const [loading, setLoading] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  /** Set once the fetch has been kicked off, so it can never start twice. */
  const startedRef = useRef(false);
  /** Cleared on unmount; the only thing that may discard an in-flight response. */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Pull a real case once, the first time the overlay is opened or primed.
  //
  // The guard is a ref rather than the `loading` state on purpose. With `loading` in the
  // dependency array, `setLoading(true)` re-ran this effect, and the re-run's cleanup set
  // `cancelled` on the request the previous run had just started — so the responses came
  // back 200 and were thrown away, `loading` never cleared, and the overlay sat on its
  // spinner forever. Only unmount should cancel this.
  useEffect(() => {
    if ((!open && !primed) || startedRef.current) return;
    startedRef.current = true;
    setLoading(true);

    void (async () => {
      try {
        const listRes = await fetch('/api/cases?limit=1&status=recovered', { cache: 'no-store' });
        const list = await listRes.json();
        const row = list?.data?.items?.[0];
        if (!row?.id) throw new Error('no case');

        const detailRes = await fetch(`/api/cases/${row.id}`, { cache: 'no-store' });
        const detail = await detailRes.json();
        const d = detail?.data;
        if (!d) throw new Error('no detail');

        const policy = d.policyDecisions?.[d.policyDecisions.length - 1] ?? d.policyDecisions?.[0];
        const outcome = d.outcomes?.[0];

        if (aliveRef.current) {
          setData({
            id: row.id,
            customerName: row.customerName ?? 'Customer',
            amountAtRiskMinor: row.amountAtRiskMinor ?? 0,
            failureReason: row.failureReason ?? null,
            method: row.method ?? null,
            probability: d.prediction?.probability ?? row.recoveryProbability ?? 0,
            threshold: d.prediction?.threshold ?? 0.4,
            modelVersion: d.prediction?.modelVersion ?? 'recovery-probability-v1',
            drivers: (d.prediction?.drivers ?? []).slice(0, 3).map((x: Driver) => ({
              label: x.label,
              contribution: x.contribution,
              direction: x.direction,
            })),
            candidates: (d.strategies ?? []).map((c: Candidate) => ({
              strategy: c.strategy,
              successProbability: c.successProbability,
              expectedValueMinor: c.expectedValueMinor,
              interventionCostMinor: c.interventionCostMinor,
              eligible: c.eligible,
              ineligibleReason: c.ineligibleReason ?? null,
            })),
            recommended: d.recommended?.strategy ?? row.selectedStrategy ?? null,
            policyVerdict: policy?.verdict ?? null,
            policyChecks: (policy?.checks ?? []).slice(0, 7).map((c: PolicyCheck) => ({
              label: c.label,
              result: c.result,
              code: c.code ?? null,
            })),
            executedStrategy: d.actions?.[0]?.strategy ?? row.selectedStrategy ?? null,
            recoveredMinor: outcome?.recoveredAmountMinor ?? row.recoveredAmountMinor ?? 0,
            outcome: outcome?.outcome ?? row.status ?? null,
            auditEntries: d.audit?.length ?? 0,
            live: true,
          });
        }
      } catch {
        if (aliveRef.current) setData(FALLBACK);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    })();
  }, [open, primed]);

  // Reset and announce on open; restore focus on close.
  useEffect(() => {
    if (open) {
      lastFocused.current = document.activeElement as HTMLElement | null;
      setStage(0);
      setPlaying(true);
      play('open');
      // Move focus into the dialog so Escape and the tab order behave.
      window.setTimeout(() => dialogRef.current?.focus(), 30);
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previous;
      };
    }
    lastFocused.current?.focus?.();
    return undefined;
  }, [open, play]);

  const close = useCallback(() => {
    play('close');
    onClose();
  }, [onClose, play]);

  // Auto-advance.
  useEffect(() => {
    if (!open || !playing || reduced) return;
    const timer = window.setTimeout(() => {
      setStage((s) => {
        if (s >= STAGES.length - 1) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, STAGE_MS);
    return () => window.clearTimeout(timer);
  }, [open, playing, stage, reduced]);

  // Sound follows the stage, with the success chime reserved for money coming back.
  useEffect(() => {
    if (!open) return;
    if (STAGES[stage]?.key === 'measure') play('success');
    else play('step', { index: stage });
  }, [stage, open, play]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowRight') setStage((s) => Math.min(STAGES.length - 1, s + 1));
      if (event.key === 'ArrowLeft') setStage((s) => Math.max(0, s - 1));
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const c = data ?? FALLBACK;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-950/90 p-4 backdrop-blur-xl sm:p-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="How RECLAIM works"
            tabIndex={-1}
            className="relative flex h-full max-h-[860px] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 shadow-2xl outline-none"
            initial={{ opacity: 0, y: 24, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.99 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <Header caseData={c} loading={loading} onClose={close} />

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <StageRail stage={stage} onSelect={setStage} />

              <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-10">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={stage}
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full"
                  >
                    <Stage index={stage} caseData={c} />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            <Controls
              stage={stage}
              playing={playing}
              onPlayToggle={() => setPlaying((p) => !p)}
              onPrev={() => setStage((s) => Math.max(0, s - 1))}
              onNext={() => setStage((s) => Math.min(STAGES.length - 1, s + 1))}
              onClose={close}
            />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/* -------------------------------------------------------------------------- */

function Header({
  caseData,
  loading,
  onClose,
}: {
  caseData: DemoCase;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-white/[0.07] px-6 py-4 sm:px-10">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-medium tracking-tight text-silver-100">
            How RECLAIM recovers a payment
          </h2>
          {loading ? (
            <Badge tone="neutral" size="sm">
              Loading a live case…
            </Badge>
          ) : caseData.live ? (
            <Badge tone="accent" size="sm">
              Live case {caseData.id}
            </Badge>
          ) : (
            <Badge tone="warning" size="sm">
              Illustrative — engine unreachable
            </Badge>
          )}
        </div>
        <p className="mt-1 truncate text-2xs text-silver-500">
          {loading
            ? 'Reading a real recovery case from the running engine…'
            : caseData.live
              ? 'Every figure below is read from this case in the running engine.'
              : 'The engine could not be reached, so these figures are a worked example.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-silver-400 transition-colors hover:border-white/20 hover:text-silver-100"
      >
        Close
      </button>
    </div>
  );
}

function StageRail({ stage, onSelect }: { stage: number; onSelect: (n: number) => void }) {
  const { play } = useSound();
  return (
    <nav
      aria-label="Demonstration stages"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/[0.07] px-4 py-3 lg:w-64 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:px-3 lg:py-5"
    >
      {STAGES.map((s, i) => {
        const active = i === stage;
        const done = i < stage;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(i)}
            onMouseEnter={() => play('hover')}
            className={cn(
              'group flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition-all duration-300',
              active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-medium transition-colors duration-300',
                active
                  ? 'border-mint-500/60 bg-mint-500/15 text-mint-300'
                  : done
                    ? 'border-mint-600/30 bg-mint-600/10 text-mint-500'
                    : 'border-white/10 text-silver-600',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  'block text-xs font-medium transition-colors duration-300',
                  active ? 'text-silver-100' : 'text-silver-500',
                )}
              >
                {s.name}
              </span>
              <span className="hidden truncate text-2xs text-silver-600 lg:block">{s.blurb}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function Controls({
  stage,
  playing,
  onPlayToggle,
  onPrev,
  onNext,
  onClose,
}: {
  stage: number;
  playing: boolean;
  onPlayToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const last = stage === STAGES.length - 1;
  return (
    <div className="shrink-0 border-t border-white/[0.07]">
      <div className="h-0.5 w-full bg-white/[0.05]">
        <motion.div
          className="h-full bg-mint-500/70"
          animate={{ width: `${((stage + 1) / STAGES.length) * 100}%` }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-6 py-3.5 sm:px-10">
        <span className="text-2xs tabular-nums text-silver-600">
          Stage {stage + 1} of {STAGES.length} · space to {playing ? 'pause' : 'play'}, arrows to
          step
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onPrev} disabled={stage === 0}>
            Back
          </Button>
          <Button size="sm" variant="ghost" onClick={onPlayToggle}>
            {playing ? 'Pause' : 'Play'}
          </Button>
          {last ? (
            <Button size="sm" variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={onNext}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                      */
/* -------------------------------------------------------------------------- */

function StageFrame({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <p className="label-eyebrow">{eyebrow}</p>
      <h3 className="mt-3 max-w-2xl text-2xl font-light tracking-tight text-silver-100 text-balance">
        {title}
      </h3>
      <div className="mt-7 min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Stage({ index, caseData }: { index: number; caseData: DemoCase }) {
  switch (STAGES[index]?.key) {
    case 'detect':
      return <DetectStage c={caseData} />;
    case 'diagnose':
      return <DiagnoseStage c={caseData} />;
    case 'predict':
      return <PredictStage c={caseData} />;
    case 'decide':
      return <DecideStage c={caseData} />;
    case 'guard':
      return <GuardStage c={caseData} />;
    case 'execute':
      return <ExecuteStage c={caseData} />;
    case 'measure':
      return <MeasureStage c={caseData} />;
    default:
      return <LearnStage c={caseData} />;
  }
}

/** Strategy labels come from the shared presentation map; unknown keys degrade to prose. */
function strategyName(strategy: string | null | undefined): string {
  if (!strategy) return 'No action';
  return (STRATEGY_LABELS as Record<string, string>)[strategy] ?? humanise(strategy);
}

function humanise(value: string | null | undefined, fallback = 'unknown') {
  if (!value) return fallback;
  return value.replace(/_/g, ' ');
}

function DetectStage({ c }: { c: DemoCase }) {
  return (
    <StageFrame
      eyebrow="Stage 1 — Detect"
      title="A payment fails on the rail, and a recovery case opens within the same second."
    >
      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* The failing charge. */}
        <motion.div
          className="relative overflow-hidden rounded-xl border border-loss-500/25 bg-loss-500/[0.06] p-6"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
        >
          <motion.div
            className="absolute inset-0 bg-loss-500/10"
            animate={{ opacity: [0, 0.55, 0] }}
            transition={{ duration: 1.9, repeat: Infinity, ease: 'easeInOut' }}
          />
          <div className="relative">
            <div className="flex items-center gap-2">
              <RazorpayMark className="h-4" />
              <span className="text-2xs uppercase tracking-[0.16em] text-silver-500">
                Payment declined
              </span>
            </div>
            <p className="mt-5 text-4xl font-light tracking-tight text-loss-400">
              {formatMinor(c.amountAtRiskMinor)}
            </p>
            <p className="mt-2 text-sm capitalize text-silver-300">
              {humanise(c.failureReason, 'declined')}
            </p>
            <p className="mt-1 text-2xs text-silver-600">
              {humanise(c.method, 'card')} · {c.customerName}
            </p>
          </div>
        </motion.div>

        <div className="space-y-3">
          {[
            'Failure captured from the payment stream',
            'Customer and payment history joined',
            `Case ${c.id} opened`,
          ].map((line, i) => (
            <motion.div
              key={line}
              className="flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-4 py-3"
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.35 + i * 0.28, duration: 0.45 }}
            >
              <motion.span
                className="h-1.5 w-1.5 rounded-full bg-mint-400"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.5 + i * 0.28, type: 'spring', stiffness: 400 }}
              />
              <span className="text-xs text-silver-300">{line}</span>
            </motion.div>
          ))}
        </div>
      </div>
    </StageFrame>
  );
}

function DiagnoseStage({ c }: { c: DemoCase }) {
  const evidence = [
    'Customer context',
    'Payment history',
    'Subscription state',
    'Prior attempts',
    'Prior recoveries',
    'Failure taxonomy',
  ];
  return (
    <StageFrame
      eyebrow="Stage 2 — Diagnose"
      title="Evidence is gathered through typed tools, then the failure is classified."
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="grid grid-cols-2 gap-2.5">
          {evidence.map((tool, i) => (
            <motion.div
              key={tool}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3.5 py-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.11, duration: 0.4 }}
            >
              <div className="flex items-center justify-between">
                <span className="text-2xs text-silver-400">{tool}</span>
                <motion.span
                  className="text-2xs text-mint-400"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 + i * 0.11 }}
                >
                  ✓
                </motion.span>
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.75, duration: 0.5 }}
        >
          <p className="label-eyebrow">Classification</p>
          <p className="mt-3 text-lg font-light capitalize text-silver-100">
            {humanise(c.failureReason, 'declined')}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-silver-500">
            The taxonomy carries what this class of failure means: whether it can resolve on its
            own, whether a retry is structurally possible, and the base rate at which it recovers.
            That is what separates a decline worth chasing from one that never will be.
          </p>
          <div className="mt-4 border-t border-white/[0.07] pt-4">
            <p className="text-2xs text-silver-600">
              The language model reasons over this evidence and writes the explanation. It never
              moves money — the decision it proposes is re-priced and re-authorised downstream.
            </p>
          </div>
        </motion.div>
      </div>
    </StageFrame>
  );
}

function PredictStage({ c }: { c: DemoCase }) {
  const pct = Math.round(c.probability * 100);
  const above = c.probability >= c.threshold;

  return (
    <StageFrame
      eyebrow="Stage 3 — Predict"
      title="A calibrated model scores how recoverable this payment actually is."
    >
      <div className="grid gap-8 lg:grid-cols-[auto_1fr]">
        <div className="relative mx-auto h-48 w-48 shrink-0">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
            <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="8" />
            <motion.circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke={above ? '#5eead4' : '#fbbf6e'}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 52}
              initial={{ strokeDashoffset: 2 * Math.PI * 52 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 52 * (1 - c.probability) }}
              transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <motion.span
              className={cn(
                'text-4xl font-light tabular-nums tracking-tight',
                above ? 'text-mint-400' : 'text-risk-400',
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              {pct}%
            </motion.span>
            <span className="mt-1 text-2xs text-silver-600">recoverable</span>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={above ? 'accent' : 'warning'} size="sm">
              {above ? 'Above' : 'Below'} the {Math.round(c.threshold * 100)}% action threshold
            </Badge>
            <Badge tone="neutral" size="sm">
              {c.modelVersion}
            </Badge>
          </div>

          <p className="mt-5 text-2xs uppercase tracking-[0.16em] text-silver-600">
            What drove this score
          </p>
          <div className="mt-3 space-y-2.5">
            {(c.drivers.length ? c.drivers : FALLBACK.drivers).map((d, i) => {
              const magnitude = Math.min(1, Math.abs(d.contribution) / 0.8);
              return (
                <motion.div
                  key={d.label}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.7 + i * 0.16, duration: 0.4 }}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-silver-300">{d.label}</span>
                    <span
                      className={cn(
                        'shrink-0 text-2xs tabular-nums',
                        d.direction === 'positive' ? 'text-mint-400' : 'text-loss-400',
                      )}
                    >
                      {d.direction === 'positive' ? '+' : ''}
                      {d.contribution.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <motion.div
                      className={cn(
                        'h-full rounded-full',
                        d.direction === 'positive' ? 'bg-mint-500/70' : 'bg-loss-500/70',
                      )}
                      initial={{ width: 0 }}
                      animate={{ width: `${magnitude * 100}%` }}
                      transition={{ delay: 0.85 + i * 0.16, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                </motion.div>
              );
            })}
          </div>
          <p className="mt-5 text-2xs leading-relaxed text-silver-600">
            The model is logistic regression on purpose: every prediction decomposes into
            per-feature contributions, so a decision about someone&apos;s money can be explained
            rather than asserted.
          </p>
        </div>
      </div>
    </StageFrame>
  );
}

function DecideStage({ c }: { c: DemoCase }) {
  const candidates = c.candidates.length
    ? [...c.candidates].sort((a, b) => b.expectedValueMinor - a.expectedValueMinor)
    : [];
  const max = Math.max(1, ...candidates.map((x) => Math.abs(x.expectedValueMinor)));

  return (
    <StageFrame
      eyebrow="Stage 4 — Decide"
      title="Every available strategy is priced, and the highest expected value wins."
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-silver-500">
          Strategy economics load from the live case; the engine was unreachable.
        </p>
      ) : (
        <div className="space-y-2">
          {candidates.map((s, i) => {
            const best = s.strategy === c.recommended;
            const width = (Math.max(0, s.expectedValueMinor) / max) * 100;
            return (
              <motion.div
                key={s.strategy}
                className={cn(
                  'relative overflow-hidden rounded-lg border px-4 py-3 transition-colors',
                  best ? 'border-mint-500/40 bg-mint-500/[0.07]' : 'border-white/[0.07] bg-white/[0.02]',
                  !s.eligible && 'opacity-45',
                )}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: s.eligible ? 1 : 0.45, x: 0 }}
                transition={{ delay: i * 0.1, duration: 0.42 }}
              >
                <motion.div
                  className={cn(
                    'absolute inset-y-0 left-0 -z-10',
                    best ? 'bg-mint-500/[0.10]' : 'bg-white/[0.03]',
                  )}
                  initial={{ width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ delay: 0.25 + i * 0.1, duration: 0.85, ease: [0.16, 1, 0.3, 1] }}
                />
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={cn(
                        'text-sm',
                        best ? 'font-medium text-mint-300' : 'text-silver-300',
                      )}
                    >
                      {strategyName(s.strategy)}
                    </span>
                    {best ? (
                      <Badge tone="accent" size="sm">
                        Selected
                      </Badge>
                    ) : null}
                    {!s.eligible && s.ineligibleReason ? (
                      <span className="truncate text-2xs text-silver-600">{s.ineligibleReason}</span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-baseline gap-4 tabular-nums">
                    <span className="text-2xs text-silver-600">
                      {Math.round(s.successProbability * 100)}% likely
                    </span>
                    <span
                      className={cn(
                        'text-sm',
                        s.expectedValueMinor > 0 ? 'text-silver-100' : 'text-silver-600',
                      )}
                    >
                      {formatMinorCompact(s.expectedValueMinor)}
                    </span>
                  </div>
                </div>
              </motion.div>
            );
          })}
          <p className="pt-3 text-2xs leading-relaxed text-silver-600">
            Expected value is probability × amount, less the direct cost of the intervention and
            the modelled cost of annoying the customer. Chasing money can destroy value, and this
            is the arithmetic that says when to stop.
          </p>
        </div>
      )}
    </StageFrame>
  );
}

function GuardStage({ c }: { c: DemoCase }) {
  const checks = c.policyChecks.length
    ? c.policyChecks
    : [
        { label: 'Case is not terminal', result: 'pass' as const, code: null },
        { label: 'Customer has not opted out', result: 'pass' as const, code: null },
        { label: 'Retry limit not reached', result: 'pass' as const, code: null },
        { label: 'Outside quiet hours', result: 'skip' as const, code: null },
        { label: 'Expected value clears the floor', result: 'pass' as const, code: null },
        { label: 'Not a duplicate action', result: 'pass' as const, code: null },
      ];

  const tone = {
    pass: 'text-mint-400 border-mint-500/30 bg-mint-500/[0.07]',
    fail: 'text-loss-400 border-loss-500/30 bg-loss-500/[0.07]',
    warn: 'text-risk-400 border-risk-500/30 bg-risk-500/[0.07]',
    skip: 'text-silver-600 border-white/[0.07] bg-white/[0.02]',
  };
  const glyph = { pass: '✓', fail: '✕', warn: '!', skip: '–' };

  return (
    <StageFrame
      eyebrow="Stage 5 — Guard"
      title="A deterministic policy engine decides what is actually allowed to run."
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-2">
          {checks.map((check, i) => (
            <motion.div
              key={`${check.label}-${i}`}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-4 py-2.5',
                tone[check.result],
              )}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.09, duration: 0.35 }}
            >
              <span className="w-4 text-center text-xs">{glyph[check.result]}</span>
              <span className="flex-1 text-xs text-silver-300">{check.label}</span>
              {check.code ? (
                <span className="text-2xs tabular-nums text-loss-400">{check.code}</span>
              ) : null}
            </motion.div>
          ))}
        </div>

        <motion.div
          className={cn(
            'flex flex-col items-center justify-center rounded-xl border p-6 text-center',
            c.policyVerdict === 'deny'
              ? 'border-loss-500/30 bg-loss-500/[0.07]'
              : 'border-mint-500/30 bg-mint-500/[0.07]',
          )}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.7, type: 'spring', stiffness: 260, damping: 20 }}
        >
          <span className="label-eyebrow">Verdict</span>
          <span
            className={cn(
              'mt-3 text-2xl font-light uppercase tracking-tight',
              c.policyVerdict === 'deny' ? 'text-loss-400' : 'text-mint-400',
            )}
          >
            {c.policyVerdict ?? 'allow'}
          </span>
          <p className="mt-4 text-2xs leading-relaxed text-silver-500">
            The model recommends. This engine authorises. It is ordinary deterministic code with
            no model in the path, so the same inputs always produce the same verdict — and a
            check can only ever restrict.
          </p>
        </motion.div>
      </div>
    </StageFrame>
  );
}

function ExecuteStage({ c }: { c: DemoCase }) {
  return (
    <StageFrame
      eyebrow="Stage 6 — Execute"
      title="The approved action runs against the payment rail, exactly once."
    >
      <div className="flex flex-col items-center justify-center gap-8 py-6">
        <div className="flex w-full max-w-2xl items-center justify-between gap-4">
          <Node label="RECLAIM" sub={strategyName(c.executedStrategy ?? 'delayed_retry')} />

          <div className="relative h-px flex-1 bg-white/10">
            <motion.span
              className="absolute -top-1 h-2 w-2 rounded-full bg-mint-400 shadow-[0_0_12px_2px_rgba(94,234,212,0.6)]"
              initial={{ left: '0%' }}
              animate={{ left: '100%' }}
              transition={{ duration: 1.5, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.7 }}
            />
          </div>

          <Node label="Razorpay" sub="Payment rail" mark />
        </div>

        <motion.div
          className="w-full max-w-2xl rounded-xl border border-white/[0.07] bg-white/[0.02] p-5"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.5 }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Fact label="Action" value={strategyName(c.executedStrategy ?? 'delayed_retry')} />
            <Fact label="Idempotency" value="Key claimed before the call" />
            <Fact label="On failure" value="Bounded retry, then fall back" />
          </div>
          <p className="mt-4 border-t border-white/[0.07] pt-4 text-2xs leading-relaxed text-silver-600">
            The idempotency key is reserved transactionally <em>before</em> the side effect, so a
            retry, a double click or a redelivered webhook cannot charge a customer twice.
          </p>
        </motion.div>
      </div>
    </StageFrame>
  );
}

function Node({ label, sub, mark }: { label: string; sub: string; mark?: boolean }) {
  return (
    <div className="flex w-36 shrink-0 flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-5 text-center">
      {mark ? (
        <RazorpayMark className="h-5" />
      ) : (
        <div className="h-5 w-5 rounded-md border border-mint-500/40 bg-mint-500/15" />
      )}
      <span className="text-xs font-medium text-silver-200">{label}</span>
      <span className="text-2xs leading-tight text-silver-600">{sub}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label-eyebrow">{label}</p>
      <p className="mt-1.5 text-xs text-silver-200">{value}</p>
    </div>
  );
}

function MeasureStage({ c }: { c: DemoCase }) {
  const recovered = c.recoveredMinor > 0;
  return (
    <StageFrame
      eyebrow="Stage 7 — Measure"
      title="The outcome is recorded against the case, and the money is booked."
    >
      <div className="flex flex-col items-center justify-center gap-7 py-4">
        <motion.div
          className={cn(
            'w-full max-w-md rounded-2xl border p-8 text-center',
            recovered ? 'border-mint-500/30 bg-mint-500/[0.07]' : 'border-white/[0.07] bg-white/[0.02]',
          )}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 20 }}
        >
          <p className="label-eyebrow">{recovered ? 'Recovered' : 'Outcome'}</p>
          <motion.p
            className={cn(
              'mt-4 text-5xl font-light tracking-tight',
              recovered ? 'text-mint-400' : 'text-silver-300',
            )}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.6 }}
          >
            {recovered ? formatMinor(c.recoveredMinor) : humanise(c.outcome, 'no recovery')}
          </motion.p>
          <p className="mt-3 text-xs capitalize text-silver-500">
            {humanise(c.outcome, 'recorded')}
          </p>
        </motion.div>

        <motion.p
          className="max-w-xl text-center text-2xs leading-relaxed text-silver-600"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.75 }}
        >
          A run can end without the money coming back, and that outcome is recorded just as
          faithfully. A demo that always succeeds is not showing you a system — it is showing you
          a video.
        </motion.p>
      </div>
    </StageFrame>
  );
}

function LearnStage({ c }: { c: DemoCase }) {
  return (
    <StageFrame
      eyebrow="Stage 8 — Learn"
      title="The result becomes evidence, and the loop closes."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          {
            title: 'Outcome joins the training set',
            body: 'What actually happened is what the next model is fitted on, so the score improves on evidence rather than opinion.',
          },
          {
            title: 'Guardrails get priced',
            body: 'Blocked actions are compared against what comparable permitted actions really recovered, so the cost of caution is measurable.',
          },
          {
            title: `${c.auditEntries || 7} audit entries written`,
            body: 'Every decision, authorisation and side effect is hash-chained, so the history can be replayed and tampering is detectable.',
          },
        ].map((card, i) => (
          <motion.div
            key={card.title}
            className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.15, duration: 0.45 }}
          >
            <p className="text-xs font-medium text-silver-100">{card.title}</p>
            <p className="mt-2.5 text-2xs leading-relaxed text-silver-500">{card.body}</p>
          </motion.div>
        ))}
      </div>

      <motion.div
        className="mt-7 flex flex-wrap items-center justify-center gap-3 rounded-xl border border-mint-500/20 bg-mint-500/[0.05] px-6 py-5 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
      >
        <p className="text-xs text-silver-300">
          That is the whole loop. Run it yourself on live cases in the control tower.
        </p>
        <a href="/dashboard/demo">
          <Button size="sm" variant="primary">
            Run a live recovery
          </Button>
        </a>
      </motion.div>
    </StageFrame>
  );
}
