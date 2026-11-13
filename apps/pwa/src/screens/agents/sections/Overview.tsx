/**
 * Overview: what it's doing now (live sessions), the last 5 sessions, harness instruction files found
 * in its mounts (agent.instructions; editable in rw mounts, InstructionSheet), memberships at a glance,
 * setup slug, CLI.
 */
import type { AgentView, SessionView } from '@beamhop/core';
import { CaretRight, FileText } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, Button as RACButton } from 'react-aria-components';
import { harnessSlug, sessionLamp, targetLabel, useApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { since, usd } from '../../../lib/format.ts';
import { LinkButton } from '../../../ui/Button.tsx';
import { MetaLine } from '../../../ui/Meta.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../../ui/States.tsx';
import { RouteLine, StatusDot } from '../../../ui/Status.tsx';
import { Block, Rows } from '../parts.tsx';
import { InstructionSheet } from './InstructionSheet.tsx';

const SessionRow = ({ s }: { s: SessionView }) => (
  <li>
    <Link
      href={`/sessions/${s.id}`}
      className="flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate type-body text-ink">{s.title}</span>
        <MetaLine
          items={[
            `${s.channel}:${s.conversationId}`,
            `thread ${s.threadId}`,
            usd(s.usage.usd),
            since(s.lastActivityAt),
          ]}
        />
      </span>
      <StatusDot state={sessionLamp(s)} />
      <CaretRight size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
    </Link>
  </li>
);

export const OverviewSection = ({ agent }: { agent: AgentView }) => {
  const name = agent.config.name;
  const sessions = useApi('session.list', { agent: name });
  const files = useApi('agent.instructions', { name });
  const harnesses = useApi('harness.list');
  const channels = useApi('channel.list');
  const [open, setOpen] = useState<string | null>(null);
  const showSkel = useDelayedLoading(sessions.isPending);
  const all = sessions.data?.sessions ?? [];
  const live = all.filter((s) => s.status === 'running' || s.status === 'queued');
  const recent = all.filter((s) => !live.includes(s)).slice(0, 5);
  const file = files.data?.files.find((f) => f.path === open);
  const cfg = agent.config;

  return (
    <div className="flex flex-col gap-8">
      {cfg.description && <p className="type-body text-ink">{cfg.description}</p>}

      <Block id="ov-now" title={t('agents.ov.now', { count: live.length })}>
        {sessions.isPending ? (
          showSkel && <Skeleton count={1} />
        ) : sessions.isError ? (
          <ErrorState
            title={t('agents.ov.sessionsError')}
            onRetry={() => void sessions.refetch()}
            details={sessions.error}
          />
        ) : live.length ? (
          <Rows label={t('agents.ov.liveLabel')}>
            {live.map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
          </Rows>
        ) : (
          <p className="type-body-sm text-ink-2">
            {agent.status === 'stopped'
              ? t('agents.ov.stoppedNow', { name })
              : t('agents.ov.idleNow', { name })}
          </p>
        )}
      </Block>

      {recent.length > 0 && (
        <Block
          id="ov-recent"
          title={t('agents.ov.recent')}
          action={
            <LinkButton href="/sessions" variant="quiet" size="sm">
              {t('agents.ov.allSessions')}
            </LinkButton>
          }
        >
          <Rows label={t('agents.ov.recent')}>
            {recent.map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
          </Rows>
        </Block>
      )}

      <Block id="ov-files" title={t('agents.ov.files')} description={t('agents.ov.filesHint')}>
        {files.isError ? (
          <ErrorState
            title={t('agents.ov.filesError')}
            onRetry={() => void files.refetch()}
            details={files.error}
          />
        ) : (files.data?.files.length ?? 0) === 0 ? (
          <p className="type-body-sm text-ink-2">{files.isPending ? '…' : t('agents.ov.filesNone')}</p>
        ) : (
          <Rows label={t('agents.ov.files')}>
            {files.data?.files.map((f) => (
              <li key={f.path}>
                <RACButton
                  onPress={() => setOpen(f.path)}
                  className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
                >
                  <FileText size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate type-meta text-ink">{f.path}</span>
                    <span className="type-meta text-ink-2">
                      {t('agents.ov.fileFor', {
                        harness: f.harness,
                        lines: f.content.split('\n').filter(Boolean).length,
                      })}
                    </span>
                  </span>
                  <span className="type-label text-ink-2">{t('agents.ov.view')}</span>
                </RACButton>
              </li>
            ))}
          </Rows>
        )}
      </Block>

      <Block
        id="ov-where"
        title={t('agents.ov.where', { count: cfg.memberships.length })}
        action={
          <LinkButton href={`/agents/${name}/channels`} variant="quiet" size="sm">
            {t('agents.ov.edit')}
          </LinkButton>
        }
      >
        {cfg.memberships.length ? (
          <ul className="flex flex-col gap-3">
            {cfg.memberships.map((m) => (
              <li key={m.target} className="flex flex-col gap-1">
                <RouteLine
                  nodes={[
                    { label: targetLabel(m.target, channels.data?.channels), kind: 'channel' },
                    { label: name, kind: 'agent' },
                  ]}
                  live={agent.status === 'busy'}
                />
                <MetaLine
                  items={[t('agents.ov.defaultRole', { role: m.defaultRole }), m.triggers.join(' + ')]}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-body-sm text-ink-2">{t('agents.ov.nowhere', { name })}</p>
        )}
      </Block>

      <Block id="ov-setup" title={t('agents.ov.setup')} cli={`beamhop agent show ${name}`}>
        <MetaLine
          className="whitespace-normal"
          items={[
            harnessSlug(cfg.harness, harnesses.data?.harnesses),
            cfg.model,
            cfg.sandbox.profile,
            ...cfg.mounts.map((m) => `${m.path} ${m.mode}`),
          ]}
        />
      </Block>

      <InstructionSheet agent={agent} file={file} onClose={() => setOpen(null)} />
    </div>
  );
};
