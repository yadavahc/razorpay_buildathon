'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { Tone } from '@reclaim/core/presentation';
import { Surface, TONE_TEXT, cn } from '@/components/ui/primitives';

/**
 * The metric tile.
 *
 * One shape for every headline figure in the product. It carries a definition alongside
 * the number, because "revenue at risk" and "recoverable revenue" are different
 * quantities and a dashboard that does not say which is which is not measuring anything.
 */
export interface MetricTileProps {
  label: string;
  value: ReactNode;
  /** What this number actually counts. Shown on hover and to screen readers. */
  definition: string;
  hint?: ReactNode;
  tone?: Tone;
  delta?: { value: string; tone: Tone } | null;
  emphasis?: boolean;
  className?: string;
}

export function MetricTile({
  label,
  value,
  definition,
  hint,
  tone = 'neutral',
  delta,
  emphasis,
  className,
}: MetricTileProps) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={reduced ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      <Surface
        className={cn(
          'group h-full p-5 transition-colors',
          emphasis && 'border-mint-500/20 bg-gradient-to-b from-mint-500/[0.06] to-ink-900/90',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="label-eyebrow" title={definition}>
            {label}
          </p>
          {delta && (
            <span className={cn('tnum text-2xs font-medium', TONE_TEXT[delta.tone])}>
              {delta.value}
            </span>
          )}
        </div>

        {/* Proportional figures: equal-width digits make a large standalone number
            look loose. `tnum` is reserved for columns that align vertically. */}
        <p className={cn('mt-3 text-2xl font-medium tracking-tight sm:text-[1.75rem]', TONE_TEXT[tone])}>
          {value}
        </p>

        {hint && <p className="mt-1.5 text-2xs leading-relaxed text-silver-600">{hint}</p>}

        <p className="sr-only">{definition}</p>
      </Surface>
    </motion.div>
  );
}

export function MetricGrid({
  children,
  columns = 4,
  className,
}: {
  children: ReactNode;
  columns?: 3 | 4 | 5;
  className?: string;
}) {
  const gridClass = {
    3: 'sm:grid-cols-2 lg:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
  }[columns];

  return <div className={cn('grid gap-4', gridClass, className)}>{children}</div>;
}

/**
 * A page header with an optional live-refresh indicator. The timestamp matters: these
 * screens poll, and a viewer should know how fresh what they are reading is.
 */
export function PageHeader({
  title,
  description,
  actions,
  lastUpdated,
  refreshing,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  lastUpdated?: string | null;
  refreshing?: boolean;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <h1 className="text-xl font-medium tracking-tight text-silver-50">{title}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-silver-500 text-pretty">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {lastUpdated && (
          <span className="flex items-center gap-1.5 text-2xs text-silver-600" aria-live="polite">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                refreshing ? 'animate-pulse bg-mint-400' : 'bg-silver-700',
              )}
              aria-hidden
            />
            {refreshing ? 'Refreshing' : `Updated ${new Date(lastUpdated).toLocaleTimeString('en-IN', { hour12: false })}`}
          </span>
        )}
        {actions}
      </div>
    </header>
  );
}
