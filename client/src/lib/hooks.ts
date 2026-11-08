import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, recentResponses } from './api.ts';
import { useAuth } from '../state/AuthContext.tsx';

const RECENT_LIMIT = 60;

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches `path` and refetches whenever it changes. Out-of-order responses are
 * discarded so fast typing in a search box cannot render a stale result.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []): AsyncState<T> & {
  reload: () => void;
  setData: (updater: (previous: T | null) => T | null) => void;
} {
  const [state, setState] = useState<AsyncState<T>>({
    data: path ? ((recentResponses.get(path) as T | undefined) ?? null) : null,
    loading: !!path,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const id = ++requestId.current;
    const recent = recentResponses.get(path) as T | undefined;
    setState((previous) => ({ data: recent ?? previous.data, loading: true, error: null }));

    api
      .get<T>(path)
      .then((data) => {
        recentResponses.delete(path);
        recentResponses.set(path, data);
        if (recentResponses.size > RECENT_LIMIT) recentResponses.delete(recentResponses.keys().next().value as string);
        if (id === requestId.current) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        const message = error instanceof ApiError ? error.message : 'Something went wrong.';
        setState({ data: null, loading: false, error: message });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (updater: (previous: T | null) => T | null) =>
      setState((previous) => {
        const data = updater(previous.data);
        if (path && data) recentResponses.set(path, data);
        return { ...previous, data };
      }),
    [path],
  );

  return { ...state, reload, setData };
}

/** Delays a fast-changing value, so each keystroke does not hit the API. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Runs `handler` when Escape is pressed, for dismissible overlays. */
export function useEscapeKey(handler: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handler, active]);
}

/** Community reads go to /community when signed in, and to the read-only /public API for guests. */
export function useCommunityBase(): '/community' | '/public' {
  const { user } = useAuth();
  return user ? '/community' : '/public';
}
