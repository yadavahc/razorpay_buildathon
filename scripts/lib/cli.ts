import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Shared plumbing for the CLI scripts: argument parsing, env loading, table output. */

export interface Args {
  string(name: string): string | undefined;
  number(name: string): number | undefined;
  boolean(name: string): boolean;
  positional(index: number): string | undefined;
}

/** Supports `--flag value`, `--flag=value` and bare `--flag` booleans. */
export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }

  return {
    string: (name) => {
      const value = flags.get(name);
      return typeof value === 'string' ? value : undefined;
    },
    number: (name) => {
      const value = flags.get(name);
      if (typeof value !== 'string') return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    },
    boolean: (name) => flags.get(name) === true || flags.get(name) === 'true',
    positional: (index) => positionals[index],
  };
}

/**
 * Minimal .env loader. Deliberately not a dependency: it reads `.env.local` then `.env`,
 * never overwrites a variable already present in the real environment, and handles the
 * quoted multi-line values that service-account private keys arrive as.
 */
export function loadEnv(files: readonly string[] = ['.env.local', '.env']): void {
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    const envDir = dirname(path);

    const content = readFileSync(path, 'utf-8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;

      const equals = line.indexOf('=');
      if (equals === -1) continue;

      const key = line.slice(0, equals).trim();
      if (key === '' || process.env[key] !== undefined) continue;

      let value = line.slice(equals + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }

  // A relative credential path in a .env file means "relative to that file", not to
  // whatever directory the process happens to be started from. Anchor it so the Google
  // auth library finds the key regardless of the caller's cwd.
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentials && !isAbsolute(credentials)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(process.cwd(), credentials);
  }
}

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;

const supportsColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: string, text: string): string => (supportsColor ? `${code}${text}${RESET}` : text);

export const colors = {
  bold: (text: string) => paint(BOLD, text),
  dim: (text: string) => paint(DIM, text),
  green: (text: string) => paint(GREEN, text),
  red: (text: string) => paint(RED, text),
  yellow: (text: string) => paint(YELLOW, text),
};

export function section(title: string): void {
  console.log(`\n${colors.bold(title)}`);
  console.log(colors.dim('─'.repeat(Math.max(24, title.length))));
}

/** Column-aligned table. Numeric-looking columns are right-aligned. */
export function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no rows)'));
    return;
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  const isNumericColumn = headers.map((_, index) =>
    rows.every((row) => /^[\d,.\s₹%+-]*$/.test(row[index] ?? '')),
  );

  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        isNumericColumn[index] ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!),
      )
      .join('  ');

  console.log(colors.dim(renderRow(headers)));
  console.log(colors.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of rows) console.log(renderRow(row));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function percent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Simple in-place progress line for long batch runs. */
export function progress(done: number, total: number, label: string): void {
  if (!process.stdout.isTTY) return;
  const width = 28;
  const ratio = total === 0 ? 1 : done / total;
  const filled = Math.round(ratio * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  process.stdout.write(`\r${bar} ${done}/${total} ${label}`.padEnd(80));
  if (done >= total) process.stdout.write('\n');
}
