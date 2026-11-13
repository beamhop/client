/**
 * Deployment detail — SCREENS §8 "Deployment detail", JOURNEYS §7.7–8 and Destroy.
 * Status lamp + topology beam line (you ── relays ── agent@region), apply timeline on a tick rail while
 * provisioning (leaving is safe), facts (provider, region, size, $/mo, month-to-date), activity log
 * (audit for this agent), `Stop agent`, `Destroy…` → plan of deletions + type the agent name.
 */
import { ArrowSquareOut, Stop, Trash } from '@phosphor-icons/react';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { deployMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, shortDate, when } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useNow } from '../../lib/useNow.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button, LinkButton } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Eyebrow, LetterTile, MetaLine, Readout } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { RouteLine, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { confirmMatches, TypeToConfirm } from '../settings/kit.tsx';
import { deployLamp, monthToDate, PROVIDER_INFO, phaseState, usd } from './model.ts';
import { PlanDiff } from './PlanDiff.tsx';

const Fact = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 border-t border-line pt-2">
    <dt className="type-micro text-ink-2">{k}</dt>
    <dd className="type-meta text-ink">{v}</dd>
  </div>
);

export const DeploymentScreen = () => {
  const { deploymentId } = useParams({ strict: false }) as { deploymentId: string };
  const now = useNow(1000);
  const toast = useToast();
  const q = useApi('deploy.list', undefined, {
    refetchInterval: (query) =>
      query.state.data?.deployments.find((x) => x.id === deploymentId)?.status === 'provisioning'
        ? 1500
        : false,
  });
  const d = q.data?.deployments.find((x) => x.id === deploymentId);
  const agent = useApi('agent.get', { name: d?.agent ?? '' }, { enabled: !!d, retry: false });
  const log = useApi('audit.query', { agent: d?.agent, limit: 30 }, { enabled: !!d });
  const stop = useMutationApi('agent.stop');
  const destroy = useMutationApi('deploy.destroy');
  const [destroying, setDestroying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [typed, setTyped] = useState('');
  const showSkeleton = useDelayedLoading(q.isPending);

  const back = { href: '/deploy', label: 'Deploy' };
  if (q.isError)
    return (
      <Screen title="Deployment" back={back} pane="detail">
        <ErrorState title="Couldn't load this deployment." details={q.error} onRetry={() => void q.refetch()}>
          {q.error.message}
        </ErrorState>
      </Screen>
    );
  if (!d)
    return (
      <Screen title="Deployment" back={back} pane="detail">
        {q.isPending ? (
          showSkeleton ? (
            <Skeleton variant="detail" count={3} label="Loading deployment" />
          ) : null
        ) : (
          <EmptyState
            title="No deployment with that id."
            action={
              <LinkButton href="/deploy" variant="secondary">
                All deployments
              </LinkButton>
            }
          >
            It may have been destroyed and cleaned up, or the link is from another daemon.
          </EmptyState>
        )}
      </Screen>
    );

  const title = `${d.agent} @ ${d.provider}`;
  const lamp = deployLamp(d);
  const destroyed = d.status === 'destroyed';
  const phases = phaseState(d, now);
  const info = PROVIDER_INFO[d.provider];
  const running = agent.data && agent.data.status !== 'stopped';

  return (
    <Screen
      title={title}
      back={back}
      pane="detail"
      maxWidth="prose"
      crumbs={[{ label: 'Deploy', href: '/deploy' }, { label: title }]}
      slug={<MetaLine items={[d.region, d.size, `since ${shortDate(d.createdAt)}`, d.id]} />}
      titleAside={<StatusDot state={lamp} label={d.status} />}
    >
      <div className="flex flex-col gap-8">
        <section
          aria-labelledby="dep-route"
          className="relative flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          {destroyed && <span aria-hidden="true" className="hatch absolute inset-0 rounded-lg text-ink-3" />}
          <div className="relative flex items-center gap-3">
            <LetterTile code={deployMonogram(d.provider)} />
            <h2 id="dep-route" className="min-w-0 flex-1 truncate type-title-3 text-ink">
              {destroyed ? 'Destroyed' : d.status === 'provisioning' ? 'Setting up the server' : 'Route'}
            </h2>
            {d.monthlyCostUsd !== undefined && !destroyed && (
              <span className="type-meta text-ink">{usd(d.monthlyCostUsd)}/mo</span>
            )}
          </div>
          <RouteLine
            className="relative"
            nodes={[
              { label: 'you', kind: 'device' },
              { label: 'relays', kind: 'relay' },
              { label: `${d.agent}@${d.region ?? d.provider}`, kind: 'agent' },
            ]}
            live={d.status === 'provisioning'}
            state={d.status === 'error' ? 'broken' : 'ok'}
            reason={d.status === 'error' ? 'The server stopped answering heartbeats.' : undefined}
          />
          {info && !destroyed && <p className="relative type-body-sm text-ink-2">{info.sandboxNote}</p>}
        </section>

        {(d.status === 'provisioning' || d.status === 'error') && (
          <section aria-labelledby="dep-apply" className="flex flex-col gap-2">
            <Eyebrow id="dep-apply">Apply</Eyebrow>
            <ol className="tick-rail ml-1 flex flex-col pl-5" aria-live="polite">
              {phases.map((p) => (
                <li key={p.name} className="relative flex min-h-9 items-center gap-3">
                  <span className="absolute -left-[25px] grid size-[11px] place-items-center bg-bg">
                    <StatusDot
                      state={
                        p.state === 'done'
                          ? 'ready'
                          : p.state === 'live'
                            ? 'live'
                            : p.state === 'error'
                              ? 'error'
                              : 'stopped'
                      }
                      hideLabel
                      label={p.state === 'todo' ? 'waiting' : p.state}
                    />
                  </span>
                  <span className={cx('flex-1 type-body-sm', p.state === 'todo' ? 'text-ink-2' : 'text-ink')}>
                    {p.name}
                  </span>
                  <span className="type-meta text-ink-2 tabular-nums">
                    {p.state === 'done'
                      ? `${(p.ms! / 1000).toFixed(1)} s`
                      : p.state === 'live'
                        ? `${Math.floor(p.ms! / 1000)} s…`
                        : p.state === 'error'
                          ? 'failed'
                          : ''}
                  </span>
                </li>
              ))}
            </ol>
            <p className="type-body-sm text-ink-2">
              You can leave this screen. It runs on the daemon, and you'll get a notification when it's done.
            </p>
          </section>
        )}

        <section aria-labelledby="dep-facts">
          <Eyebrow id="dep-facts">Details</Eyebrow>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 medium:grid-cols-3">
            <Fact k="Provider" v={d.provider} />
            <Fact k="Region" v={d.region ?? '—'} />
            <Fact k="Size" v={d.size ?? '—'} />
            <Fact k="Estimate" v={d.monthlyCostUsd !== undefined ? `${usd(d.monthlyCostUsd)}/mo` : '—'} />
            <Fact
              k="Agent"
              v={agent.data ? `${agent.data.config.harness} · ${agent.data.status}` : d.agent}
            />
          </dl>
          {!destroyed && (
            <div className="mt-4 flex items-baseline gap-3">
              <span className="type-micro text-ink-2">Month to date</span>
              <Readout size="md">{usd(monthToDate(d, now))}</Readout>
            </div>
          )}
        </section>

        <section aria-labelledby="dep-log" className="flex flex-col gap-2">
          <Eyebrow id="dep-log" count={log.data?.events.length}>
            Activity
          </Eyebrow>
          {log.data?.events.length ? (
            <div
              role="log"
              aria-label={`Activity for ${d.agent}`}
              tabIndex={0}
              className="max-h-72 overflow-y-auto rounded-md bg-sunken py-2 outline-none focus-visible:outline-2 focus-visible:outline-focus"
            >
              <ol className="type-code">
                {log.data.events.map((e) => (
                  <li key={e.id} className="flex gap-3 px-3 py-0.5">
                    <time dateTime={e.at} className="shrink-0 text-ink-3">
                      {new Date(e.at).toDateString() === new Date(now).toDateString()
                        ? clock(e.at)
                        : when(e.at)}
                    </time>
                    <span
                      className={cx(
                        'min-w-0',
                        e.severity === 'security'
                          ? 'text-stop-text'
                          : e.severity === 'warn'
                            ? 'text-caution-text'
                            : 'text-ink',
                      )}
                    >
                      {e.summary}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="type-body-sm text-ink-2">No activity logged for {d.agent} yet.</p>
          )}
          <LinkButton
            href={`/audit?tab=log`}
            variant="quiet"
            size="sm"
            className="-ml-3 self-start"
            icon={<ArrowSquareOut size={16} aria-hidden="true" />}
          >
            Full audit log
          </LinkButton>
        </section>

        {!destroyed && (
          <section aria-labelledby="dep-actions" className="flex flex-col gap-3">
            <Eyebrow id="dep-actions">Actions</Eyebrow>
            <div className="flex flex-wrap gap-2">
              {running && (
                <Button
                  variant="secondary"
                  icon={<Stop size={16} weight="fill" aria-hidden="true" />}
                  onPress={() => setStopping(true)}
                >
                  Stop {d.agent}
                </Button>
              )}
              <Button
                variant="destructive-outline"
                icon={<Trash size={16} aria-hidden="true" />}
                onPress={() => setDestroying(true)}
              >
                Destroy…
              </Button>
            </div>
            <p className="type-body-sm text-ink-2">
              Any paired phone can see status and stop it. Creating or destroying servers needs the computer
              that holds the {d.provider} token.
            </p>
          </section>
        )}
        <CliStrip command={`beamhop deploy destroy ${d.id}`} />
      </div>

      <ConfirmDialog
        isOpen={stopping}
        onOpenChange={setStopping}
        title={`Stop ${d.agent}?`}
        confirmLabel={`Stop ${d.agent}`}
        isPending={stop.isPending}
        onConfirm={async () => {
          await stop.mutateAsync({ name: d.agent });
          setStopping(false);
          toast.show({
            message: `Stopped · ${d.agent}. The server keeps running and billing.`,
            tone: 'success',
          });
        }}
      >
        Its sessions end now. The server stays up (and billed) so you can start it again; Destroy removes it.
      </ConfirmDialog>

      <Sheet
        isOpen={destroying}
        onOpenChange={(o) => {
          setDestroying(o);
          if (!o) setTyped('');
        }}
        title={`Destroy ${d.agent} on ${d.provider}?`}
        subtitle={`${d.region ?? ''} · ${d.size ?? ''}`}
        isDismissable={false}
        role="alertdialog"
        focusTitle
        footer={
          <div className="flex flex-col gap-2 expanded:flex-row-reverse">
            <Button
              variant="destructive"
              size="lg"
              fullWidth
              isDisabled={!confirmMatches(typed, d.agent)}
              isPending={destroy.isPending}
              icon={<Trash size={18} weight="bold" aria-hidden="true" />}
              onPress={async () => {
                try {
                  await destroy.mutateAsync({ id: d.id });
                  haptic('warn');
                  announce(`${d.agent} on ${d.provider} destroyed.`);
                  toast.show({ message: `Destroyed · ${d.agent} on ${d.provider}`, tone: 'success' });
                  setDestroying(false);
                  setTyped('');
                } catch (e) {
                  toast.show({ message: (e as Error).message, tone: 'error' });
                }
              }}
            >
              Destroy {d.agent}
            </Button>
            <Button variant="secondary" size="lg" fullWidth onPress={() => setDestroying(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="type-body text-ink-2">
            This deletes the server and everything on it. It can't be undone.
            {d.monthlyCostUsd ? ` Billing stops: ${usd(d.monthlyCostUsd)}/mo.` : ''}
          </p>
          <PlanDiff
            label="Destroy plan"
            actions={[
              {
                op: 'destroy',
                resource: 'server',
                detail: `${d.provider} ${d.size ?? ''} · ${d.region ?? ''}`,
              },
              { op: 'delete', resource: 'firewall', detail: 'and its rules' },
              { op: 'delete', resource: 'disk', detail: 'worktrees and caches on the server' },
              {
                op: 'keep',
                resource: 'identity',
                detail: `${d.agent}'s key returns to this computer's vault`,
              },
              {
                op: 'keep',
                resource: 'transcripts',
                detail: 'already synced here, kept until retention ends',
              },
            ]}
          />
          <TypeToConfirm expected={d.agent} value={typed} onChange={setTyped} />
        </div>
      </Sheet>
    </Screen>
  );
};
