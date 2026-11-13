/** Router-level pending and error components (shown only if a lazy screen takes >300 ms). */
import type { ErrorComponentProps } from '@tanstack/react-router';
import { t } from '../i18n/index.ts';
import { ErrorState, Skeleton } from '../ui/States.tsx';

export const RoutePending = () => (
  <div className="px-gutter pt-[calc(var(--bh-safe-top)+68px)] expanded:pt-8">
    <Skeleton variant="cards" count={2} label={t('ui.routeStates.loadingScreen')} />
  </div>
);

export const RouteError = ({ error, reset }: ErrorComponentProps) => (
  <div className="px-gutter pt-[calc(var(--bh-safe-top)+68px)] expanded:pt-8">
    <ErrorState title={t('ui.routeStates.thisScreenDidnT')} details={error} onRetry={reset}>
      {error instanceof Error ? error.message : String(error)}
    </ErrorState>
  </div>
);
