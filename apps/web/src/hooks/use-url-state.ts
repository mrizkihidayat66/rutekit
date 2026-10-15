import { useCallback, useEffect, useState } from 'react';
import { useLocation, useSearchParams, type Location } from 'react-router';

/**
 * Bookmarkable view state (RULESET R6.5).
 *
 * A filter, a window or an open request is part of what the operator is looking
 * at, so it belongs in the URL: a link pasted into a chat reopens the same view,
 * and the back button undoes a filter the way the operator expects. Everything
 * here writes with `replace` — a filter change is a refinement of the current
 * view, not a new page, and pushing one history entry per keystroke would make
 * the back button useless.
 *
 * Values that are unknown or absent fall back rather than throwing, so a hand-
 * edited or stale URL renders a sane page instead of an error.
 */

/** How long typing settles before the URL is rewritten. */
const TEXT_SYNC_MS = 250;

/**
 * The params the last write produced, tagged with the location it started from.
 *
 * One operator action often writes two params — changing the sort column sets
 * both `sort` and `direction` — and `useSearchParams` hands every setter the
 * params of the render it was created in. Two setters called in one tick both
 * start from that same pre-write snapshot, so the second navigation carries only
 * its own change and the first is silently dropped. Keeping the result of the
 * last write here lets the second build on it instead.
 *
 * Tagged with the location object rather than cleared on a timer. Every hook in
 * a render is handed the same object, so writes in one tick find each other; a
 * navigation produces a new one, so an entry cannot outlive the write it
 * describes, and a router mounted later cannot inherit an earlier one's.
 */
let pending: { readonly from: Location; readonly params: URLSearchParams } | null = null;

/**
 * The params with one key set or removed, or `null` when that is no change — so
 * a setter asked to store what the URL already says rewrites nothing.
 */
function withParam(
  location: Location,
  params: URLSearchParams,
  key: string,
  stored: string | null,
): URLSearchParams | null {
  const base = pending !== null && pending.from === location ? pending.params : params;
  if (base.get(key) === stored) return null;
  const next = new URLSearchParams(base);
  if (stored === null) next.delete(key);
  else next.set(key, stored);
  pending = { from: location, params: next };
  return next;
}

export function useUrlParam<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): readonly [T, (next: T) => void] {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value =
    raw !== null && (allowed === undefined || allowed.includes(raw as T)) ? (raw as T) : fallback;

  const set = useCallback(
    (next: T) => {
      const written = withParam(location, params, key, next === fallback ? null : next);
      if (written !== null) setParams(written, { replace: true });
    },
    [location, params, key, fallback, setParams],
  );

  return [value, set] as const;
}

export function useUrlFlag(
  key: string,
  fallback = false,
): readonly [boolean, (next: boolean) => void] {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw === null ? fallback : raw === 'true' || raw === '1';

  const set = useCallback(
    (next: boolean) => {
      const stored = next === fallback ? null : next ? 'true' : 'false';
      const written = withParam(location, params, key, stored);
      if (written !== null) setParams(written, { replace: true });
    },
    [location, params, key, fallback, setParams],
  );

  return [value, set] as const;
}

/**
 * Free text held in the URL, but only after typing settles — the input stays
 * responsive while the address bar and the request wait for a pause.
 */
export function useUrlText(key: string, fallback = ''): readonly [string, (next: string) => void] {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get(key) ?? fallback);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const stored = text === '' || text === fallback ? null : text;
      const written = withParam(location, params, key, stored);
      if (written !== null) setParams(written, { replace: true });
    }, TEXT_SYNC_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [location, params, text, key, fallback, setParams]);

  return [text, setText] as const;
}
