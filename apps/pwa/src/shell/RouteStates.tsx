/** Router-level pending and error components (shown only if a lazy screen takes >300 ms). */
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { t } from '../i18n/index.ts';
import { ErrorState, Skeleton } from '../ui/States.tsx';

export const RoutePending = () => (
  <div className="px-gutter pt-[calc(var(--bh-safe-top)+68px)] expanded:pt-8">
    <Skeleton variant="cards" count={2} label={t('ui.routeStates.loadingScreen')} />
  </div>
);

/** The screen's code never arrived (offline, a new deploy replaced the chunk): only a reload fetches it again. */
const CHUNK_FAILED =
  /dynamically imported module|Importing a module script failed|Failed to fetch|Loading chunk|module script/i;

export const RouteError = ({ error, reset }: ErrorComponentProps) => {
  const router = useRouter();
  const message = error instanceof Error ? error.message : String(error);
  // The router keeps a lazy screen's failed import, so `reset` alone shows the same error again.
  const retry = () => {
    if (CHUNK_FAILED.test(message)) window.location.reload();
    else {
      reset();
      void router.invalidate();
    }
  };
  return (
    <div className="px-gutter pt-[calc(var(--bh-safe-top)+68px)] expanded:pt-8">
      <ErrorState title={t('ui.routeStates.thisScreenDidnT')} details={error} onRetry={retry}>
        {message}
      </ErrorState>
    </div>
  );
};
