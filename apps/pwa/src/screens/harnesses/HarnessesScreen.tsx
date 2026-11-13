/**
 * Harnesses — SCREENS §6, JOURNEYS §1.02. Route: /harnesses.
 * Discovery results grouped by what you need to do: NEEDS YOU (login / update / error, each with the
 * exact command + copy + Check again), READY, NOT INSTALLED (Install… sheet with per-OS package-manager
 * commands, copyable). Scan button + pull-to-refresh (72 px, the button is the non-gesture alternative).
 * Row → details (sheet on compact, side panel on expanded): binary path, protocol, agents using it.
 * REMOTE: harnesses of agents running on cloud daemons. `+ Add ACP agent` probes a custom command with a
 * real `harness.add` handshake and shows the live result (ok · protocol · latency, or the spawn error).
 *
 * Research used: JOURNEYS §1.02 (no embedded third-party login flows: show the command, then Check);
 * install docs of each CLI's package managers (npm -g, Homebrew, winget) — commands come from the
 * daemon's signed catalog (`HarnessView.install`), the PWA only picks the ones that fit the chosen OS;
 * pull-to-refresh thresholds and rubber band from DESIGN §8.4 (iOS/Material use 64–80 px).
 */
import type { AgentView, HarnessView } from '@beamhop/core';
import {
  ArrowClockwise,
  ArrowUpRight,
  CaretRight,
  CheckCircle,
  Plus,
  Toolbox,
  WarningCircle,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { apiKey, harnessLamp, harnessMonogram, useApi, useCall, useConnection } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useExpanded } from '../../lib/media.ts';
import { Screen } from '../../shell/Screen.tsx';
import { BarAction, Button, LinkButton } from '../../ui/Button.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { HopMeter } from '../../ui/glyphs/index.tsx';
import { Badge, Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { Banner, EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { LoginPanel, LoginSheet, loginWord, managesLogin } from './HarnessLogin.tsx';
import {
  detectOs,
  groupOf,
  idFromCommand,
  installOptions,
  loginCommand,
  type Os,
  STATUS_WORD,
  splitCommand,
  supportedOses,
} from './harness-util.ts';
import { PULL_THRESHOLD, usePullToRefresh } from './usePullToRefresh.ts';

const OS_LABEL: Record<Os, string> = { mac: 'macOS', linux: 'Linux', windows: 'Windows' };

/** A copyable command line (sunken, mono). */
const CommandLine = ({ command, label }: { command: string; label: string }) => (
  <div className="flex min-w-0 items-center gap-1 rounded-md bg-sunken pl-3">
    <code className="min-w-0 flex-1 overflow-x-auto py-2 type-code whitespace-nowrap text-ink">
      <span aria-hidden="true" className="text-ink-3 select-none">
        ${' '}
      </span>
      {command}
    </code>
    <CopyButton value={command} label={label} compact />
  </div>
);

const usedBy = (id: string, agents?: AgentView[]) => (agents ?? []).filter((a) => a.config.harness === id);

// ─────────── Install sheet ───────────

const InstallSheet = ({
  h,
  onOpenChange,
  onCheck,
  checking,
}: {
  h?: HarnessView;
  onOpenChange: (o: boolean) => void;
  onCheck: () => void;
  checking: boolean;
}) => {
  const oses = h ? supportedOses(h) : [];
  const detected = useMemo(() => detectOs(), []);
  const [os, setOs] = useState<Os>(detected);
  const shown = oses.includes(os) ? os : (oses[0] ?? os);
  const options = h ? installOptions(h, shown) : [];
  const update = h?.status === 'unsupported-version';
  return (
    <Sheet
      isOpen={!!h}
      onOpenChange={onOpenChange}
      title={
        h
          ? t(update ? 'harnesses.install.updateTitle' : 'harnesses.install.title', { name: h.displayName })
          : ''
      }
      subtitle={
        h && (
          <MetaLine
            items={[h.command, h.version ? `found ${h.version}` : t('harnesses.notOnPath'), h.message]}
          />
        )
      }
      footer={
        <Button
          variant="primary"
          size="lg"
          fullWidth
          isPending={checking}
          icon={<ArrowClockwise size={18} aria-hidden="true" />}
          onPress={onCheck}
        >
          {t('harnesses.checkAgain')}
        </Button>
      }
    >
      {h && (
        <div className="flex flex-col gap-4">
          <p className="type-body-sm text-ink-2">{t('harnesses.install.lead')}</p>
          {oses.length > 1 && (
            <SegmentedControl
              label={t('harnesses.install.os')}
              value={shown}
              onChange={setOs}
              options={oses.map((o) => ({
                id: o,
                label: OS_LABEL[o],
                ariaLabel: o === detected ? `${OS_LABEL[o]} (this device)` : OS_LABEL[o],
              }))}
              className="w-full"
            />
          )}
          {options.length === 0 ? (
            <p className="type-body-sm text-ink-2">{t('harnesses.install.none', { os: OS_LABEL[shown] })}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {options.map((o, i) => (
                <li key={o.manager} className="flex flex-col gap-1.5">
                  <p className="flex items-center gap-2 type-label text-ink">
                    {o.label}
                    {i === 0 && <Badge tone="go">{t('harnesses.install.recommended')}</Badge>}
                  </p>
                  <CommandLine
                    command={o.command}
                    label={t('harnesses.install.copy', { manager: o.label })}
                  />
                </li>
              ))}
            </ol>
          )}
          {h.install?.url && (
            <a
              href={h.install.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1 type-label text-ink underline underline-offset-[3px]"
            >
              {t('harnesses.install.docs', { name: h.displayName })}
              <ArrowUpRight size={14} aria-hidden="true" />
              <span className="sr-only"> {t('harnesses.harnesses.opensInANew')}</span>
            </a>
          )}
          <p className="type-meta text-ink-2">{t('harnesses.install.after')}</p>
        </div>
      )}
    </Sheet>
  );
};

// ─────────── Add ACP agent ───────────

type Probe =
  | { state: 'idle' }
  | { state: 'probing'; started: number }
  | { state: 'done'; h: HarnessView; ms: number }
  | { state: 'failed'; message: string };

const AddAcpSheet = ({
  isOpen,
  onOpenChange,
  taken,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  taken: string[];
}) => {
  const call = useCall();
  const qc = useQueryClient();
  const [line, setLine] = useState('');
  const [name, setName] = useState('');
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const parsed = splitCommand(line);
  const id = (name.trim() || idFromCommand(parsed.command)).toLowerCase();
  const idOk = /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
  const ok = probe.state === 'done' && probe.h.status === 'ready';
  const clash = !ok && (taken.includes(`acp:${id}`) || taken.includes(id));
  useEffect(() => {
    if (!isOpen) {
      setLine('');
      setName('');
      setProbe({ state: 'idle' });
    }
  }, [isOpen]);
  const test = async () => {
    const started = performance.now();
    setProbe({ state: 'probing', started });
    try {
      const h = await call('harness.add', { id, command: parsed.command, args: parsed.args });
      const ms = Math.round(performance.now() - started);
      if (h.status === 'ready') {
        haptic('confirm');
        announce(t('harnesses.acp.okSpoken', { name: h.displayName }));
        await qc.invalidateQueries({ queryKey: ['bh', 'harness.list'] });
      } else {
        haptic('error');
        announce(h.message ?? STATUS_WORD[h.status]);
      }
      setProbe({ state: 'done', h, ms });
    } catch (e) {
      haptic('error');
      setProbe({ state: 'failed', message: (e as Error).message });
    }
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('harnesses.acp.title')}
      subtitle={t('harnesses.acp.subtitle')}
      footer={
        ok ? (
          <Button variant="primary" size="lg" fullWidth onPress={() => onOpenChange(false)}>
            {t('harnesses.acp.done')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            fullWidth
            isDisabled={!parsed.command || !idOk || clash}
            isPending={probe.state === 'probing'}
            onPress={() => void test()}
          >
            {t('harnesses.acp.test')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label={t('harnesses.acp.command')}
          description={t('harnesses.acp.commandHint')}
          placeholder={t('harnesses.harnesses.gooseAcp')}
          mono
          value={line}
          onChange={(v) => {
            setLine(v);
            if (probe.state !== 'probing') setProbe({ state: 'idle' });
          }}
          isDisabled={ok}
        />
        {parsed.command && (
          <MetaLine
            items={[
              `command ${parsed.command}`,
              parsed.args.length ? `args [${parsed.args.join(', ')}]` : t('harnesses.harnesses.noArgs'),
              { value: `id acp:${id || '…'}`, tone: idOk && !clash ? 'ink' : 'stop' },
            ]}
          />
        )}
        <TextField
          label={t('harnesses.acp.name')}
          description={clash ? t('harnesses.acp.clash', { id }) : t('harnesses.acp.nameHint')}
          placeholder={idFromCommand(parsed.command) || 'my-agent'}
          value={name}
          onChange={setName}
          isInvalid={(!!name && !idOk) || clash}
          errorMessage={clash ? t('harnesses.acp.clash', { id }) : t('harnesses.acp.nameRule')}
          isDisabled={ok}
        />
        <div aria-live="polite">
          {probe.state === 'probing' && (
            <p className="flex items-center gap-2.5 type-meta text-ink-2">
              <HopMeter up={2} total={3} busy tone="ink" />
              {t('harnesses.acp.probing', { command: parsed.command })}
            </p>
          )}
          {probe.state === 'done' && (
            <div
              className={cx(
                'flex items-start gap-3 rounded-lg border border-line px-4 py-3',
                ok ? 'bg-go-wash' : 'bg-stop-wash',
              )}
            >
              {ok ? (
                <CheckCircle
                  size={22}
                  weight="fill"
                  className="mt-0.5 shrink-0 text-go-text"
                  aria-hidden="true"
                />
              ) : (
                <WarningCircle
                  size={22}
                  weight="fill"
                  className="mt-0.5 shrink-0 text-stop-text"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p className="type-title-3 text-ink">
                  {ok ? t('harnesses.acp.ok', { id: probe.h.id }) : t('harnesses.acp.failed')}
                </p>
                <MetaLine
                  items={[
                    probe.h.message ?? STATUS_WORD[probe.h.status],
                    !ok && `${probe.ms} ms`,
                    probe.h.path,
                  ]}
                />
                {!ok && <p className="mt-1 type-body-sm text-ink-2">{t('harnesses.acp.failedHint')}</p>}
              </div>
            </div>
          )}
          {probe.state === 'failed' && (
            <ErrorState title={t('harnesses.acp.failed')} details={probe.message}>
              {probe.message}
            </ErrorState>
          )}
        </div>
        <CliStrip command={`beamhop harness add ${id || '<id>'} -- ${line || '<command>'}`} />
      </div>
    </Sheet>
  );
};

// ─────────── Rows & details ───────────

const HarnessRow = ({
  h,
  agents,
  selected,
  onOpen,
  onInstall,
  onCheck,
  onLogin,
  checking,
  lastCheck,
}: {
  h: HarnessView;
  agents?: AgentView[];
  lastCheck?: Date;
  selected: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onCheck: () => void;
  onLogin: () => void;
  checking: boolean;
}) => {
  const users = usedBy(h.id, agents);
  const slug: Array<string | false | undefined> =
    h.status === 'ready'
      ? [
          h.protocol === 'acp' ? t('harnesses.harnesses.acp') : h.protocol,
          managesLogin(h) ? loginWord(h.login) : h.message?.replace(/^ACP ✓ · /, ''),
          users.length > 0 && t('harnesses.usedBy', { count: users.length }),
        ]
      : h.status === 'not-installed'
        ? [h.command, t('harnesses.notOnPath')]
        : [
            h.status === 'needs-login' && managesLogin(h)
              ? loginWord(h.login)
              : h.status === 'needs-login'
                ? h.path
                : (h.message ?? STATUS_WORD[h.status]),
            users.length > 0 && t('harnesses.usedBy', { count: users.length }),
          ];
  return (
    <li className={cx('border-b border-line last:border-b-0', selected && 'bg-flare-wash')}>
      <RACButton
        onPress={onOpen}
        aria-current={selected ? 'true' : undefined}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
      >
        <LetterTile code={harnessMonogram(h.id)} className="mt-0.5 self-start" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate type-title-3 text-ink">{h.displayName}</span>
            <span className="shrink-0 type-meta text-ink-2 tabular-nums">{h.version ?? '—'}</span>
            <StatusDot state={harnessLamp(h)} label={STATUS_WORD[h.status]} className="ml-auto shrink-0" />
          </span>
          <MetaLine items={slug.filter(Boolean) as string[]} />
        </span>
        <CaretRight size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
      </RACButton>
      {h.status === 'needs-login' && managesLogin(h) && (
        <div className="flex flex-col gap-2 px-4 pb-3 pl-[3.75rem]">
          <p className="type-body-sm text-ink-2">
            {h.login.status === 'invalid' && h.login.message
              ? h.login.message
              : t('harnesses.loginHintManaged', { name: h.displayName })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onPress={onLogin}
              aria-label={t('harnesses.login.logInFor', { name: h.displayName })}
            >
              {t('harnesses.login.logIn')}
            </Button>
          </div>
        </div>
      )}
      {h.status === 'needs-login' && !managesLogin(h) && (
        <div className="flex flex-col gap-2 px-4 pb-3 pl-[3.75rem]">
          <p className="type-body-sm text-ink-2">
            {t('harnesses.loginHint', { name: h.displayName })}
            {lastCheck && (
              <span className="type-meta"> {t('harnesses.stillLogin', { time: clock(lastCheck) })}</span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-48">
              <CommandLine
                command={loginCommand(h)}
                label={t('harnesses.copyLogin', { name: h.displayName })}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              isPending={checking}
              onPress={onCheck}
              aria-label={t('harnesses.checkAgainFor', { name: h.displayName })}
            >
              {t('harnesses.checkAgain')}
            </Button>
          </div>
        </div>
      )}
      {(h.status === 'not-installed' || h.status === 'unsupported-version') && (
        <div className="flex px-4 pb-3 pl-[3.75rem]">
          <Button
            variant="secondary"
            size="sm"
            onPress={onInstall}
            aria-label={t(h.status === 'not-installed' ? 'harnesses.installFor' : 'harnesses.updateFor', {
              name: h.displayName,
            })}
          >
            {t(h.status === 'not-installed' ? 'harnesses.install' : 'harnesses.update')}
          </Button>
        </div>
      )}
    </li>
  );
};

const Details = ({
  h,
  agents,
  onInstall,
  inSheet,
}: {
  h: HarnessView;
  agents?: AgentView[];
  onInstall: () => void;
  inSheet?: boolean;
}) => {
  const users = usedBy(h.id, agents);
  const rows: Array<[string, ReactNode]> = [
    [t('harnesses.d.status'), <StatusDot key="s" state={harnessLamp(h)} label={STATUS_WORD[h.status]} />],
    [t('harnesses.d.version'), h.version ?? '—'],
    [
      t('harnesses.d.command'),
      <code key="c" className="type-code break-all">
        {h.command}
      </code>,
    ],
    [
      t('harnesses.d.path'),
      h.path ? (
        <code key="p" className="type-code break-all">
          {h.path}
        </code>
      ) : (
        t('harnesses.notOnPath')
      ),
    ],
    [
      t('harnesses.d.protocol'),
      h.protocol === 'acp' ? t('harnesses.harnesses.acpAgentClientProtocol') : h.protocol,
    ],
    [t('harnesses.d.message'), h.message ?? '—'],
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className={cx('flex items-center gap-3', inSheet && 'sr-only')}>
        <LetterTile code={harnessMonogram(h.id)} size={40} tone="ink" />
        <div className="min-w-0">
          <h2 className="type-title-2 text-ink">{h.displayName}</h2>
          <MetaLine items={[h.id, h.version, h.protocol]} />
        </div>
      </div>
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="border-b border-line py-2.5 type-meta text-ink-2">{k}</dt>
            <dd className="min-w-0 border-b border-line py-2.5 type-body-sm text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby={`used-${h.id}`}>
        <Eyebrow id={`used-${h.id}`} level={3} count={users.length}>
          {t('harnesses.d.usedBy')}
        </Eyebrow>
        {users.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('harnesses.d.unused')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {users.map((a) => (
              <li key={a.config.name}>
                <LinkButton href={`/agents/${a.config.name}`} size="sm">
                  {a.config.name}
                </LinkButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      {managesLogin(h) && h.status !== 'not-installed' && <LoginPanel h={h} />}
      {h.status === 'needs-login' && !managesLogin(h) && (
        <CommandLine command={loginCommand(h)} label={t('harnesses.copyLogin', { name: h.displayName })} />
      )}
      {(h.status === 'not-installed' || h.status === 'unsupported-version' || h.install) &&
        h.status !== 'ready' && (
          <Button variant="secondary" onPress={onInstall}>
            {t(h.status === 'unsupported-version' ? 'harnesses.update' : 'harnesses.install')}
          </Button>
        )}
      <CliStrip command="beamhop harness ls" />
    </div>
  );
};

// ─────────── Screen ───────────

export const HarnessesScreen = () => {
  const q = useApi('harness.list');
  const agents = useApi('agent.list');
  const deployments = useApi('deploy.list');
  const call = useCall();
  const qc = useQueryClient();
  const expanded = useExpanded();
  const conn = useConnection();
  const offline = !conn.online || conn.status === 'closed';
  const showSkeleton = useDelayedLoading(q.isPending);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<Date>();
  const [selectedId, setSelectedId] = useState<string>();
  const [sheetId, setSheetId] = useState<string>();
  const [installId, setInstallId] = useState<string>();
  const [acpOpen, setAcpOpen] = useState(false);
  const [loginId, setLoginId] = useState<string>();
  const harnesses = q.data?.harnesses ?? [];

  const scan = async () => {
    if (scanning || offline) return;
    setScanning(true);
    announce(t('harnesses.scanning'));
    try {
      const r = await call('harness.scan');
      qc.setQueryData(apiKey('harness.list'), r);
      setLastScan(new Date());
      const ready = r.harnesses.filter((h) => h.status === 'ready').length;
      announce(t('harnesses.scanDone', { ready, total: r.harnesses.length }));
    } catch (e) {
      announce((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  const { pull, armed } = usePullToRefresh(() => void scan(), !expanded);

  const attention = harnesses.filter((h) => groupOf(h) === 'attention');
  const ready = harnesses.filter((h) => groupOf(h) === 'ready');
  const missing = harnesses.filter((h) => groupOf(h) === 'missing');
  const selected = harnesses.find((h) => h.id === (selectedId ?? attention[0]?.id ?? harnesses[0]?.id));
  const remote = (deployments.data?.deployments ?? []).filter((d) => d.status === 'running');
  const agentList = agents.data?.agents;

  const open = (h: HarnessView) => {
    setSelectedId(h.id);
    if (!expanded) setSheetId(h.id);
  };
  const group = (id: string, label: string, list: HarnessView[]) =>
    list.length > 0 && (
      <section aria-labelledby={id}>
        <Eyebrow id={id} count={list.length}>
          {label}
        </Eyebrow>
        <ul className="overflow-hidden rounded-lg border border-line bg-surface">
          {list.map((h) => (
            <HarnessRow
              key={h.id}
              h={h}
              agents={agentList}
              selected={expanded && selected?.id === h.id}
              onOpen={() => open(h)}
              onInstall={() => setInstallId(h.id)}
              onCheck={() => void scan()}
              onLogin={() => setLoginId(h.id)}
              checking={scanning}
              lastCheck={lastScan}
            />
          ))}
        </ul>
      </section>
    );

  let body: ReactNode;
  if (q.isPending)
    body = showSkeleton ? <Skeleton variant="list" count={5} label={t('harnesses.loading')} /> : null;
  else if (q.error && !q.data)
    body = (
      <ErrorState title={t('harnesses.error')} details={q.error} onRetry={() => void q.refetch()}>
        {t('harnesses.errorBody')}
      </ErrorState>
    );
  else if (harnesses.length === 0)
    body = (
      <EmptyState
        glyph={<Toolbox size={32} aria-hidden="true" />}
        title={t('harnesses.emptyTitle')}
        action={
          <Button variant="primary" onPress={() => void scan()} isPending={scanning}>
            {t('harnesses.scan')}
          </Button>
        }
        cli="beamhop harness scan"
      >
        {t('harnesses.emptyBody')}
      </EmptyState>
    );
  else
    body = (
      <div className="flex flex-col gap-6">
        {ready.length === 0 && (
          <Banner
            tone="caution"
            className="-mx-gutter expanded:mx-0 expanded:rounded-md expanded:border"
            action={
              missing[0] && (
                <Button variant="primary" size="sm" onPress={() => setInstallId(missing[0]!.id)}>
                  {t('harnesses.installFor', { name: missing[0].displayName })}
                </Button>
              )
            }
          >
            {t('harnesses.noneReady')}
          </Banner>
        )}
        {group('h-attention', t('harnesses.g.attention'), attention)}
        {group('h-ready', t('harnesses.g.ready'), ready)}
        {group('h-missing', t('harnesses.g.missing'), missing)}
        {remote.map((d) => {
          const there = (agentList ?? []).filter(
            (a) => a.location.kind === 'cloud' && a.config.name === d.agent,
          );
          return (
            <section key={d.id} aria-labelledby={`remote-${d.id}`}>
              <Eyebrow id={`remote-${d.id}`}>
                {t('harnesses.g.remote', { where: `${d.provider}-${d.region ?? ''}`.replace(/-$/, '') })}
              </Eyebrow>
              <ul className="overflow-hidden rounded-lg border border-dashed border-line-strong">
                {there.map((a) => {
                  const local = harnesses.find((h) => h.id === a.config.harness);
                  return (
                    <li key={a.config.name} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
                      <LetterTile code={harnessMonogram(a.config.harness)} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate type-title-3 text-ink">
                          {local?.displayName ?? a.config.harness}
                        </span>
                        <MetaLine items={[t('harnesses.remoteFor', { agent: a.config.name }), d.size]} />
                      </span>
                      <StatusDot
                        state={a.status === 'error' ? 'error' : a.status === 'stopped' ? 'stopped' : 'ready'}
                        label={a.status === 'error' ? 'error' : a.status === 'stopped' ? 'stopped' : 'ready'}
                      />
                    </li>
                  );
                })}
                {there.length === 0 && (
                  <li className="px-4 py-3 type-body-sm text-ink-2">{t('harnesses.remoteNone')}</li>
                )}
              </ul>
            </section>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="quiet"
            icon={<Plus size={18} aria-hidden="true" />}
            onPress={() => setAcpOpen(true)}
            isDisabled={offline}
          >
            {t('harnesses.addAcp')}
          </Button>
        </div>
        <CliStrip command="beamhop harness scan" />
      </div>
    );

  const total = harnesses.length;
  return (
    <Screen
      title={t('nav.harnesses')}
      slug={
        <MetaLine
          items={[
            t('harnesses.harnesses.catalogV20261112'),
            { value: 'signed ✓', tone: 'go' },
            q.data && t('harnesses.slugReady', { ready: ready.length, total }),
            lastScan && t('harnesses.slugScanned', { time: clock(lastScan) }),
          ]}
        />
      }
      actions={
        <BarAction
          variant="secondary"
          label={t('harnesses.scan')}
          icon={
            <ArrowClockwise
              size={20}
              aria-hidden="true"
              className={cx(scanning && 'motion-safe:animate-spin')}
            />
          }
          isPending={scanning}
          isDisabled={offline}
          onPress={() => void scan()}
        />
      }
    >
      {!expanded && (pull > 0 || scanning) && (
        <div
          aria-hidden="true"
          className="flex items-center justify-center gap-2 overflow-hidden type-meta text-ink-2"
          style={{ height: scanning ? 36 : pull }}
        >
          <HopMeter up={scanning ? 3 : Math.round((pull / PULL_THRESHOLD) * 3)} total={3} busy={scanning} />
          {scanning ? t('harnesses.scanning') : armed ? t('harnesses.release') : t('harnesses.pull')}
        </div>
      )}
      {expanded && harnesses.length > 0 ? (
        <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-8">
          {body}
          <aside
            aria-label={t('harnesses.d.label')}
            className="sticky top-24 self-start rounded-lg border border-line bg-surface p-5"
          >
            {selected && (
              <Details h={selected} agents={agentList} onInstall={() => setInstallId(selected.id)} />
            )}
          </aside>
        </div>
      ) : (
        body
      )}
      {!expanded && (
        <Sheet
          isOpen={!!sheetId}
          onOpenChange={(o) => !o && setSheetId(undefined)}
          title={harnesses.find((h) => h.id === sheetId)?.displayName ?? ''}
        >
          {harnesses.find((h) => h.id === sheetId) && (
            <Details
              h={harnesses.find((h) => h.id === sheetId)!}
              agents={agentList}
              inSheet
              onInstall={() => {
                setInstallId(sheetId);
                setSheetId(undefined);
              }}
            />
          )}
        </Sheet>
      )}
      <InstallSheet
        h={harnesses.find((h) => h.id === installId)}
        onOpenChange={(o) => !o && setInstallId(undefined)}
        checking={scanning}
        onCheck={async () => {
          await scan();
          const h = qc
            .getQueryData<{ harnesses: HarnessView[] }>(apiKey('harness.list'))
            ?.harnesses.find((x) => x.id === installId);
          if (h?.status === 'ready') setInstallId(undefined);
        }}
      />
      <AddAcpSheet isOpen={acpOpen} onOpenChange={setAcpOpen} taken={harnesses.map((h) => h.id)} />
      {(() => {
        const lh = harnesses.find((h) => h.id === loginId);
        return lh && managesLogin(lh) ? (
          <LoginSheet h={lh} isOpen onOpenChange={(o) => !o && setLoginId(undefined)} />
        ) : null;
      })()}
    </Screen>
  );
};
