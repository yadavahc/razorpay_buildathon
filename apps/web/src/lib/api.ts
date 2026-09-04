import { NextResponse } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { isReclaimError, toReclaimError } from '@reclaim/core';

/**
 * Route-handler plumbing: one place where every API response is shaped and every error
 * is converted. Handlers stay free of try/catch and status-code arithmetic, and the
 * client can rely on a single envelope shape.
 */

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: { durationMs: number; at: string };
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; retryable: boolean; details?: unknown };
  meta: { durationMs: number; at: string };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T, startedAt: number, init?: ResponseInit): NextResponse<ApiSuccess<T>> {
  return NextResponse.json(
    {
      ok: true as const,
      data,
      meta: { durationMs: Date.now() - startedAt, at: new Date().toISOString() },
    },
    init,
  );
}

export function fail(error: unknown, startedAt: number): NextResponse<ApiFailure> {
  const reclaimError = toReclaimError(error);
  const status = isReclaimError(error) ? reclaimError.httpStatus : 500;

  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: reclaimError.code,
        message: reclaimError.message,
        retryable: reclaimError.retryable,
        details: reclaimError.details,
      },
      meta: { durationMs: Date.now() - startedAt, at: new Date().toISOString() },
    },
    { status },
  );
}

/**
 * Wrap a handler so every uncaught error becomes a typed envelope. Validation errors from
 * zod are reported field-by-field rather than as an opaque 500.
 */
export function handler<T>(
  fn: (startedAt: number) => Promise<NextResponse<ApiSuccess<T>>>,
): () => Promise<NextResponse<ApiResponse<T>>> {
  return async () => {
    const startedAt = Date.now();
    try {
      return await fn(startedAt);
    } catch (error) {
      if (error instanceof ZodError) {
        return fail(
          {
            code: 'VALIDATION_FAILED',
            message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          },
          startedAt,
        );
      }
      console.error('[api] unhandled error', error);
      return fail(error, startedAt);
    }
  };
}

/** Parse and validate a JSON request body, or throw a typed validation error. */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  return schema.parse(raw);
}

export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function intParam(request: Request, name: string, fallback: number): number {
  const value = searchParams(request).get(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringParam(request: Request, name: string): string | null {
  return searchParams(request).get(name);
}
