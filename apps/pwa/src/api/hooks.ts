/**
 * Typed data hooks. The only way screens should talk to the daemon.
 *
 *   const { data, isPending, error } = useApi('agent.list');
 *   const stop = useMutationApi('agent.stop');           // stop.mutate({ name: 'reviewer' })
 *   useServerEvent((e) => { if (e.type === 'session.event') … });
 *
 * Results are typed from `@beamhop/core` `methods`; params are checked at compile time.
 */
import type { MethodName, Params, Result, ServerEvent } from '@beamhop/core';
import {
  type UseMutationOptions,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { apiKey, invalidationsFor } from './keys.ts';
import { useBeamhop } from './provider.tsx';

type Call = (method: string, params?: unknown) => Promise<unknown>;

export type ApiQueryOptions<M extends MethodName> = Omit<
  UseQueryOptions<Result<M>, Error, Result<M>, ReturnType<typeof apiKey<M>>>,
  'queryKey' | 'queryFn'
>;

/** Read a method. Cached by `[method, params]`; kept fresh by pushed events (see events.ts). */
export function useApi<M extends MethodName>(
  method: M,
  params?: Params<M>,
  options?: ApiQueryOptions<M>,
): UseQueryResult<Result<M>, Error> {
  const { client } = useBeamhop();
  return useQuery({
    queryKey: apiKey(method, params),
    queryFn: () => (client.call as Call)(method, params ?? {}) as Promise<Result<M>>,
    ...options,
  });
}

export type ApiMutationOptions<M extends MethodName> = Omit<
  UseMutationOptions<Result<M>, Error, Params<M>>,
  'mutationFn'
> & {
  /** Extra methods to invalidate on success (in addition to the defaults in keys.ts). */
  invalidate?: MethodName[];
};

/** Call a mutating method. On success the related reads are invalidated (keys.ts INVALIDATES). */
export function useMutationApi<M extends MethodName>(method: M, options: ApiMutationOptions<M> = {}) {
  const { client } = useBeamhop();
  const qc = useQueryClient();
  const { invalidate, onSuccess, ...rest } = options;
  return useMutation<Result<M>, Error, Params<M>>({
    mutationFn: (params: Params<M>) => (client.call as Call)(method, params ?? {}) as Promise<Result<M>>,
    ...rest,
    onSuccess: async (data, vars, ctx, mctx) => {
      const targets = invalidationsFor(method);
      if (targets === 'all') await qc.invalidateQueries({ queryKey: ['bh'] });
      else
        await Promise.all(
          [...targets, ...(invalidate ?? [])].map((m) => qc.invalidateQueries({ queryKey: ['bh', m] })),
        );
      await onSuccess?.(data, vars, ctx, mctx);
    },
  });
}

/** Imperative call (e.g. inside an event handler where a mutation hook is awkward). */
export const useCall = () => {
  const { client } = useBeamhop();
  return <M extends MethodName>(method: M, params?: Params<M>): Promise<Result<M>> =>
    (client.call as Call)(method, params ?? {}) as Promise<Result<M>>;
};

/** Subscribe to raw pushed events (caches are already updated before your handler runs). */
export const useServerEvent = (fn: (e: ServerEvent) => void): void => {
  const { subscribe } = useBeamhop();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
};
