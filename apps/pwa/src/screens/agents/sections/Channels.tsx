/**
 * Channels: memberships with default role + trigger chips (§6A.4), join sheet, cross-channel routes
 * (allowlist, beam lines, two selects — no drag), people (per-agent grants), mesh guardrails (trust
 * lists, turn/hop caps, per-peer budget) and public access. All edits go through the draft + SaveBar.
 */
import type { AgentView, Membership, Trigger } from '@beamhop/core';
import { LockSimple, Plus, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { PROVIDER_NAMES, providerMonogram, targetLabel, useApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { middleTruncate, tokens } from '../../../lib/format.ts';
import { Button, IconButton, TextLink } from '../../../ui/Button.tsx';
import { ChipInput } from '../../../ui/Chip.tsx';
import { Checkbox, SegmentedControl, Select, Switch } from '../../../ui/Choice.tsx';
import { NumberField, TextField } from '../../../ui/Field.tsx';
import { LetterTile, MetaLine } from '../../../ui/Meta.tsx';
import { Sheet } from '../../../ui/Sheet.tsx';
import { RouteLine, SignalBars } from '../../../ui/Status.tsx';
import { validatePrincipal } from '../model.ts';
import { Block, Rows, SaveBar, useAgentDraft } from '../parts.tsx';

const TRIGGERS: Trigger[] = ['dm', 'mention', 'reply', 'command', 'all'];
const TARGET = /^[a-z0-9][a-z0-9-]*:(dm|group|channel|thread|public)(\/.+)?$/;

const useRoles = () => {
  const roles = useApi('role.list');
  const names = (roles.data?.roles.map((r) => r.name) ?? ['admin', 'user', 'viewer', 'agent']).filter(
    (r) => r !== 'owner',
  );
  return { names, grants: roles.data?.grants ?? {} };
};

const MembershipRow = ({
  m,
  label,
  provider,
  roles,
  onChange,
  onLeave,
}: {
  m: Membership;
  label: string;
  provider?: string;
  roles: string[];
  onChange: (m: Membership) => void;
  onLeave: () => void;
}) => {
  const toggle = (tr: Trigger, on: boolean) =>
    onChange({ ...m, triggers: on ? [...m.triggers, tr] : m.triggers.filter((x) => x !== tr) });
  return (
    <li className="relative flex flex-col gap-3 px-4 py-3">
      {m.revokedAt && (
        <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-3" />
      )}
      <div className="relative flex items-center gap-3">
        <LetterTile code={providerMonogram(provider ?? m.target.split(':')[0]!)} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[14px] text-ink" title={m.target}>
            {label}
          </span>
          <span className="type-meta text-ink-2">
            {provider ? (PROVIDER_NAMES[provider] ?? provider) : m.target}
          </span>
        </span>
        <IconButton
          label={t('agents.ch.leave', { target: label })}
          icon={<X size={18} />}
          onPress={onLeave}
        />
      </div>
      {m.revokedAt ? (
        <p className="relative type-body-sm text-ink-2">{t('agents.ch.revoked')}</p>
      ) : (
        <>
          <Select
            label={t('agents.ch.defaultRole')}
            selectedKey={m.defaultRole}
            onSelectionChange={(k) => k && onChange({ ...m, defaultRole: String(k) })}
            options={roles.map((r) => ({ id: r, label: r }))}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="type-label text-ink">{t('agents.ch.triggers')}</legend>
            <div className="flex flex-wrap gap-x-4">
              {TRIGGERS.map((tr) => (
                <Checkbox key={tr} isSelected={m.triggers.includes(tr)} onChange={(v) => toggle(tr, v)}>
                  {t(`agents.trigger.${tr}` as 'agents.trigger.dm')}
                </Checkbox>
              ))}
            </div>
            {m.triggers.includes('all') && (
              <p className="type-meta text-caution-text">{t('agents.ch.allWarn')}</p>
            )}
            {m.triggers.length === 0 && (
              <p className="type-meta text-caution-text">{t('agents.ch.noTriggers')}</p>
            )}
          </fieldset>
        </>
      )}
    </li>
  );
};

const JoinSheet = ({
  open,
  onOpenChange,
  existing,
  roles,
  onJoin,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existing: string[];
  roles: string[];
  onJoin: (m: Membership) => void;
}) => {
  const channels = useApi('channel.list');
  const list = channels.data?.channels ?? [];
  const [channel, setChannel] = useState('');
  const [kind, setKind] = useState<'dm' | 'group' | 'channel'>('dm');
  const [id, setId] = useState('');
  const [role, setRole] = useState('viewer');
  const ch = list.find((c) => c.config.name === (channel || list[0]?.config.name));
  const target = ch ? `${ch.config.name}:${kind}${kind === 'dm' ? '' : `/${id.trim()}`}` : '';
  const err = !ch
    ? undefined
    : kind !== 'dm' && !id.trim()
      ? t('agents.ch.needId')
      : !TARGET.test(target)
        ? t('agents.ch.badTarget')
        : existing.includes(target)
          ? t('agents.ch.already', { target })
          : undefined;
  return (
    <Sheet
      isOpen={open}
      onOpenChange={onOpenChange}
      title={t('agents.ch.joinTitle')}
      footer={
        <Button
          variant="primary"
          size="lg"
          fullWidth
          isDisabled={!ch || !!err}
          onPress={() => {
            onJoin({
              target,
              defaultRole: role,
              triggers: kind === 'dm' ? ['dm'] : ['mention', 'reply'],
            });
            setId('');
            onOpenChange(false);
          }}
        >
          {t('agents.ch.joinConfirm')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {list.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('agents.ch.noChannels')}</p>
        ) : (
          <>
            <Select
              label={t('agents.ch.channel')}
              selectedKey={ch?.config.name ?? null}
              onSelectionChange={(k) => k && setChannel(String(k))}
              options={list.map((c) => ({
                id: c.config.name,
                label: `${c.config.name} · ${PROVIDER_NAMES[c.config.provider] ?? c.config.provider}`,
                description: c.self?.handle ?? c.status,
                leading: <LetterTile code={providerMonogram(c.config.provider)} />,
                isDisabled: c.status === 'disabled',
              }))}
            />
            <div className="flex flex-col gap-1.5">
              <span className="type-label text-ink">{t('agents.ch.where')}</span>
              <SegmentedControl
                label={t('agents.ch.where')}
                value={kind}
                onChange={setKind}
                options={[
                  { id: 'dm', label: t('agents.ch.kindDm') },
                  { id: 'group', label: t('agents.ch.kindGroup') },
                  { id: 'channel', label: t('agents.ch.kindChannel') },
                ]}
              />
            </div>
            {kind !== 'dm' && (
              <TextField
                label={t('agents.ch.id')}
                value={id}
                onChange={setId}
                mono
                placeholder={ch?.config.provider === 'telegram' ? '-100123' : 'C0123'}
                description={t('agents.ch.idHint')}
              />
            )}
            <Select
              label={t('agents.ch.defaultRole')}
              selectedKey={role}
              onSelectionChange={(k) => k && setRole(String(k))}
              options={roles.map((r) => ({ id: r, label: r }))}
              description={t('agents.ch.roleHint')}
            />
            {target && (
              <div className="rounded-md bg-sunken px-3 py-2.5">
                <RouteLine
                  nodes={[
                    { label: target, kind: 'channel' },
                    { label: t('agents.ch.thisAgent'), kind: 'agent' },
                  ]}
                />
                {err && <p className="mt-1 type-meta text-stop-text">{err}</p>}
              </div>
            )}
          </>
        )}
        <p className="type-body-sm text-ink-2">
          {t('agents.ch.notConnected')} <TextLink href="/channels/add">{t('agents.ch.addChannel')}</TextLink>
        </p>
      </div>
    </Sheet>
  );
};

const parsePeer = (raw: string): { value: string } | { error: string } => {
  const s = raw.trim();
  if (/^npub1[02-9ac-hj-np-z]{20,}$/.test(s)) return { value: s };
  if (!validatePrincipal(s)) return { value: s };
  return { error: t('agents.mesh.badPeer') };
};

export const ChannelsSection = ({ agent }: { agent: AgentView }) => {
  const d = useAgentDraft(agent);
  const c = d.draft;
  const name = c.name;
  const channels = useApi('channel.list');
  const status = useApi('system.status');
  const agents = useApi('agent.list');
  const { names: roles } = useRoles();
  const [joinOpen, setJoinOpen] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [principal, setPrincipal] = useState('');
  const [grantRole, setGrantRole] = useState('user');
  const [grantErr, setGrantErr] = useState<string>();
  const label = (target: string) => targetLabel(target, channels.data?.channels);
  const providerOf = (target: string) =>
    channels.data?.channels.find((x) => x.config.name === target.split(':')[0])?.config.provider ??
    (target.startsWith('nostr:') ? 'nostr' : undefined);
  const targets = c.memberships.filter((m) => !m.revokedAt).map((m) => m.target);
  const allTargets = [
    ...new Set([
      ...targets,
      ...(agents.data?.agents ?? []).flatMap((a) => a.config.memberships.map((m) => m.target)),
      ...c.routes.map((r) => r.to),
    ]),
  ];
  const routeErr =
    from && to && from === to
      ? t('agents.routes.same')
      : from && to && c.routes.some((r) => r.from === from && r.to === to)
        ? t('agents.routes.exists')
        : undefined;
  const ownerNpub = status.data?.owner.npub;

  return (
    <div className="flex flex-col gap-10">
      <Block
        id="ch-members"
        title={t('agents.ch.title', { count: c.memberships.length })}
        description={t('agents.ch.hint', { name })}
        cli={`beamhop join ${name} ${c.memberships[0]?.target ?? 'nostr:dm'} --role ${c.memberships[0]?.defaultRole ?? 'viewer'}`}
      >
        {c.memberships.length > 0 ? (
          <Rows label={t('agents.ch.listLabel')}>
            {c.memberships.map((m, i) => (
              <MembershipRow
                key={m.target}
                m={m}
                label={label(m.target)}
                provider={providerOf(m.target)}
                roles={roles}
                onChange={(nm) =>
                  d.set((x) => ({ ...x, memberships: x.memberships.map((y, j) => (j === i ? nm : y)) }))
                }
                onLeave={() => d.set((x) => ({ ...x, memberships: x.memberships.filter((_, j) => j !== i) }))}
              />
            ))}
          </Rows>
        ) : (
          <p className="type-body-sm text-ink-2">{t('agents.ch.none', { name })}</p>
        )}
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus size={16} weight="bold" aria-hidden="true" />}
          onPress={() => setJoinOpen(true)}
        >
          {t('agents.ch.join')}
        </Button>
      </Block>

      <Block
        id="ch-routes"
        title={t('agents.routes.title', { count: c.routes.length })}
        description={t('agents.routes.hint', { name })}
        cli={`beamhop agent set ${name} 'routes=[{"from":"${c.routes[0]?.from ?? 'nostr:dm'}","to":"${c.routes[0]?.to ?? 'acme:channel/C0DEPLOYS'}"}]'`}
      >
        {c.routes.length > 0 && (
          <Rows label={t('agents.routes.listLabel')}>
            {c.routes.map((r, i) => (
              <li key={`${r.from}>${r.to}`} className="flex items-center gap-2 py-1.5 pr-1 pl-4">
                <RouteLine
                  className="min-w-0 flex-1"
                  aria-label={`${label(r.from)} through ${name} to ${label(r.to)}`}
                  nodes={[
                    { label: label(r.from), kind: 'channel' },
                    { label: label(r.to), kind: 'channel' },
                  ]}
                />
                <IconButton
                  label={t('agents.routes.remove', { from: label(r.from), to: label(r.to) })}
                  icon={<X size={18} />}
                  onPress={() => d.set((x) => ({ ...x, routes: x.routes.filter((_, j) => j !== i) }))}
                />
              </li>
            ))}
          </Rows>
        )}
        {targets.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('agents.routes.needMembership')}</p>
        ) : (
          <div className="grid gap-3 rounded-lg border border-line bg-surface p-4 medium:grid-cols-2">
            <Select
              label={t('agents.routes.from')}
              selectedKey={from}
              onSelectionChange={(k) => setFrom(k ? String(k) : null)}
              placeholder={t('agents.routes.pick')}
              options={targets.map((x) => ({ id: x, label: label(x) }))}
            />
            <Select
              label={t('agents.routes.to')}
              selectedKey={to}
              onSelectionChange={(k) => setTo(k ? String(k) : null)}
              placeholder={t('agents.routes.pick')}
              options={allTargets.map((x) => ({ id: x, label: label(x) }))}
            />
            {routeErr && <p className="type-meta text-stop-text medium:col-span-2">{routeErr}</p>}
            <Button
              variant="secondary"
              className="self-start medium:col-span-2"
              isDisabled={!from || !to || !!routeErr}
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
              onPress={() => {
                if (!from || !to) return;
                d.set((x) => ({ ...x, routes: [...x.routes, { from, to }] }));
                setFrom(null);
                setTo(null);
              }}
            >
              {t('agents.routes.add')}
            </Button>
          </div>
        )}
      </Block>

      <Block
        id="ch-people"
        title={t('agents.people.title', { count: Object.keys(c.grants).length + 1 })}
        description={t('agents.people.hint', { name })}
        cli={`beamhop role grant ${Object.keys(c.grants)[0] ?? 'telegram:5551234'} user --agent ${name}`}
      >
        <Rows label={t('agents.people.listLabel')}>
          <li className="relative flex min-h-14 items-center gap-3 overflow-hidden px-4 py-2">
            <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-3" />
            <LockSimple size={16} weight="bold" aria-hidden="true" className="relative shrink-0 text-ink-2" />
            <span className="relative flex min-w-0 flex-1 flex-col">
              <span className="truncate type-meta text-ink" title={ownerNpub}>
                {ownerNpub ? `nostr:${middleTruncate(ownerNpub, 18)}` : t('agents.you')}
              </span>
              <span className="type-meta text-ink-2">{t('agents.people.ownerNote')}</span>
            </span>
            <span className="relative type-label text-ink">owner</span>
          </li>
          {Object.entries(c.grants).map(([p, r]) => (
            <li key={p} className="flex flex-col gap-2 px-4 py-3 medium:flex-row medium:items-center">
              <span className="min-w-0 flex-1 truncate type-meta text-ink" title={p}>
                {middleTruncate(p, 34)}
              </span>
              <div className="flex items-end gap-1">
                <Select
                  label={t('agents.people.roleFor', { who: p })}
                  hideLabel
                  className="w-40"
                  selectedKey={r}
                  onSelectionChange={(k) =>
                    k && d.set((x) => ({ ...x, grants: { ...x.grants, [p]: String(k) } }))
                  }
                  options={roles.map((x) => ({ id: x, label: x }))}
                />
                <IconButton
                  label={t('agents.people.revoke', { who: p })}
                  icon={<X size={18} />}
                  onPress={() =>
                    d.set((x) => {
                      const { [p]: _, ...rest } = x.grants;
                      return { ...x, grants: rest };
                    })
                  }
                />
              </div>
            </li>
          ))}
        </Rows>
        <form
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const p = principal.trim();
            const err =
              validatePrincipal(p) ?? (p in c.grants ? t('agents.people.already', { who: p }) : undefined);
            if (err) return setGrantErr(err);
            d.set((x) => ({ ...x, grants: { ...x.grants, [p]: grantRole } }));
            setPrincipal('');
            setGrantErr(undefined);
          }}
        >
          <TextField
            label={t('agents.people.who')}
            value={principal}
            onChange={(v) => {
              setPrincipal(v);
              setGrantErr(undefined);
            }}
            mono
            placeholder="telegram:5551234"
            isInvalid={!!grantErr}
            errorMessage={grantErr}
            description={t('agents.people.whoHint')}
          />
          <div className="flex items-end gap-2">
            <Select
              label={t('agents.people.role')}
              className="w-40"
              selectedKey={grantRole}
              onSelectionChange={(k) => k && setGrantRole(String(k))}
              options={roles.map((x) => ({ id: x, label: x }))}
            />
            <Button
              type="submit"
              variant="secondary"
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
            >
              {t('agents.people.add')}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        id="ch-mesh"
        title={t('agents.mesh.title')}
        description={t('agents.mesh.hint', { name })}
        cli={`beamhop agent set ${name} --mesh-max-turns ${c.mesh.maxTurnsPerThread} --mesh-max-hops ${c.mesh.maxHops}`}
      >
        <ChipInput
          label={t('agents.mesh.allow', { count: c.mesh.allow.length })}
          inputLabel={t('agents.mesh.addAllow')}
          placeholder={t('agents.mesh.placeholder')}
          items={c.mesh.allow.map((p) => ({
            id: p,
            label: middleTruncate(p, 24),
            variant: 'allowed' as const,
          }))}
          emptyText={t('agents.mesh.allowNone')}
          parse={parsePeer}
          onAdd={(v) => d.set((x) => ({ ...x, mesh: { ...x.mesh, allow: [...x.mesh.allow, v] } }))}
          onRemove={(id) =>
            d.set((x) => ({ ...x, mesh: { ...x.mesh, allow: x.mesh.allow.filter((p) => p !== id) } }))
          }
        />
        <ChipInput
          label={t('agents.mesh.block', { count: c.mesh.block.length })}
          inputLabel={t('agents.mesh.addBlock')}
          placeholder={t('agents.mesh.placeholder')}
          items={c.mesh.block.map((p) => ({
            id: p,
            label: middleTruncate(p, 24),
            variant: 'blocked' as const,
          }))}
          emptyText={t('agents.mesh.blockNone')}
          parse={parsePeer}
          onAdd={(v) => d.set((x) => ({ ...x, mesh: { ...x.mesh, block: [...x.mesh.block, v] } }))}
          onRemove={(id) =>
            d.set((x) => ({ ...x, mesh: { ...x.mesh, block: x.mesh.block.filter((p) => p !== id) } }))
          }
        />
        <div className="grid gap-5 medium:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <NumberField
              label={t('agents.mesh.turns')}
              value={c.mesh.maxTurnsPerThread}
              minValue={1}
              maxValue={50}
              onChange={(v) =>
                !Number.isNaN(v) && d.set((x) => ({ ...x, mesh: { ...x.mesh, maxTurnsPerThread: v } }))
              }
              description={t('agents.mesh.turnsHint')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <NumberField
              label={t('agents.mesh.hops')}
              value={c.mesh.maxHops}
              minValue={1}
              maxValue={10}
              onChange={(v) => !Number.isNaN(v) && d.set((x) => ({ ...x, mesh: { ...x.mesh, maxHops: v } }))}
            />
            <SignalBars
              up={Math.min(c.mesh.maxHops, 5)}
              total={5}
              unit={t('agents.mesh.hopsUnit', { count: c.mesh.maxHops })}
              hideNumber={false}
            />
          </div>
          <NumberField
            label={t('agents.mesh.peerBudget')}
            value={c.mesh.perPeerBudget.dailyTokens ?? 0}
            minValue={0}
            step={10_000}
            unit={t('agents.mesh.tokensDay')}
            onChange={(v) =>
              !Number.isNaN(v) &&
              d.set((x) => ({
                ...x,
                mesh: { ...x.mesh, perPeerBudget: { ...x.mesh.perPeerBudget, dailyTokens: v } },
              }))
            }
            description={t('agents.mesh.peerBudgetHint', {
              amount: tokens(c.mesh.perPeerBudget.dailyTokens ?? 0),
            })}
          />
        </div>
      </Block>

      <Block id="ch-public" title={t('agents.public.title')}>
        <Switch
          isSelected={c.public}
          onChange={(v) => d.set((x) => ({ ...x, public: v }))}
          description={t('agents.public.hint')}
        >
          {t('agents.public.label')}
        </Switch>
        {c.public && (
          <MetaLine
            items={[{ value: t('agents.public.on', { name }), tone: 'caution' }]}
            className="whitespace-normal"
          />
        )}
      </Block>

      <JoinSheet
        open={joinOpen}
        onOpenChange={setJoinOpen}
        existing={c.memberships.map((m) => m.target)}
        roles={roles}
        onJoin={(m) => d.set((x) => ({ ...x, memberships: [...x.memberships, m] }))}
      />
      <SaveBar agent={agent} d={d} />
    </div>
  );
};
