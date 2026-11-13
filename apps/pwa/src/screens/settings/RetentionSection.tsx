/**
 * Settings → Retention & data (SCREENS §10). Per-agent transcript / audit retention (agent.update
 * `retention`), encrypted-at-rest note, `Export all data` (data.export → path on this computer),
 * `Purge…` (agent + age + type the agent name, or `everything`, to confirm → data.purge).
 */
import type { AgentView } from '@beamhop/core';
import { DownloadSimple, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t as tr } from '../../i18n/index.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Radio, RadioGroup, SegmentedControl } from '../../ui/Choice.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { confirmMatches, Group, List, Row, TypeToConfirm } from './kit.tsx';

const days = (n: number) => (n % 365 === 0 ? `${n / 365} y` : `${n} d`);
const ALL = '__all';

const EditRetention = ({ agent, onClose }: { agent: AgentView; onClose: () => void }) => {
  const [t, setT] = useState(agent.config.retention.transcriptDays);
  const [a, setA] = useState(agent.config.retention.auditDays);
  const update = useMutationApi('agent.update');
  const toast = useToast();
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={tr('settings.retention.title', { name: agent.config.name })}
      footer={
        <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            isPending={update.isPending}
            onPress={async () => {
              try {
                await update.mutateAsync({
                  name: agent.config.name,
                  patch: { retention: { transcriptDays: t, auditDays: a } },
                });
                toast.show({
                  message: `Saved · ${agent.config.name} keeps transcripts ${days(t)}`,
                  tone: 'success',
                });
                onClose();
              } catch (e) {
                toast.show({ message: (e as Error).message, tone: 'error' });
              }
            }}
          >
            {tr('settings.retention.save')}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={onClose}>
            {tr('settings.identity.cancel')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <NumberField
          label={tr('settings.retention.keepTranscriptsFor')}
          unit="days"
          minValue={1}
          maxValue={3650}
          value={t}
          onChange={(v) => Number.isFinite(v) && setT(v)}
          description={tr('settings.retention.messagesToolCallsAnd')}
        />
        <NumberField
          label={tr('settings.retention.keepAuditLogFor')}
          unit="days"
          minValue={30}
          maxValue={3650}
          value={a}
          onChange={(v) => Number.isFinite(v) && setA(v)}
          description={tr('settings.retention.whoAllowedWhatAt')}
        />
      </div>
    </Sheet>
  );
};

const AGES = [
  { id: '7', label: '7 d' },
  { id: '30', label: '30 d' },
  { id: '90', label: '90 d' },
  { id: '0', label: 'All' },
] as const;

const PurgeSheet = ({
  open,
  onOpenChange,
  agents,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agents: AgentView[];
}) => {
  const [agent, setAgent] = useState<string>(ALL);
  const [age, setAge] = useState<(typeof AGES)[number]['id']>('30');
  const [typed, setTyped] = useState('');
  const purge = useMutationApi('data.purge');
  const toast = useToast();
  const expected = agent === ALL ? 'everything' : agent;
  const ok = confirmMatches(typed, expected);
  const what = `${agent === ALL ? 'every agent' : agent} · ${age === '0' ? 'all of it' : `older than ${age} days`}`;
  const close = () => {
    setTyped('');
    purge.reset();
    onOpenChange(false);
  };
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={tr('settings.retention.purgeData')}
      subtitle={what}
      isDismissable={false}
      role="alertdialog"
      focusTitle
      footer={
        <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
          <Button
            variant="destructive"
            size="lg"
            fullWidth
            isDisabled={!ok}
            isPending={purge.isPending}
            icon={<Trash size={18} weight="bold" aria-hidden="true" />}
            onPress={async () => {
              try {
                const before =
                  age === '0' ? undefined : new Date(Date.now() - Number(age) * 86_400_000).toISOString();
                // The dialog says audit entries go too (and is confirmed by typing).
                const r = await purge.mutateAsync({
                  ...(agent === ALL ? {} : { agent }),
                  ...(before ? { before } : {}),
                  includeAudit: true,
                });
                haptic('confirm');
                toast.show({ message: `Purged · ${r.deleted} records deleted`, tone: 'success' });
                close();
              } catch (e) {
                toast.show({ message: (e as Error).message, tone: 'error' });
              }
            }}
          >
            {agent === ALL
              ? tr('settings.retention.purgeAll')
              : tr('settings.retention.purgeAgent', { agent })}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={close}>
            {tr('settings.identity.cancel')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="type-body text-ink-2">{tr('settings.retention.transcriptsAndAuditEntries')}</p>
        <RadioGroup
          label={tr('settings.retention.agent')}
          value={agent}
          onChange={(k) => {
            setAgent(k);
            setTyped('');
          }}
        >
          <Radio value={ALL}>{tr('settings.retention.allAgents')}</Radio>
          {agents.map((a) => (
            <Radio key={a.config.name} value={a.config.name}>
              {a.config.name}
            </Radio>
          ))}
        </RadioGroup>
        <div className="flex flex-col gap-1.5">
          <span className="type-label text-ink">{tr('settings.retention.dataOlderThan')}</span>
          <SegmentedControl
            label={tr('settings.retention.dataOlderThan')}
            value={age}
            onChange={setAge}
            options={[...AGES]}
          />
        </div>
        <TypeToConfirm expected={expected} value={typed} onChange={setTyped} />
      </div>
    </Sheet>
  );
};

export const RetentionSection = () => {
  const q = useApi('agent.list');
  const exp = useMutationApi('data.export');
  const [editing, setEditing] = useState<AgentView>();
  const [purging, setPurging] = useState(false);
  const showSkeleton = useDelayedLoading(q.isPending);

  if (q.isError)
    return (
      <ErrorState
        title={tr('settings.retention.couldnTLoadAgents')}
        details={q.error}
        onRetry={() => void q.refetch()}
      >
        {q.error.message}
      </ErrorState>
    );
  if (q.isPending)
    return showSkeleton ? (
      <Skeleton variant="list" count={4} label={tr('settings.retention.loadingRetention')} />
    ) : null;
  const agents = q.data.agents;

  return (
    <div className="flex flex-col gap-8">
      <p className="type-body-sm text-ink-2">{tr('settings.retention.defaultsTranscripts30Days')}</p>
      <Group title={tr('settings.retention.perAgent')} id="ret-agents">
        <List>
          {agents.map((a) => (
            <Row
              key={a.config.name}
              title={a.config.name}
              slug={
                <MetaLine
                  items={[
                    `transcripts ${days(a.config.retention.transcriptDays)}`,
                    `audit ${days(a.config.retention.auditDays)}`,
                  ]}
                />
              }
              actions={
                <Button
                  variant="quiet"
                  size="sm"
                  onPress={() => setEditing(a)}
                  aria-label={tr('settings.retention.editFor', { name: a.config.name })}
                >
                  {tr('settings.retention.edit')}
                </Button>
              }
            />
          ))}
        </List>
      </Group>

      <Group title={tr('settings.retention.export')} id="ret-export">
        <p className="type-body-sm text-ink-2">{tr('settings.retention.oneArchiveWithConfig')}</p>
        <Button
          variant="secondary"
          className="mt-2 self-start"
          icon={<DownloadSimple size={16} aria-hidden="true" />}
          isPending={exp.isPending}
          onPress={() => exp.mutate({})}
        >
          {tr('settings.retention.exportAllData')}
        </Button>
        {exp.data && (
          <div role="status" className="mt-2 flex items-center gap-2 rounded-md bg-go-wash py-1 pr-1 pl-3">
            <span className="min-w-0 flex-1 truncate type-meta text-go-text">
              {tr('settings.retention.saved', { path: exp.data.path })}
            </span>
            <CopyButton value={exp.data.path} label={tr('settings.retention.copyPath')} compact />
          </div>
        )}
        {exp.isError && <p className="mt-2 type-body-sm text-stop-text">{exp.error.message}</p>}
      </Group>

      <CliStrip command="beamhop data export" />

      {/* Danger zone: irreversible actions live apart from Export, in their own hatched card. */}
      <section
        aria-labelledby="ret-purge"
        className="relative mt-4 overflow-hidden rounded-lg border border-stop-text bg-surface p-4"
      >
        <span
          aria-hidden="true"
          className="hatch pointer-events-none absolute inset-y-0 left-0 w-3 border-r border-line text-stop-text"
        />
        <div className="relative flex flex-col gap-2 pl-4">
          <h2 id="ret-purge" className="type-micro text-stop-text">
            {tr('settings.retention.dangerZone')}
          </h2>
          <p className="type-body-sm text-ink-2">{tr('settings.retention.deleteTranscriptsAndAudit')}</p>
          <Button
            variant="destructive-outline"
            className="mt-1 self-start"
            icon={<Trash size={16} aria-hidden="true" />}
            onPress={() => setPurging(true)}
          >
            {tr('settings.retention.purge2')}
          </Button>
          <CliStrip command="beamhop data purge --agent reviewer --before 30d" />
        </div>
      </section>

      {editing && <EditRetention agent={editing} onClose={() => setEditing(undefined)} />}
      <PurgeSheet open={purging} onOpenChange={setPurging} agents={agents} />
    </div>
  );
};
