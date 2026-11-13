/**
 * Settings → Retention & data (SCREENS §10). Per-agent transcript / audit retention (agent.update
 * `retention`), encrypted-at-rest note, `Export all data` (data.export → path on this computer),
 * `Purge…` (agent + age + type the agent name, or `everything`, to confirm → data.purge).
 */
import type { AgentView } from '@beamhop/core';
import { DownloadSimple, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
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
      title={`Retention · ${agent.config.name}`}
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
            Save
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <NumberField
          label="Keep transcripts for"
          unit="days"
          minValue={1}
          maxValue={3650}
          value={t}
          onChange={(v) => Number.isFinite(v) && setT(v)}
          description="Messages, tool calls and outputs. Older sessions are deleted nightly."
        />
        <NumberField
          label="Keep audit log for"
          unit="days"
          minValue={30}
          maxValue={3650}
          value={a}
          onChange={(v) => Number.isFinite(v) && setA(v)}
          description="Who allowed what. At least 30 days."
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
      title="Purge data?"
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
                const r = await purge.mutateAsync({
                  ...(agent === ALL ? {} : { agent }),
                  ...(before ? { before } : {}),
                });
                haptic('confirm');
                toast.show({ message: `Purged · ${r.deleted} records deleted`, tone: 'success' });
                close();
              } catch (e) {
                toast.show({ message: (e as Error).message, tone: 'error' });
              }
            }}
          >
            Purge {agent === ALL ? 'everything' : agent}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={close}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="type-body text-ink-2">
          Transcripts and audit entries are deleted from this computer for good. Export first if you might
          need them. Cloud daemons purge on their next heartbeat.
        </p>
        <RadioGroup
          label="Agent"
          value={agent}
          onChange={(k) => {
            setAgent(k);
            setTyped('');
          }}
        >
          <Radio value={ALL}>All agents</Radio>
          {agents.map((a) => (
            <Radio key={a.config.name} value={a.config.name}>
              {a.config.name}
            </Radio>
          ))}
        </RadioGroup>
        <div className="flex flex-col gap-1.5">
          <span className="type-label text-ink">Data older than</span>
          <SegmentedControl label="Data older than" value={age} onChange={setAge} options={[...AGES]} />
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
      <ErrorState title="Couldn't load agents." details={q.error} onRetry={() => void q.refetch()}>
        {q.error.message}
      </ErrorState>
    );
  if (q.isPending)
    return showSkeleton ? <Skeleton variant="list" count={4} label="Loading retention" /> : null;
  const agents = q.data.agents;

  return (
    <div className="flex flex-col gap-8">
      <p className="type-body-sm text-ink-2">
        Defaults: transcripts 30 days, audit log 1 year. Everything is encrypted at rest; the key is in your
        OS keychain.
      </p>
      <Group title="Per agent" id="ret-agents">
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
                  aria-label={`Edit retention for ${a.config.name}`}
                >
                  Edit
                </Button>
              }
            />
          ))}
        </List>
      </Group>

      <Group title="Export" id="ret-export">
        <p className="type-body-sm text-ink-2">
          One archive with config (no secrets), transcripts and the audit log, saved on the computer running
          beamhop.
        </p>
        <Button
          variant="secondary"
          className="mt-2 self-start"
          icon={<DownloadSimple size={16} aria-hidden="true" />}
          isPending={exp.isPending}
          onPress={() => exp.mutate({})}
        >
          Export all data
        </Button>
        {exp.data && (
          <div role="status" className="mt-2 flex items-center gap-2 rounded-md bg-go-wash py-1 pr-1 pl-3">
            <span className="min-w-0 flex-1 truncate type-meta text-go-text">Saved · {exp.data.path}</span>
            <CopyButton value={exp.data.path} label="Copy path" compact />
          </div>
        )}
        {exp.isError && <p className="mt-2 type-body-sm text-stop-text">{exp.error.message}</p>}
      </Group>

      <Group title="Purge" id="ret-purge">
        <p className="type-body-sm text-ink-2">
          Delete transcripts and audit entries now, before retention would.
        </p>
        <Button
          variant="destructive-outline"
          className="mt-2 self-start"
          icon={<Trash size={16} aria-hidden="true" />}
          onPress={() => setPurging(true)}
        >
          Purge…
        </Button>
      </Group>

      <CliStrip command="beamhop data export && beamhop data purge --agent reviewer --before 30d" />
      {editing && <EditRetention agent={editing} onClose={() => setEditing(undefined)} />}
      <PurgeSheet open={purging} onOpenChange={setPurging} agents={agents} />
    </div>
  );
};
