/**
 * New agent: one page shared with first-run setup (CreateAgentForm). Expanded: the form on the left, a
 * sticky live preview (what it can reach, where it listens) on the right; compact: the preview follows the
 * form. Creating it either opens the agent or, when the owner picked a new place to connect, that
 * channel's setup with this agent already chosen to join.
 */
import { useNavigate } from '@tanstack/react-router';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { useCreateAgent } from './CreateAgentForm.tsx';

export const NewAgentScreen = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const c = useCreateAgent({
    onCreated: ({ agent, connect }) => {
      toast.show({ tone: 'success', message: t('agents.new.created', { name: agent.config.name }) });
      if (connect)
        void navigate({ to: '/channels/add/$provider/$step', params: { provider: connect, step: '1' } });
      else void navigate({ to: '/agents/$name', params: { name: agent.config.name } });
    },
  });
  const showSkel = useDelayedLoading(c.loading);

  return (
    <Screen
      title={t('agents.new.title')}
      back={{ href: '/agents', label: t('nav.agents') }}
      pane="detail"
      maxWidth="none"
      crumbs={[{ label: t('nav.agents'), href: '/agents' }, { label: t('agents.new.title') }]}
    >
      {c.loading ? (
        showSkel && <Skeleton variant="cards" count={2} label={t('agents.new.loading')} />
      ) : c.loadError ? (
        <ErrorState title={t('agents.new.loadError')} details={c.loadError} onRetry={c.retry} />
      ) : (
        <div className="@container/new">
          <div className="grid gap-8 @min-[50rem]/new:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 flex-col gap-6">
              {c.form}
              <div className="@min-[50rem]/new:hidden">{c.preview}</div>
              <div
                data-toast-avoid=""
                className={cx(
                  'sticky bottom-[calc(var(--bh-tabbar-h)+var(--bh-safe-bottom))] z-20 -mx-4 flex max-w-[640px] items-center gap-2 border-t border-line bg-bg px-4 py-3 medium:-mx-6 medium:px-6',
                  'expanded:bottom-0 expanded:mx-0 expanded:px-0',
                )}
              >
                <div className="min-w-0 flex-1">
                  {c.blocker && (
                    <p className="type-meta text-stop-text" role="alert">
                      {c.blocker}
                    </p>
                  )}
                </div>
                <Button
                  variant="primary"
                  isPending={c.pending}
                  icon={c.submitIcon}
                  onPress={() => void c.submit()}
                >
                  {c.submitLabel}
                </Button>
              </div>
            </div>
            <aside
              aria-label={t('agents.new.previewLabel')}
              className="hidden self-start @min-[50rem]/new:sticky @min-[50rem]/new:top-4 @min-[50rem]/new:block"
            >
              {c.preview}
            </aside>
          </div>
        </div>
      )}
    </Screen>
  );
};
