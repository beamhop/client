/**
 * TODO(agents builder): Agent detail — SCREENS §4.2 (+ Sandbox embeds the Policy editor, §7).
 * Routes: /agents/$name and /agents/$name/$section, section ∈ overview|setup|sandbox|channels|schedules|budgets|identity.
 * Build: header (tile, lamp, AI disclosure, slug with npub copy), Doto "$1.80 left" + SegmentedMeter,
 * RAC Tabs driving the section route (desktop: 200px sub-nav), each section per SCREENS.
 * Data: useApi('agent.get', { name }), 'policy.get', 'schedule.list', 'agent.instructions', 'usage.query'.
 */
import { useParams } from '@tanstack/react-router';
import { agentLamp, harnessMonogram, useApi } from '../../api/index.ts';
import { usd } from '../../lib/format.ts';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { Tabs } from '../../ui/Choice.tsx';
import { LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { SegmentedMeter, StatusDot } from '../../ui/Status.tsx';

export const AGENT_SECTIONS = [
  'overview',
  'setup',
  'sandbox',
  'channels',
  'schedules',
  'budgets',
  'identity',
] as const;

export const AgentDetailScreen = () => {
  const { name, section = 'overview' } = useParams({ strict: false }) as { name: string; section?: string };
  const q = useApi('agent.get', { name });
  const a = q.data;
  const budget = a?.config.budgets.dailyUsd ?? 0;
  return (
    <Screen
      title={name}
      back={{ href: '/agents', label: 'Agents' }}
      pane="detail"
      crumbs={[
        { label: 'Agents', href: '/agents' },
        { label: name, href: `/agents/${name}` },
        { label: section[0]!.toUpperCase() + section.slice(1) },
      ]}
      slug={
        a && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <LetterTile code={harnessMonogram(a.config.harness)} />
              <StatusDot state={agentLamp(a)} />
              <span className="type-meta text-ink-2">· {a.location.kind}</span>
            </div>
            <MetaLine
              items={[{ value: a.config.identity.npub ?? 'no npub', truncate: 16 }, a.config.identity.nip05]}
            />
            {budget > 0 && (
              <SegmentedMeter
                name={`${name} budget today`}
                value={a.usageToday.usd}
                max={budget}
                label={`${usd(a.usageToday.usd)} / ${usd(budget)} today`}
                valueText={`${usd(a.usageToday.usd)} of ${usd(budget)} used today`}
              />
            )}
          </div>
        )
      }
    >
      <Tabs
        label={`${name} sections`}
        selectedKey={section}
        panels={false}
        tabs={AGENT_SECTIONS.map((s) => ({
          id: s,
          label: s[0]!.toUpperCase() + s.slice(1),
          href: `/agents/${name}/${s}`,
        }))}
      >
        <ScreenStub
          spec={`SCREENS §4.2 · section ${section}`}
          owner="src/screens/agents/"
          outline={[
            'Overview: live + last 5 sessions, behaviour files, memberships',
            'Setup: harness, model, mounts (RO|RW), concurrency',
            'Sandbox: reach summary, findings, profile, roles matrix',
            'Channels · Schedules · Budgets · Identity',
          ]}
          calls={[
            { method: 'agent.get', params: { name } },
            { method: 'policy.get', params: { name } },
            { method: 'schedule.list', params: { agent: name } },
          ]}
          cli={`beamhop agent show ${name}`}
        />
      </Tabs>
    </Screen>
  );
};
