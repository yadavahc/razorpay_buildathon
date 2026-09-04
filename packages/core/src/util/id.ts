import type { Rng } from './rng.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Identifier factory. Production paths use a monotonic counter plus entropy so ids sort
 * roughly by creation time; seeded paths (dataset generation, simulations) pass an Rng so
 * the whole corpus is reproducible.
 */
export interface IdFactory {
  next(prefix: string): string;
}

export function createIdFactory(rng?: Rng): IdFactory {
  let counter = 0;
  return {
    next(prefix: string): string {
      counter += 1;
      const time = Date.now().toString(36).padStart(9, '0');
      const seq = counter.toString(36).padStart(4, '0');
      const noise = rng
        ? Array.from({ length: 6 }, () => ALPHABET[rng.int(0, ALPHABET.length - 1)]).join('')
        : Math.floor(Math.random() * 2176782336)
            .toString(36)
            .padStart(6, '0');
      return `${prefix}_${time}${seq}${noise}`;
    },
  };
}

/** Fully deterministic ids for seeded corpora: `cust_000123`. */
export function seededId(prefix: string, index: number, width = 6): string {
  return `${prefix}_${index.toString().padStart(width, '0')}`;
}

export const defaultIdFactory = createIdFactory();

export function newId(prefix: string): string {
  return defaultIdFactory.next(prefix);
}
