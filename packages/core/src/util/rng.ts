/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic part of RECLAIM — the synthetic dataset, the demo payment provider,
 * the strategy simulator — draws from a seeded generator so that a demo replayed on a
 * different machine produces byte-identical numbers. Reproducibility is what lets us
 * claim measured results rather than illustrative ones.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  bool(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights need not sum to 1. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** Standard normal via Box-Muller. */
  normal(mean?: number, stdDev?: number): number;
  /** Exponential with the given mean; used for inter-arrival times. */
  exponential(mean: number): number;
  shuffle<T>(items: T[]): T[];
}

/** mulberry32 — small, fast, and good enough for simulation work. */
export function createRng(seed: number | string): Rng {
  let state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`int(${min}, ${max}): empty range`);
      return min + Math.floor(next() * (max - min + 1));
    },
    bool(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick(): empty collection');
      return items[Math.floor(next() * items.length)]!;
    },
    weighted(entries) {
      if (entries.length === 0) throw new RangeError('weighted(): empty collection');
      const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
      if (total <= 0) return entries[0]![0];
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= Math.max(0, weight);
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
    normal(mean = 0, stdDev = 1) {
      const u1 = Math.max(next(), Number.EPSILON);
      const u2 = next();
      return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
    exponential(mean) {
      return -Math.log(Math.max(next(), Number.EPSILON)) * mean;
    },
    shuffle(items) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return items;
    },
  };

  return rng;
}

export function hashSeed(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Log-normal draw clamped to a range; models realistic transaction amounts. */
export function logNormalAmount(
  rng: Rng,
  opts: { median: number; sigma: number; min: number; max: number },
): number {
  const raw = Math.exp(Math.log(opts.median) + rng.normal(0, opts.sigma));
  return Math.min(opts.max, Math.max(opts.min, Math.round(raw)));
}
