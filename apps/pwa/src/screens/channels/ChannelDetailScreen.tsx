/**
 * Channel detail — SCREENS §5 "Channel detail". Route: /channels/$id (`?replace=1` opens Replace token).
 * Status + transport, the bot's identity, owner pairings (pair another account in a sheet: same deep
 * link / QR / code panel as the wizard), memberships (which agents answer where; Leave with Undo),
 * Nostr relay list with per-relay latency + NIP-11 status, Replace token (re-validates, keeps
 * everything else, JOURNEYS §4 edge cases), Remove channel (destructive confirm naming consequences).
 */
import type { ChannelView, Membership } from '@beamhop/core';
import { ArrowsClockwise, CellTower, Key, LockSimple, Plus, Trash, UserPlus } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  harnessMonogram,
  providerMonogram,
  targetLabel,
  useApi,
  useCall,
  useConnection,
  useMutationApi,
} from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { ago, when } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button, LinkButton } from '../../ui/Button.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { SecretField } from '../../ui/Field.tsx';
import { Badge, Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { SignalBars, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { agentsOn, channelLampWithPanic, channelTitle } from './ChannelsScreen.tsx';
import { PairPanel } from './PairPanel.tsx';
import { Facts, IdentityCard, WaitingLine } from './parts.tsx';
import { channelPairings, providerMeta, transportOf } from './providers.ts';

const Section = ({
  id,
  title,
  count,
  action,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-1">
    <Eyebrow id={id} count={count} action={action}>
      {title}
    </Eyebrow>
    {children}
  </section>
);

// ─────────── Replace token ───────────

const ReplaceTokenSheet = ({
  c,
  isOpen,
  onOpenChange,
}: {
  c: ChannelView;
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const meta = providerMeta(c.config.provider);
  const call = useCall();
  const toast = useToast();
  const refs = c.config.secretRefs;
  const specs = meta.secrets.filter((s) => refs.some((r) => r.endsWith(`/${s.key}`)));
  const fields = specs.length
    ? specs
    : refs.map((r) => ({
        key: r.split('/').pop() ?? r,
        label: r.split('/').pop() ?? r,
        format: /.+/,
        formatLabel: '',
        shape: '',
      }));
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<{ phase: 'idle' | 'checking' | 'bad' | 'saving'; message?: string }>({
    phase: 'idle',
  });
  const ready = fields.every((f) => f.format.test((values[f.key] ?? '').trim()));
  const save = async () => {
    setState({ phase: 'checking' });
    try {
      const secrets = Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()]));
      const r = await call('channel.validate', {
        provider: c.config.provider,
        values: c.config.settings,
        secrets,
      });
      if (!r.ok) {
        haptic('error');
        setState({ phase: 'bad', message: r.message });
        return;
      }
      setState({ phase: 'saving' });
      for (const f of fields) {
        const ref = refs.find((x) => x.endsWith(`/${f.key}`)) ?? `channel/${c.config.name}/${f.key}`;
        await call('secret.set', { name: ref, value: secrets[f.key]! });
      }
      haptic('confirm');
      toast.show({ message: t('channels.detail.replaced', { name: channelTitle(c) }), tone: 'success' });
      setValues({});
      setState({ phase: 'idle' });
      onOpenChange(false);
    } catch (e) {
      setState({ phase: 'bad', message: (e as Error).message });
    }
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('channels.detail.replaceTitle')}
      subtitle={<MetaLine items={[c.config.name, meta.name, ...refs]} />}
      footer={
        <Button
          variant="primary"
          size="lg"
          fullWidth
          isDisabled={!ready}
          isPending={state.phase === 'checking' || state.phase === 'saving'}
          onPress={() => void save()}
        >
          {t('channels.detail.replaceSave')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body-sm text-ink-2">{t('channels.detail.replaceBody')}</p>
        {fields.map((f) => (
          <SecretField
            key={f.key}
            label={f.label}
            format={f.format}
            formatLabel={f.formatLabel}
            value={values[f.key] ?? ''}
            onChange={(v) => {
              setValues((x) => ({ ...x, [f.key]: v }));
              if (state.phase === 'bad') setState({ phase: 'idle' });
            }}
          />
        ))}
        {state.phase === 'checking' && (
          <WaitingLine>{t('channels.cred.validating', { provider: meta.name })}</WaitingLine>
        )}
        {state.phase === 'bad' && (
          <p
            role="alert"
            className="rounded-md border-l-[3px] border-stop-text bg-stop-wash px-3 py-2 type-body-sm text-ink"
          >
            {state.message}
          </p>
        )}
      </div>
    </Sheet>
  );
};

// ─────────── Screen ───────────

export const ChannelDetailScreen = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  const search = useSearch({ strict: false }) as { replace?: unknown };
  const navigate = useNavigate();
  const call = useCall();
  const toast = useToast();
  const conn = useConnection();
  const offline = !conn.online || conn.status === 'closed';
  const { panic } = usePanicState();
  const q = useApi('channel.list');
  const agents = useApi('agent.list');
  const harnesses = useApi('harness.list');
  const showSkeleton = useDelayedLoading(q.isPending);
  const [pairOpen, setPairOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removeChannel = useMutationApi('channel.remove');
  const c = q.data?.channels.find((x) => x.config.name === id);
  const replaceOpen = !!search.replace;
  const setReplace = (open: boolean) =>
    void navigate({ to: '/channels/$id', params: { id }, search: open ? { replace: 1 } : {}, replace: true });

  const frame = (title: string, body: React.ReactNode) => (
    <Screen
      title={title}
      back={{ href: '/channels', label: t('nav.channels') }}
      pane="detail"
      crumbs={[{ label: t('nav.channels'), href: '/channels' }, { label: title }]}
    >
      {body}
    </Screen>
  );

  if (q.isPending)
    return frame(
      id,
      showSkeleton ? <Skeleton variant="detail" count={3} label={t('channels.detail.loading')} /> : null,
    );
  if (q.error && !q.data)
    return frame(
      id,
      <ErrorState title={t('channels.list.error')} details={q.error} onRetry={() => void q.refetch()} />,
    );
  if (!c)
    return frame(
      id,
      <ErrorState
        title={t('channels.detail.notFound', { name: id })}
        actions={
          <LinkButton href="/channels" variant="secondary" size="sm">
            {t('channels.detail.backToList')}
          </LinkButton>
        }
      >
        {t('channels.detail.notFoundBody')}
      </ErrorState>,
    );

  const meta = providerMeta(c.config.provider);
  const title = channelTitle(c);
  const lamp = channelLampWithPanic(c, panic);
  const isNostr = c.config.provider === 'nostr';
  const members = agentsOn(c.config.name, agents.data?.agents).flatMap((a) =>
    a.config.memberships
      .filter((m) => !m.revokedAt && m.target.startsWith(`${c.config.name}:`))
      .map((m) => ({ agent: a, m })),
  );
  const pairings = channelPairings(c);
  const settings = c.config.settings;
  const relays = (settings.relays as string[] | undefined) ?? [];
  const up = new Set((settings.relaysUp as string[] | undefined) ?? relays);
  const latency = (settings.latencyMs as Record<string, number> | undefined) ?? {};
  const nip11 = (settings.nip11 as Record<string, string> | undefined) ?? {};
  const blossom = (settings.blossom as string[] | undefined) ?? [];

  const leave = async (agent: string, m: Membership) => {
    try {
      await call('membership.leave', { agent, target: m.target });
      toast.show({
        message: t('channels.detail.left', { agent, target: targetLabel(m.target, q.data?.channels) }),
        onUndo: async () => {
          await call('membership.join', { agent, membership: m });
        },
      });
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await removeChannel.mutateAsync({ name: c.config.name });
      haptic('reject');
      toast.show({ message: t('channels.detail.removed', { name: title }) });
      setRemoveOpen(false);
      void navigate({ to: '/channels' });
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Screen
      title={title}
      back={{ href: '/channels', label: t('nav.channels') }}
      pane="detail"
      crumbs={[{ label: t('nav.channels'), href: '/channels' }, { label: c.config.name }]}
      slug={
        <MetaLine
          items={[
            c.config.name,
            meta.name,
            transportOf(c),
            t('channels.detail.since', { when: when(c.config.createdAt) }),
          ]}
        />
      }
      titleAside={<StatusDot state={lamp} />}
    >
      <div className="flex flex-col gap-8 pt-2">
        {/* Status */}
        {c.status === 'error' ? (
          <ErrorState
            title={t('channels.detail.errorTitle', { reason: c.error ?? t('channels.list.errorWord') })}
            details={{ channel: c.config.name, status: c.status, error: c.error }}
            actions={
              c.config.secretRefs.length > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Key size={16} aria-hidden="true" />}
                  onPress={() => setReplace(true)}
                  isDisabled={offline}
                >
                  {t('channels.list.replace')}
                </Button>
              )
            }
          >
            {t(
              `channels.detail.errorBody.${c.config.provider === 'telegram' ? 'telegram' : c.config.provider === 'slack' ? 'slack' : 'other'}`,
            )}
          </ErrorState>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <StatusDot
                state={lamp}
                label={c.status === 'connected' ? t('channels.detail.connected') : undefined}
              />
              {isNostr && relays.length > 0 && (
                <SignalBars
                  up={c.status === 'connected' ? up.size : 0}
                  total={relays.length}
                  unit="relays"
                  limit={up.size < relays.length}
                />
              )}
              <span className="type-meta text-ink-2">{transportOf(c)}</span>
            </div>
            {c.config.secretRefs.length > 0 && (
              <p className="flex items-center gap-2 type-meta text-go-text">
                <LockSimple size={14} weight="bold" aria-hidden="true" />
                {t('channels.detail.keychain', { count: c.config.secretRefs.length })}
              </p>
            )}
          </div>
        )}

        {/* Identity */}
        {c.self && (
          <Section id="ch-identity" title={t('channels.detail.identity')}>
            <IdentityCard
              name={c.self.displayName}
              handle={c.self.handle}
              provider={meta.name}
              tone={c.status === 'error' ? 'caution' : 'go'}
            />
            <div className="mt-2 flex min-w-0 items-center gap-1 rounded-md bg-sunken pl-3">
              <MetaLine items={[{ value: c.self.principal, truncate: 36 }]} className="flex-1 py-2" />
              <CopyButton value={c.self.principal} label={t('channels.detail.copyPrincipal')} compact />
            </div>
          </Section>
        )}

        {/* Nostr relays */}
        {isNostr && (
          <Section id="ch-relays" title={t('channels.detail.relays')} count={relays.length}>
            <ul className="overflow-hidden rounded-lg border border-line bg-surface">
              {relays.map((r) => {
                const isUp = c.status === 'connected' && up.has(r);
                const check = nip11[r];
                return (
                  <li
                    key={r}
                    className="flex min-h-14 items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                  >
                    <CellTower size={18} className="shrink-0 text-ink-2" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-[14px] text-ink">
                        {r.replace('wss://', '')}
                      </span>
                      <MetaLine
                        items={[
                          isUp && latency[r] !== undefined
                            ? `${latency[r]} ms`
                            : isUp
                              ? t('channels.detail.relayUp')
                              : t('channels.detail.relayDown'),
                          check === 'ok'
                            ? { value: 'NIP-11 ✓', tone: 'go' }
                            : check
                              ? { value: `NIP-11 ${check}`, tone: 'caution' }
                              : undefined,
                        ]}
                      />
                    </span>
                    <StatusDot
                      state={isUp ? 'ready' : 'offline'}
                      label={isUp ? t('channels.detail.relayUpWord') : t('channels.detail.relayDownWord')}
                    />
                  </li>
                );
              })}
            </ul>
            {blossom.length > 0 && (
              <MetaLine
                className="mt-2"
                items={[t('channels.detail.blossom'), ...blossom.map((b) => b.replace('https://', ''))]}
              />
            )}
          </Section>
        )}

        {/* Owner pairings */}
        {!isNostr && (
          <Section
            id="ch-owners"
            title={t('channels.detail.owners')}
            count={pairings.length}
            action={
              <Button
                variant="quiet"
                size="sm"
                icon={<UserPlus size={16} aria-hidden="true" />}
                onPress={() => setPairOpen(true)}
                isDisabled={c.status !== 'connected' || offline}
              >
                {t('channels.detail.pair')}
              </Button>
            }
          >
            {pairings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 type-body-sm text-ink-2">
                {t('channels.detail.noOwners', { provider: meta.name })}
              </p>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-line bg-surface">
                {pairings.map((p) => (
                  <li
                    key={p.principal}
                    className="flex min-h-14 items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                  >
                    <LetterTile code={providerMonogram(c.config.provider)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate type-body-strong text-ink">{p.handle ?? p.displayName}</span>
                      <MetaLine
                        items={[p.principal, t('channels.detail.pairedAgo', { when: ago(p.pairedAt) })]}
                      />
                    </span>
                    <Badge tone="outline">{p.role ?? 'owner'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {/* Memberships */}
        <Section
          id="ch-members"
          title={t('channels.detail.members')}
          count={members.length}
          action={
            <LinkButton href="/agents" variant="quiet" size="sm" icon={<Plus size={16} aria-hidden="true" />}>
              {t('channels.detail.addAgent')}
            </LinkButton>
          }
        >
          {members.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 type-body-sm text-ink-2">
              {t('channels.detail.noMembers')}
            </p>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-line bg-surface">
              {members.map(({ agent, m }) => (
                <li
                  key={`${agent.config.name}-${m.target}`}
                  className="flex min-h-14 items-center gap-3 border-b border-line py-2 pr-2 pl-4 last:border-b-0"
                >
                  <LetterTile code={harnessMonogram(agent.config.harness)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate type-body-strong text-ink">{agent.config.name}</span>
                    <MetaLine
                      items={[targetLabel(m.target, q.data?.channels), m.defaultRole, m.triggers.join(' + ')]}
                    />
                  </span>
                  <Button
                    variant="quiet"
                    size="sm"
                    onPress={() => void leave(agent.config.name, m)}
                    isDisabled={offline}
                    aria-label={t('channels.detail.leaveLabel', {
                      agent: agent.config.name,
                      target: m.target,
                    })}
                  >
                    {t('channels.detail.leave')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Details */}
        <Section id="ch-facts" title={t('channels.detail.details')}>
          <Facts
            rows={[
              [
                t('channels.detail.fName'),
                <span className="font-mono text-[13px]" key="n">
                  {c.config.name}
                </span>,
              ],
              [t('channels.detail.fProvider'), meta.name],
              [t('channels.detail.fTransport'), transportOf(c)],
              [t('channels.detail.fAdded'), when(c.config.createdAt)],
              ...(c.config.secretRefs.length
                ? ([
                    [
                      t('channels.detail.fSecrets'),
                      <span className="font-mono text-[13px]" key="s">
                        {c.config.secretRefs.join(', ')}
                      </span>,
                    ],
                  ] as Array<[string, React.ReactNode]>)
                : []),
              ...(harnesses.data && members.length
                ? ([
                    [
                      t('channels.detail.fHarnesses'),
                      [...new Set(members.map((x) => x.agent.config.harness))].join(', '),
                    ],
                  ] as Array<[string, React.ReactNode]>)
                : []),
            ]}
          />
        </Section>

        {/* Danger zone */}
        <section aria-labelledby="ch-danger" className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id="ch-danger" className="sr-only">
            {t('channels.detail.danger')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {c.status !== 'error' && c.config.secretRefs.length > 0 && (
              <Button
                variant="secondary"
                icon={<ArrowsClockwise size={18} aria-hidden="true" />}
                onPress={() => setReplace(true)}
                isDisabled={offline}
              >
                {t('channels.list.replace')}
              </Button>
            )}
            <Button
              variant="destructive-outline"
              icon={<Trash size={18} aria-hidden="true" />}
              onPress={() => setRemoveOpen(true)}
              isDisabled={offline}
            >
              {t('channels.detail.remove')}
            </Button>
          </div>
        </section>

        <CliStrip command={`beamhop channel show ${c.config.name}`} />
      </div>

      <ReplaceTokenSheet c={c} isOpen={replaceOpen} onOpenChange={setReplace} />
      <Sheet
        isOpen={pairOpen}
        onOpenChange={setPairOpen}
        title={t('channels.detail.pairTitle', { provider: meta.name })}
        subtitle={<MetaLine items={[title, c.config.name]} />}
      >
        {pairOpen && (
          <PairPanel
            channel={c}
            onConfirmed={(p) => {
              setPairOpen(false);
              toast.show({
                message: t('channels.detail.pairedToast', { who: p.handle ?? p.displayName }),
                tone: 'success',
              });
            }}
          />
        )}
      </Sheet>
      <ConfirmDialog
        isOpen={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('channels.detail.removeTitle', { name: title })}
        confirmLabel={t('channels.detail.removeConfirm', { name: c.config.name })}
        isPending={removing}
        onConfirm={remove}
      >
        {t('channels.detail.removeBody', {
          count: new Set(members.map((x) => x.agent.config.name)).size,
          provider: meta.name,
        })}
      </ConfirmDialog>
    </Screen>
  );
};
