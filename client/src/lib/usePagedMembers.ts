import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, buildQuery } from './api.ts';
import type { MembersResponse, PublicMember } from './types.ts';

/**
 * Page-by-page ("show more") loading of a member directory endpoint. Changing
 * any filter starts again from page 1; stale responses are discarded.
 */
export function usePagedMembers(path: string, filters: Record<string, string>, pageSize = 12) {
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);
  const filterKey = JSON.stringify(filters);
  const lastFilterKey = useRef(filterKey);

  useEffect(() => {
    // A filter change always restarts at page 1, even if `page` was further along.
    const filtersChanged = lastFilterKey.current !== filterKey;
    lastFilterKey.current = filterKey;
    const targetPage = filtersChanged ? 1 : page;
    if (filtersChanged && page !== 1) {
      setPage(1);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    api
      .get<MembersResponse>(`${path}${buildQuery({ ...filters, page: targetPage, limit: pageSize })}`)
      .then((response) => {
        if (id !== requestId.current) return;
        setMembers((current) => (targetPage === 1 ? response.members : [...current, ...response.members]));
        setTotal(response.total);
      })
      .catch((caught: unknown) => {
        if (id !== requestId.current) return;
        setError(caught instanceof ApiError ? caught.message : 'Members could not be loaded.');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, filterKey, page, pageSize, nonce]);

  const loadMore = useCallback(() => setPage((p) => p + 1), []);
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { members, total, loading, error, loadMore, retry, hasMore: members.length < total };
}
