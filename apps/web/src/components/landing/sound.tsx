'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * LANDING PAGE SOUND DESIGN
 *
 * Every sound here is synthesised at play time from oscillators and a noise buffer. There
 * are no audio files: the whole palette is a few hundred bytes of code, nothing to load,
 * and nothing that can 404 on a cold deploy.
 *
 * Three rules keep it from becoming annoying, which is the default failure mode of sound
 * on a web page:
 *
 *   1. Nothing plays until the visitor has interacted with the document. The AudioContext
 *      is not even constructed before then, so this cannot trip a browser autoplay policy
 *      or emit a console warning.
 *   2. Everything is quiet and short. Master gain is 0.14; the longest cue is 700ms. They
 *      are meant to be felt at the edge of attention, not heard.
 *   3. It is one click to turn off, the choice persists, and the page honours the OS
 *      reduced-motion setting by starting muted — someone who has asked for less motion
 *      has told you something about how they want to be addressed.
 *
 * Scoped to the landing page. The dashboard is a working tool and stays silent.
 */

export type Cue =
  | 'hover'
  | 'press'
  | 'section'
  | 'step'
  | 'success'
  | 'open'
  | 'close'
  | 'toggle';

interface SoundApi {
  play: (cue: Cue, options?: { index?: number }) => void;
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** True once the visitor has interacted and the context exists. */
  armed: boolean;
}

const SoundContext = createContext<SoundApi | null>(null);

const STORAGE_KEY = 'reclaim.sound';
const MASTER_GAIN = 0.14;

/** A pentatonic run, so consecutive step cues never form a dissonant interval. */
const STEP_SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51];

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [armed, setArmed] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const noiseRef = useRef<AudioBuffer | null>(null);
  // Read through a ref inside listeners so we never rebind them on every toggle.
  const enabledRef = useRef(false);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Restore the stored preference, defaulting to on unless reduced motion is requested.
  useEffect(() => {
    let initial = true;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) initial = stored === 'on';
      else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) initial = false;
    } catch {
      // Private mode, or storage disabled. The default stands.
    }
    setEnabledState(initial);
  }, []);

  const ensureContext = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);

    // One second of white noise, reused by every cue that needs air or texture.
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    ctxRef.current = ctx;
    masterRef.current = master;
    noiseRef.current = buffer;
    return ctx;
  }, []);

  // Arm on the first genuine interaction. Pointer, key and touch all count.
  useEffect(() => {
    const arm = () => {
      const ctx = ensureContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') void ctx.resume();
      setArmed(true);
    };
    const opts = { once: true, passive: true } as const;
    window.addEventListener('pointerdown', arm, opts);
    window.addEventListener('keydown', arm, opts);
    window.addEventListener('touchstart', arm, opts);
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      window.removeEventListener('touchstart', arm);
    };
  }, [ensureContext]);

  // Release the hardware when the tab is hidden, and pick it back up on return.
  useEffect(() => {
    const onVisibility = () => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      if (document.hidden) void ctx.suspend();
      else if (enabledRef.current) void ctx.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    return () => {
      void ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, []);

  const play = useCallback(
    (cue: Cue, options?: { index?: number }) => {
      if (!enabledRef.current) return;
      const ctx = ctxRef.current;
      const master = masterRef.current;
      if (!ctx || !master || ctx.state !== 'running') return;

      const now = ctx.currentTime;

      /** A single enveloped oscillator. */
      const tone = (
        freq: number,
        opts: {
          type?: OscillatorType;
          at?: number;
          dur?: number;
          gain?: number;
          glideTo?: number;
        } = {},
      ) => {
        const { type = 'sine', at = 0, dur = 0.18, gain = 0.5, glideTo } = opts;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now + at);
        if (glideTo !== undefined) {
          osc.frequency.exponentialRampToValueAtTime(glideTo, now + at + dur);
        }
        // A 12ms attack keeps every cue click-free without sounding soft.
        env.gain.setValueAtTime(0.0001, now + at);
        env.gain.exponentialRampToValueAtTime(gain, now + at + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
        osc.connect(env).connect(master);
        osc.start(now + at);
        osc.stop(now + at + dur + 0.02);
      };

      /** Filtered noise, for air and transitions. */
      const air = (
        opts: { at?: number; dur?: number; gain?: number; from?: number; to?: number } = {},
      ) => {
        const { at = 0, dur = 0.5, gain = 0.16, from = 400, to = 2600 } = opts;
        const buffer = noiseRef.current;
        if (!buffer) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.1;
        filter.frequency.setValueAtTime(from, now + at);
        filter.frequency.exponentialRampToValueAtTime(to, now + at + dur);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, now + at);
        env.gain.exponentialRampToValueAtTime(gain, now + at + dur * 0.3);
        env.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
        src.connect(filter).connect(env).connect(master);
        src.start(now + at);
        src.stop(now + at + dur + 0.02);
      };

      switch (cue) {
        case 'hover':
          // Barely there: a single high tick at the threshold of notice.
          tone(2400, { type: 'sine', dur: 0.045, gain: 0.06 });
          break;

        case 'press':
          tone(760, { type: 'triangle', dur: 0.09, gain: 0.3, glideTo: 520 });
          tone(1520, { type: 'sine', dur: 0.05, gain: 0.09 });
          break;

        case 'section':
          // The scroll transition. A low swell under a rising band of air, so it reads as
          // movement between places rather than as an event.
          air({ dur: 0.62, gain: 0.052, from: 300, to: 2100 });
          tone(146.83, { type: 'sine', dur: 0.6, gain: 0.14, glideTo: 220 });
          break;

        case 'step': {
          // Walks the pentatonic scale as the demo advances, so eight steps rise.
          const i = Math.max(0, options?.index ?? 0) % STEP_SCALE.length;
          const f = STEP_SCALE[i] ?? STEP_SCALE[0]!;
          tone(f, { type: 'sine', dur: 0.26, gain: 0.24 });
          tone(f * 2, { type: 'sine', dur: 0.16, gain: 0.05 });
          break;
        }

        case 'success':
          // A major triad, arpeggiated tight. Reserved for money actually coming back.
          tone(523.25, { type: 'sine', dur: 0.4, gain: 0.22 });
          tone(659.25, { type: 'sine', at: 0.07, dur: 0.38, gain: 0.19 });
          tone(783.99, { type: 'sine', at: 0.14, dur: 0.44, gain: 0.17 });
          air({ at: 0.05, dur: 0.5, gain: 0.03, from: 1800, to: 5200 });
          break;

        case 'open':
          air({ dur: 0.42, gain: 0.06, from: 240, to: 3000 });
          tone(330, { type: 'sine', dur: 0.34, gain: 0.16, glideTo: 495 });
          break;

        case 'close':
          air({ dur: 0.34, gain: 0.05, from: 2600, to: 320 });
          tone(440, { type: 'sine', dur: 0.26, gain: 0.13, glideTo: 262 });
          break;

        case 'toggle':
          tone(880, { type: 'sine', dur: 0.12, gain: 0.2 });
          break;
      }
    },
    [],
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      enabledRef.current = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
      } catch {
        // Preference just will not persist; the toggle still works this session.
      }
      if (next) {
        const ctx = ensureContext();
        if (ctx?.state === 'suspended') void ctx.resume();
        setArmed(true);
        // Confirm the choice audibly — the only sound that plays on its own trigger.
        window.setTimeout(() => play('toggle'), 40);
      }
    },
    [ensureContext, play],
  );

  const value = useMemo<SoundApi>(
    () => ({ play, enabled, setEnabled, armed }),
    [play, enabled, setEnabled, armed],
  );

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

/**
 * Safe outside a provider: returns a no-op so a shared component can call `play` without
 * knowing whether it is rendered on the landing page or in the silent dashboard.
 */
export function useSound(): SoundApi {
  const ctx = useContext(SoundContext);
  return (
    ctx ?? {
      play: () => {},
      enabled: false,
      setEnabled: () => {},
      armed: false,
    }
  );
}

/** Fires the section cue once, the first time a section scrolls into view. */
export function useSectionCue<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const { play } = useSound();
  const firedRef = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || firedRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || firedRef.current) continue;
          firedRef.current = true;
          play('section');
          observer.disconnect();
        }
      },
      // Well inside the viewport, so the cue lands when the section is actually being
      // read rather than when its first pixel clips the bottom edge.
      { threshold: 0.35 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, play]);
}
