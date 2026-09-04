'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The client data layer.
 *
 * Deliberately small: one hook for reads, one for mutations, both aware of the API
 * envelope. Loading, empty and error are distinct states everywhere rather than being
 * collapsed into "no data", because a screen that shows nothing should say whether that
 * is because it is loading, because there is nothing, or because something broke.
 */

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
  meta?: { durationMs: number; at: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Request options with a JSON body of any shape; it is serialised before dispatch. */
export type ApiRequestInit = Omit<RequestInit, 'body'> & { body?: unknown };

export async function apiFetch<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { body, ...rest } = init ?? {};
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...rest.headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(
      `The server returned a malformed response (HTTP ${response.status}).`,
      'INVALID_RESPONSE',
      true,
    );
  }

  if (!envelope.ok || envelope.data === undefined) {
    throw new ApiError(
      envelope.error?.message ?? `Request failed with HTTP ${response.status}.`,
      envelope.error?.code ?? 'UNKNOWN',
      envelope.error?.retryable ?? false,
    );
  }

  return envelope.data;
}

export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True during a background refresh while stale data is still on screen. */
  refreshing: boolean;
  refresh: () => Promise<void>;
  lastUpdated: string | null;
}

export function useApi<T>(
  path: string | null,
  options: { pollMs?: number; enabled?: boolean } = {},
): QueryState<T> {
  const { pollMs, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path) && enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // Guards against a slow response from a previous path overwriting a newer one.
  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (!path || !enabled) return;
      const id = ++requestId.current;

      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const result = await apiFetch<T>(path);
        if (!mounted.current || id !== requestId.current) return;
        setData(result);
        setError(null);
        setLastUpdated(new Date().toISOString());
      } catch (caught) {
        if (!mounted.current || id !== requestId.current) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError(
                caught instanceof Error ? caught.message : 'Unexpected error',
                'UNKNOWN',
                true,
              ),
        );
      } finally {
        if (mounted.current && id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [path, enabled],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!pollMs || !path || !enabled) return;
    const timer = setInterval(() => void load(true), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, path, enabled, load]);

  return {
    data,
    error,
    loading,
    refreshing,
    refresh: () => load(true),
    lastUpdated,
  };
}

export interface MutationState<TInput, TOutput> {
  run: (input: TInput) => Promise<TOutput | null>;
  data: TOutput | null;
  error: ApiError | null;
  pending: boolean;
  reset: () => void;
}

export function useMutation<TInput, TOutput>(
  path: string,
  options: { method?: 'POST' | 'DELETE'; onSuccess?: (data: TOutput) => void } = {},
): MutationState<TInput, TOutput> {
  const { method = 'POST', onSuccess } = options;
  const [data, setData] = useState<TOutput | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (input: TInput): Promise<TOutput | null> => {
      setPending(true);
      setError(null);
      try {
        const result = await apiFetch<TOutput>(path, {
          method,
          ...(method === 'POST' ? { body: input } : {}),
        });
        setData(result);
        onSuccess?.(result);
        return result;
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError(
                caught instanceof Error ? caught.message : 'Unexpected error',
                'UNKNOWN',
                true,
              ),
        );
        return null;
      } finally {
        setPending(false);
      }
    },
    [path, method, onSuccess],
  );

  return {
    run,
    data,
    error,
    pending,
    reset: () => {
      setData(null);
      setError(null);
    },
  };
}
