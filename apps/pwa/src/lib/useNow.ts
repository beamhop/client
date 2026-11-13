import { useEffect, useState } from 'react';

/** Current time, re-rendering every `ms` (countdowns, "4 min ago"). */
export const useNow = (ms = 1000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};
