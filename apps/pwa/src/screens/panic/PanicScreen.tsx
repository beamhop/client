/**
 * /panic (JOURNEYS §8) — implemented by the foundation. Deep-linkable (manifest shortcut "Stop everything").
 * Not panicked: the confirm (one press stops everything). Panicked: Review & resume — what was running
 * before, all UNCHECKED by default; recent security events; a note for the audit log; `Resume N selected`.
 * beamhop never resumes on its own.
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { agentLamp, useApi, useCall } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { clock, when } from '../../lib/format.ts';
import { announce } from '../../lib/live.ts';
import { PanicConfirm, usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';
import { Checkbox } from '../../ui/Choice.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Eyebrow, MetaLine, Readout } from '../../ui/Meta.tsx';
import { Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';

const ResumeReview = ({ since }: { since?: string }) => {
  const agents = useApi('agent.list');
  const schedules = useApi('schedule.list');
  const security = useApi('audit.query', { severity: 'security', limit: 50 });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const call = useCall();
  const navigate = useNavigate();
  const toast = useToast();
  const toggle = (k: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });

  const sinceMs = since ? new Date(since).getTime() : Date.now();
  const recent = (security.data?.events ?? [])
    .filter((e) => e.type !== 'panic' && new Date(e.at).getTime() >= sinceMs - 3600_000)
    .slice(0, 6);

  const resume = async () => {
    setBusy(true);
    try {
      // `system.resume` on beamhopd reconnects channels and re-arms every unpaused schedule, and an
      // agent that is not stopped answers again at once. Partial resume (JOURNEYS §8) therefore
      // parks what was NOT selected first, while everything is still stopped.
      for (const a of agents.data?.agents ?? [])
        if (!picked.has(`agent:${a.config.name}`) && a.status !== 'stopped')
          await call('agent.stop', { name: a.config.name });
      for (const s of schedules.data?.schedules ?? [])
        if (!picked.has(`schedule:${s.id}`) && s.enabled && !s.paused)
          await call('schedule.update', { id: s.id, patch: { paused: true } });
      await call('system.resume');
      for (const k of picked) {
        const [kind, id] = k.split(':') as [string, string];
        if (kind === 'agent') await call('agent.start', { name: id });
        if (kind === 'schedule') await call('schedule.update', { id, patch: { paused: false } });
      }
      announce(`Resumed. ${picked.size} selected items are running again.`, 'assertive');
      toast.show({ message: `Resumed · ${picked.size} selected`, tone: 'success' });
      void navigate({ to: '/' });
    } catch (e) {
      toast.show({ message: `Couldn't resume: ${(e as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="type-micro text-ink-2">Stopped at</p>
        <Readout tone="stop">{since ? clock(since) : '—'}</Readout>
        <p className="mt-2 type-body text-ink-2">
          {t('panic.resumeBody')} Nothing is selected until you choose.
        </p>
      </div>
      <section aria-labelledby="resume-agents">
        <Eyebrow id="resume-agents" count={agents.data?.agents.length}>
          Agents
        </Eyebrow>
        {agents.isPending ? (
          <Skeleton count={3} />
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line bg-surface px-4">
            {agents.data?.agents.map((a) => (
              <Checkbox
                key={a.config.name}
                isSelected={picked.has(`agent:${a.config.name}`)}
                onChange={(v) => toggle(`agent:${a.config.name}`, v)}
                description={`${a.config.harness} · ${a.config.sandbox.profile} · ${a.location.kind}`}
              >
                <span className="inline-flex items-center gap-2">
                  {a.config.name} <StatusDot state={agentLamp(a, { panic: a.status === 'stopped' })} />
                </span>
              </Checkbox>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="resume-schedules">
        <Eyebrow id="resume-schedules" count={schedules.data?.schedules.length}>
          Schedules
        </Eyebrow>
        <div className="divide-y divide-line rounded-lg border border-line bg-surface px-4">
          {schedules.data?.schedules.map((s) => (
            <Checkbox
              key={s.id}
              isSelected={picked.has(`schedule:${s.id}`)}
              onChange={(v) => toggle(`schedule:${s.id}`, v)}
              description={`${s.kind} · ${s.spec}`}
            >
              {s.agent} · {s.prompt.slice(0, 48)}
            </Checkbox>
          ))}
        </div>
        <p className="mt-2 type-meta text-ink-2">
          Channels reconnect when you resume. Cloud daemons follow the agents you select.
        </p>
      </section>
      <section aria-labelledby="resume-security">
        <Eyebrow id="resume-security" count={recent.length}>
          Security events since 1 h before
        </Eyebrow>
        {recent.length === 0 ? (
          <p className="type-body-sm text-ink-2">No security events in that window.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recent.map((e) => (
              <li key={e.id} className="flex gap-3">
                <StatusDot state="error" hideLabel className="mt-1" />
                <div className="min-w-0">
                  <p className="type-body-sm text-ink">{e.summary}</p>
                  <MetaLine items={[when(e.at), e.actor, e.type]} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <TextField
        label="Note for the audit log"
        description="Why you stopped, what you checked. Optional."
        multiline
        rows={3}
        value={note}
        onChange={setNote}
      />
      <Button variant="primary" size="lg" isPending={busy} onPress={() => void resume()}>
        {t('panic.resumeN', { count: picked.size })}
      </Button>
    </div>
  );
};

export const PanicScreen = () => {
  const { panic, since, loaded } = usePanicState();
  return (
    <Screen
      title={panic ? t('panic.resumeTitle') : t('panic.button')}
      back={{ href: '/', label: 'Home' }}
      maxWidth="form"
      showPanic={false}
    >
      {!loaded ? (
        <Skeleton variant="detail" count={2} />
      ) : panic ? (
        <ResumeReview since={since} />
      ) : (
        <PanicConfirm inline />
      )}
    </Screen>
  );
};
