/** Time helpers. Everything is UTC ISO-8601; local-time questions take an IANA zone. */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function toIso(value: Date | number | string): string {
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(value).toISOString();
}

export function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`invalid ISO timestamp: ${value}`);
  return ms;
}

export function addHours(iso: string, hours: number): string {
  return toIso(parseIso(iso) + hours * HOUR_MS);
}

export function addDays(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * DAY_MS);
}

export function hoursBetween(fromIso: string, toIsoValue: string): number {
  return (parseIso(toIsoValue) - parseIso(fromIso)) / HOUR_MS;
}

export function daysBetween(fromIso: string, toIsoValue: string): number {
  return (parseIso(toIsoValue) - parseIso(fromIso)) / DAY_MS;
}

export function isBefore(a: string, b: string): boolean {
  return parseIso(a) < parseIso(b);
}

export function maxIso(a: string, b: string): string {
  return parseIso(a) >= parseIso(b) ? a : b;
}

const TZ_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = TZ_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    TZ_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

export interface LocalClock {
  hour: number;
  minute: number;
  weekday: string;
  isWeekend: boolean;
}

/** Resolve wall-clock time in a customer's zone, used by quiet-hours enforcement. */
export function localClock(iso: string, timeZone: string): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone).formatToParts(new Date(parseIso(iso)));
  } catch {
    parts = formatterFor('UTC').formatToParts(new Date(parseIso(iso)));
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const weekday = get('weekday');
  return {
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
    weekday,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
  };
}

/** Bucket an instant into a UTC day key (YYYY-MM-DD) for time-series aggregation. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function hourKey(iso: string): number {
  return new Date(parseIso(iso)).getUTCHours();
}

/** Inclusive list of day keys spanning a range; keeps sparse charts continuous. */
export function dayRange(fromIso: string, toIsoValue: string): string[] {
  const out: string[] = [];
  let cursor = Date.UTC(
    new Date(parseIso(fromIso)).getUTCFullYear(),
    new Date(parseIso(fromIso)).getUTCMonth(),
    new Date(parseIso(fromIso)).getUTCDate(),
  );
  const end = parseIso(toIsoValue);
  while (cursor <= end) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return out;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < MINUTE_MS) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${(ms / HOUR_MS).toFixed(1)}h`;
  return `${(ms / DAY_MS).toFixed(1)}d`;
}

/**
 * An injectable clock. Services take one so tests can advance time deterministically
 * instead of sleeping, and so the simulator can replay months in milliseconds.
 */
export interface Clock {
  now(): number;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

export function fixedClock(startIso: string): Clock & { advance(ms: number): void; set(iso: string): void } {
  let current = parseIso(startIso);
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    set: (iso: string) => {
      current = parseIso(iso);
    },
  };
}
