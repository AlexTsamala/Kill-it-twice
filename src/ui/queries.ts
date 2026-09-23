import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';

import { getJson } from './api.js';
import type { DeadLetter, ProductHit, RuntimeConfig, StatusReport } from './types.js';

export const STATUS_INTERVAL_MS = 2000;
const DLQ_INTERVAL_MS = 4000;
const CONFIG_INTERVAL_MS = 5000;

export const keys = {
  status: ['status'] as const,
  dlq: ['dlq'] as const,
  config: ['config'] as const,
  products: (query: string, page: number) => ['products', query, page] as const,
};

/** Errors surface rather than being retried away: a failing admin call is information, and
 *  the polling interval already recovers once the api is reachable again. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

export function useStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: () => getJson<StatusReport>('/admin/status'),
    refetchInterval: STATUS_INTERVAL_MS,
  });
}

export function useDeadLetters() {
  return useQuery({
    queryKey: keys.dlq,
    queryFn: () => getJson<{ rows: DeadLetter[]; count: number }>('/admin/dlq?limit=100'),
    refetchInterval: DLQ_INTERVAL_MS,
  });
}

export function useRuntimeConfig() {
  return useQuery({
    queryKey: keys.config,
    queryFn: () => getJson<RuntimeConfig>('/admin/control/config'),
    refetchInterval: CONFIG_INTERVAL_MS,
  });
}

export interface ProductSearch {
  total: number;
  reachable: number;
  hits: ProductHit[];
}

/** Keyed on the term and page, so a slow response for an abandoned search can no longer
 *  overwrite a newer one — the race the hand-rolled effect had. */
export function useProductSearch(query: string, page: number, pageSize: number) {
  return useQuery({
    queryKey: keys.products(query, page),
    queryFn: () => {
      const params = new URLSearchParams({
        q: query,
        from: String(page * pageSize),
        size: String(pageSize),
      });
      return getJson<ProductSearch>(`/admin/products?${params.toString()}`);
    },
    placeholderData: (previous) => previous,
  });
}

export type ControlAction = () => Promise<unknown>;

/** One mutation per screen, taking the action as its variable. Every control action
 *  invalidates the same three reads, so a screen cannot forget one. */
export function useControlAction(): UseMutationResult<unknown, Error, ControlAction> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (action: ControlAction) => action(),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.status }),
        client.invalidateQueries({ queryKey: keys.dlq }),
        client.invalidateQueries({ queryKey: keys.config }),
      ]);
    },
  });
}
