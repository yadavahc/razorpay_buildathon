/**
 * Money is represented exclusively as an integer number of minor units (paise for INR).
 *
 * Floating point money is a class of bug we refuse to ship: every amount that crosses a
 * service boundary, a policy check, or an audit record is an integer. Conversion to a
 * human readable string happens only at the presentation edge.
 */

export type CurrencyCode = 'INR';

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export const ZERO_INR: Money = Object.freeze({ amountMinor: 0, currency: 'INR' as const });

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertInteger(amountMinor: number, context: string): void {
  if (!Number.isFinite(amountMinor) || !Number.isInteger(amountMinor)) {
    throw new MoneyError(`${context}: expected integer minor units, received ${amountMinor}`);
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`${context}: amount exceeds safe integer range`);
  }
}

export function money(amountMinor: number, currency: CurrencyCode = 'INR'): Money {
  assertInteger(amountMinor, 'money()');
  return Object.freeze({ amountMinor, currency });
}

/** Build Money from a major-unit value (rupees). Rounds half-up to the nearest paisa. */
export function fromMajor(amountMajor: number, currency: CurrencyCode = 'INR'): Money {
  if (!Number.isFinite(amountMajor)) throw new MoneyError('fromMajor(): non-finite amount');
  return money(Math.round(amountMajor * 100), currency);
}

export function toMajor(value: Money | number): number {
  const minor = typeof value === 'number' ? value : value.amountMinor;
  return minor / 100;
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sumMoney(values: readonly Money[], currency: CurrencyCode = 'INR'): Money {
  return values.reduce<Money>((acc, v) => addMoney(acc, v), money(0, currency));
}

/**
 * Multiply an integer amount by a probability/ratio and round half-up to an integer.
 * Used by the expected-value engine, which must be reproducible across processes.
 */
export function scaleMinor(amountMinor: number, ratio: number): number {
  assertInteger(amountMinor, 'scaleMinor()');
  if (!Number.isFinite(ratio)) throw new MoneyError('scaleMinor(): non-finite ratio');
  return Math.round(amountMinor * ratio);
}

const INR_FORMAT = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

const INR_FORMAT_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function formatMinor(amountMinor: number, opts: { whole?: boolean } = {}): string {
  const fmt = opts.whole ? INR_FORMAT_WHOLE : INR_FORMAT;
  return fmt.format(amountMinor / 100);
}

/** Compact Indian-numbering display used across dashboard tiles. */
export function formatMinorCompact(amountMinor: number): string {
  const abs = Math.abs(amountMinor);
  const sign = amountMinor < 0 ? '-' : '';
  const rupee = '₹';
  if (abs >= 1_000_000_000) return `${sign}${rupee}${(abs / 1_000_000_000).toFixed(2)}Cr`;
  if (abs >= 10_000_000) return `${sign}${rupee}${(abs / 10_000_000).toFixed(2)}L`;
  if (abs >= 100_000) return `${sign}${rupee}${(abs / 100_000).toFixed(1)}K`;
  return `${sign}${rupee}${(abs / 100).toFixed(0)}`;
}
