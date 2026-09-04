import { type VariantProps, cva } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import type { Tone } from '@reclaim/core/presentation';

/** Merge Tailwind classes with later classes winning conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- */
/* Tone                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The single mapping from semantic tone to colour. Every badge, dot, bar and figure in
 * the product resolves its colour through here, so "positive" looks the same everywhere
 * and changing the palette is one edit.
 */
export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-mint-400',
  negative: 'text-loss-400',
  warning: 'text-risk-400',
  neutral: 'text-silver-400',
  accent: 'text-info-400',
};

export const TONE_BG: Record<Tone, string> = {
  positive: 'bg-mint-500/12 text-mint-400 border-mint-500/25',
  negative: 'bg-loss-500/12 text-loss-400 border-loss-500/25',
  warning: 'bg-risk-500/12 text-risk-400 border-risk-500/25',
  neutral: 'bg-white/[0.04] text-silver-400 border-white/[0.08]',
  accent: 'bg-info-500/12 text-info-400 border-info-500/25',
};

export const TONE_FILL: Record<Tone, string> = {
  positive: 'bg-mint-500',
  negative: 'bg-loss-500',
  warning: 'bg-risk-500',
  neutral: 'bg-silver-600',
  accent: 'bg-info-500',
};

/* -------------------------------------------------------------------------- */
/* Surface                                                                     */
/* -------------------------------------------------------------------------- */

export function Surface({
  className,
  raised,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'> & { raised?: boolean }) {
  return (
    <div className={cn(raised ? 'surface-raised' : 'surface', className)} {...props}>
      {children}
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Surface className={cn('flex flex-col overflow-hidden', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium text-silver-100">{title}</h2>}
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-silver-500">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('flex-1 p-5', bodyClassName)}>{children}</div>
    </Surface>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap transition-colors',
  {
    variants: {
      size: {
        sm: 'px-2 py-0.5 text-2xs',
        md: 'px-2.5 py-1 text-xs',
      },
      tone: {
        positive: TONE_BG.positive,
        negative: TONE_BG.negative,
        warning: TONE_BG.warning,
        neutral: TONE_BG.neutral,
        accent: TONE_BG.accent,
      },
    },
    defaultVariants: { size: 'sm', tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  size,
  dot,
  children,
  ...props
}: ComponentPropsWithoutRef<'span'> &
  VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full', TONE_FILL[(tone ?? 'neutral') as Tone])}
        />
      )}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-200 ease-smooth disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-mint-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 outline-none',
  {
    variants: {
      variant: {
        primary:
          'bg-mint-500 text-ink-950 hover:bg-mint-400 shadow-[0_0_0_1px_rgb(45_212_191_/_0.4)] hover:shadow-glow active:scale-[0.99]',
        secondary:
          'border border-white/[0.1] bg-white/[0.04] text-silver-200 hover:bg-white/[0.07] hover:text-silver-50 active:scale-[0.99]',
        ghost: 'text-silver-400 hover:bg-white/[0.05] hover:text-silver-100',
        danger:
          'border border-loss-500/30 bg-loss-500/10 text-loss-400 hover:bg-loss-500/20 active:scale-[0.99]',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4 text-sm',
        lg: 'h-11 px-6 text-sm',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  disabled,
  ...props
}: ComponentPropsWithoutRef<'button'> &
  VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('shimmer rounded-md bg-white/[0.04]', className)}
      aria-hidden="true"
    />
  );
}

export function LoadingState({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === rows - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-silver-600">{icon}</div>}
      <h3 className="text-sm font-medium text-silver-200">{title}</h3>
      <p className="max-w-md text-xs leading-relaxed text-silver-500 text-pretty">{description}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-loss-500/20 bg-loss-500/[0.04] px-6 py-10 text-center"
    >
      <h3 className="text-sm font-medium text-loss-400">{title}</h3>
      <p className="max-w-md text-xs leading-relaxed text-silver-400 text-pretty">{message}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

export function SectionHeading({
  eyebrow,
  title,
  description,
  as: Tag = 'h2',
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Restricted to heading levels so the tag stays valid and the type stays inferable. */
  as?: 'h1' | 'h2' | 'h3' | 'h4';
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {eyebrow && <p className="label-eyebrow">{eyebrow}</p>}
      <Tag className="text-lg font-medium tracking-tight text-silver-50 text-balance">{title}</Tag>
      {description && (
        <p className="max-w-2xl text-sm leading-relaxed text-silver-500 text-pretty">
          {description}
        </p>
      )}
    </div>
  );
}

/** A labelled figure. The building block of every metric readout in the product. */
export function Figure({
  label,
  value,
  hint,
  tone = 'neutral',
  size = 'md',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const valueSize =
    size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-base' : 'text-xl';
  return (
    <div className={cn('min-w-0', className)}>
      <p className="label-eyebrow truncate">{label}</p>
      {/* `tnum` only at small sizes, where these stack into aligned columns. */}
      <p
        className={cn(
          'mt-1.5 font-medium tracking-tight',
          size === 'sm' && 'tnum',
          valueSize,
          TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs leading-relaxed text-silver-600">{hint}</p>}
    </div>
  );
}

/** Horizontal proportion bar used in every breakdown table. */
export function ProportionBar({
  value,
  tone = 'neutral',
  className,
  label,
}: {
  value: number;
  tone?: Tone;
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cn('h-1 w-full overflow-hidden rounded-full bg-white/[0.06]', className)}
      role="img"
      aria-label={label ?? `${pct.toFixed(0)} percent`}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-700 ease-smooth', TONE_FILL[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-t border-white/[0.06]', className)} />;
}

/** Key/value row used in inspectors and detail panels. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-2', className)}>
      <dt className="shrink-0 text-xs text-silver-500">{label}</dt>
      <dd className="tnum min-w-0 text-right text-xs text-silver-200">{children}</dd>
    </div>
  );
}

/** Inline code / identifier rendering. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-2xs text-silver-500', className)}>{children}</span>
  );
}

/** Accessible tooltip-ish helper: a dotted underline with a native title. */
export function Explain({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <span
      title={hint}
      className="cursor-help border-b border-dotted border-silver-600 decoration-dotted"
    >
      {children}
    </span>
  );
}
