/** "You" on this daemon (`system.whoami`), as the set of names votes and decisions carry. */
import { useMemo } from 'react';
import { useApi } from '../../api/index.ts';
import { meNames } from './model.ts';

export const useMe = (): ReadonlySet<string> => {
  const w = useApi('system.whoami', undefined, { staleTime: 5 * 60_000 });
  return useMemo(() => meNames(w.data), [w.data]);
};
