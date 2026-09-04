'use client';

import { motion } from 'framer-motion';
import { useSound } from './sound';
import { cn } from '@/components/ui/primitives';

/**
 * Sound control.
 *
 * Visible rather than hidden in a menu, because a page that makes noise owes the visitor
 * an obvious way to stop it. The bars animate only while sound is on and the context is
 * actually running, so the control shows the true state instead of the intended one.
 */
export function SoundToggle({ className }: { className?: string }) {
  const { enabled, setEnabled, armed, play } = useSound();
  const active = enabled && armed;

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      onMouseEnter={() => play('hover')}
      aria-pressed={enabled}
      aria-label={enabled ? 'Turn sound off' : 'Turn sound on'}
      title={enabled ? 'Sound on' : 'Sound off'}
      className={cn(
        'group flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08]',
        'bg-white/[0.03] transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07]',
        className,
      )}
    >
      <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            className={cn(
              'w-[2px] rounded-full transition-colors duration-300',
              enabled ? 'bg-mint-400' : 'bg-silver-600',
            )}
            initial={false}
            animate={
              active
                ? { height: ['30%', '100%', '45%', '80%', '30%'] }
                : { height: enabled ? '45%' : '28%' }
            }
            transition={
              active
                ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.14 }
                : { duration: 0.3 }
            }
            style={{ height: '30%' }}
          />
        ))}
      </span>
    </button>
  );
}
