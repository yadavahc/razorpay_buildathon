import { toReclaimError } from '../errors/index.js';

/**
 * Structured logging. Records are plain objects so they can be shipped to Cloud Logging
 * verbatim; the console transport renders them compactly for local development.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  level: LogLevel;
  message: string;
  time: string;
  context: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export type LogSink = (record: LogRecord) => void;

export const consoleSink: LogSink = (record) => {
  const line = `[${record.level.toUpperCase()}] ${record.message}`;
  const ctx = Object.keys(record.context).length > 0 ? record.context : undefined;
  if (record.level === 'error') console.error(line, ctx ?? '');
  else if (record.level === 'warn') console.warn(line, ctx ?? '');
  else console.log(line, ctx ?? '');
};

/** Captures records in memory; used by tests and by the in-app system log viewer. */
export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = ((record: LogRecord) => {
    records.push(record);
    if (records.length > 2000) records.splice(0, records.length - 2000);
  }) as LogSink & { records: LogRecord[] };
  sink.records = records;
  return sink;
}

export function createLogger(
  base: Record<string, unknown> = {},
  opts: { level?: LogLevel; sinks?: LogSink[] } = {},
): Logger {
  const minLevel = LEVEL_ORDER[opts.level ?? 'info'];
  const sinks = opts.sinks ?? [consoleSink];

  const emit = (level: LogLevel, message: string, context: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const record: LogRecord = {
      level,
      message,
      time: new Date().toISOString(),
      context: { ...base, ...context },
    };
    for (const sink of sinks) sink(record);
  };

  return {
    debug: (message, context = {}) => emit('debug', message, context),
    info: (message, context = {}) => emit('info', message, context),
    warn: (message, context = {}) => emit('warn', message, context),
    error: (message, error, context = {}) => {
      const err = error === undefined ? undefined : toReclaimError(error);
      emit('error', message, {
        ...context,
        ...(err ? { errorCode: err.code, errorMessage: err.message, retryable: err.retryable } : {}),
      });
    },
    child: (context) => createLogger({ ...base, ...context }, opts),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
