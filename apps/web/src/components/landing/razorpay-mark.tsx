'use client';

import { cn } from '@/components/ui/primitives';

/**
 * RAZORPAY BRANDING
 *
 * RECLAIM is a decisioning layer that sits on top of a payment rail; this project targets
 * Razorpay's. The mark appears where the page is talking about that rail — the integration
 * badge, the provider chip, the architecture row — and nowhere else.
 *
 * It is deliberately always presented as an attribution ("Built for", "Runs on"), never as
 * a byline or a claim of endorsement. RECLAIM is not Razorpay and the page never implies
 * otherwise.
 */

/** The angular chevron mark, drawn as geometry so it stays crisp at any size. */
export function RazorpayMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 38"
      className={cn('h-6 w-auto', className)}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {/* Upper blade: the lighter, forward-leaning stroke. */}
      <path d="M20.4 0 18.1 8.6 6.5 15.3 10.8 0Z" fill="#3395FF" />
      {/* Lower body: the darker descending leg that closes the R. */}
      <path d="M13.2 13.7 4.4 38h6.9l3.6-9.9 9.9-5.7L32 0Z" fill="#072654" />
    </svg>
  );
}

/**
 * The integration lockup. Two registers: `badge` for the hero chip, `inline` for use
 * inside running prose or a footer.
 */
export function RazorpayBadge({
  variant = 'badge',
  label = 'Built for Razorpay',
  className,
}: {
  variant?: 'badge' | 'inline';
  label?: string;
  className?: string;
}) {
  if (variant === 'inline') {
    return (
      <span className={cn('inline-flex items-center gap-1.5 align-middle', className)}>
        <RazorpayMark className="h-3.5" />
        <span className="text-silver-400">Razorpay</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'group inline-flex items-center gap-2.5 rounded-full border border-razorpay-400/25 bg-razorpay-900/30 py-1.5 pl-3 pr-4',
        'backdrop-blur-xl transition-colors duration-300 hover:border-razorpay-400/50 hover:bg-razorpay-900/50',
        className,
      )}
    >
      <RazorpayMark className="h-4 transition-transform duration-500 group-hover:-translate-y-px" />
      <span className="text-2xs font-medium tracking-[0.14em] text-razorpay-300 uppercase">
        {label}
      </span>
    </span>
  );
}
