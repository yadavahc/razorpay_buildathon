'use client';

import { useInView } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

/**
 * A figure that counts up when it scrolls into view.
 *
 * The animation is presentation only — the value is always the real one, and under
 * reduced motion or before the element is visible it renders the final number directly
 * rather than a misleading intermediate figure.
 */
export function AnimatedNumber({
  value,
  format,
  durationMs = 1400,
  className,
}: {
  value: number;
  format: (value: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const [display, setDisplay] = useState(value);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    setAnimate(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    if (!inView || !animate) {
      setDisplay(value);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      // easeOutExpo: fast, then settles — reads as a counter locking on.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplay(value * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, animate, value, durationMs]);

  return (
    <span ref={ref} className={className}>
      {format(display)}
    </span>
  );
}
