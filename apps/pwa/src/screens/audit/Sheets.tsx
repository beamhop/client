/** Audit sheets: event detail, alert rules, export. */
import type { AuditEvent } from '@beamhop/core';
import { DownloadSimple, SealCheck } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useCall } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { when } from '../../lib/format.ts';
import { Button, LinkButton } from '../../ui/Button.tsx';
import { Switch } from '../../ui/Choice.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { type AlertRules, rulesCli, useAlertRules } from './alerts.ts';
import { levelOf, toCsv, toJsonl } from './model.ts';

/** Severity by shape + word: high = square, medium = notch, low = ring. */
export const LevelLamp = ({ e, className }: { e: AuditEvent; className?: string }) => {
  const l = levelOf(e);
  return (
    <StatusDot
      state={l === 'high' ? 'error' : l === 'medium' ? 'needs-you' : 'stopped'}
      label={t(`audit.level.${l}`)}
      hideLabel
      className={className ? `${className} h-5 shrink-0 self-start` : 'h-5 shrink-0 self-start'}
    />
  );
};

export const EventSheet = ({ event, onClose }: { event: AuditEvent | null; onClose: () => void }) => {
  // Keep the last event while the sheet animates out, so the dialog never loses its name.
  const [last, setLast] = useState(event);
  if (event && event !== last) setLast(event);
  const e = event ?? last;
  return (
    <Sheet
      isOpen={!!event}
      onOpenChange={(o) => !o && onClose()}
      title={e?.summary ?? ''}
      subtitle={e ? `${e.type} · ${e.id}` : undefined}
      desktop="pane"
    >
      {e && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="type-micro text-ink-2">{t('audit.ev.when')}</dt>
            <dd className="type-meta text-ink">{when(e.at)}</dd>
            <dt className="type-micro text-ink-2">{t('audit.ev.severity')}</dt>
            <dd className="flex items-center gap-2 type-meta text-ink">
              <LevelLamp e={e} /> {t(`audit.level.${levelOf(e)}`)}
            </dd>
            <dt className="type-micro text-ink-2">{t('audit.ev.actor')}</dt>
            <dd className="type-meta text-ink [overflow-wrap:anywhere]">{e.actor}</dd>
            {e.agent && (
              <>
                <dt className="type-micro text-ink-2">{t('audit.ev.agent')}</dt>
                <dd className="type-meta text-ink">{e.agent}</dd>
              </>
            )}
          </dl>
          {e.data.signed === true && (
            <p className="flex items-center gap-1.5 type-body-sm text-go-text">
              <SealCheck size={16} weight="bold" aria-hidden="true" /> {t('audit.ev.signed')}
            </p>
          )}
          <CodeBlock label={t('audit.ev.json')} code={JSON.stringify(e, null, 2)} wrap />
          <div className="flex flex-wrap gap-2">
            {typeof e.data.session === 'string' && (
              <LinkButton href={`/sessions/${e.data.session}`} variant="secondary" size="sm">
                {t('audit.sec.openSession')}
              </LinkButton>
            )}
            {e.agent && (
              <LinkButton href={`/policy/${e.agent}`} variant="quiet" size="sm">
                {t('audit.ev.policy', { agent: e.agent })}
              </LinkButton>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
};

export const AlertsSheet = ({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const { rules: saved, loaded, save, saving } = useAlertRules();
  const [r, setR] = useState<AlertRules>(saved);
  // Start every edit from the daemon's rules (and pick them up once the first read lands).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open / first load only
  useEffect(() => {
    if (isOpen) setR(saved);
  }, [isOpen, loaded]);
  const toast = useToast();
  const set = <K extends keyof AlertRules>(k: K, v: AlertRules[K]) => setR((x) => ({ ...x, [k]: v }));
  const num =
    (k: 'budgetWarn' | 'budgetAlert' | 'spikeEvents' | 'spikeMinutes' | 'heartbeatMinutes') => (v: number) =>
      Number.isFinite(v) && set(k, Math.round(v));
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (o) setR(saved);
        onOpenChange(o);
      }}
      title={t('audit.alerts.title')}
      subtitle={t('audit.alerts.subtitle')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isPending={saving}
            onPress={() =>
              void save(r).then(
                () => {
                  onOpenChange(false);
                  toast.show({ message: t('audit.alerts.saved'), tone: 'success' });
                },
                (e: Error) => toast.show({ message: e.message, tone: 'error' }),
              )
            }
          >
            {t('audit.alerts.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 type-micro text-ink-2">{t('audit.alerts.budget')}</legend>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label={t('audit.alerts.warn')}
              unit="%"
              minValue={10}
              maxValue={r.budgetAlert}
              value={r.budgetWarn}
              onChange={num('budgetWarn')}
            />
            <NumberField
              label={t('audit.alerts.alert')}
              unit="%"
              minValue={r.budgetWarn}
              maxValue={500}
              value={r.budgetAlert}
              onChange={num('budgetAlert')}
            />
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 type-micro text-ink-2">{t('audit.alerts.security')}</legend>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label={t('audit.alerts.spikeEvents')}
              unit={t('audit.alerts.events')}
              minValue={1}
              maxValue={1000}
              value={r.spikeEvents}
              onChange={num('spikeEvents')}
            />
            <NumberField
              label={t('audit.alerts.spikeWindow')}
              unit="min"
              minValue={1}
              maxValue={1440}
              value={r.spikeMinutes}
              onChange={num('spikeMinutes')}
            />
          </div>
          <p className="type-body-sm text-ink-2">
            {t('audit.alerts.spikeSentence', { events: r.spikeEvents, minutes: r.spikeMinutes })}
          </p>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 type-micro text-ink-2">{t('audit.alerts.agents')}</legend>
          <Switch isSelected={r.crash} onChange={(v) => set('crash', v)}>
            {t('audit.alerts.crash')}
          </Switch>
          <NumberField
            label={t('audit.alerts.heartbeat')}
            unit="min"
            minValue={1}
            maxValue={120}
            value={r.heartbeatMinutes}
            onChange={num('heartbeatMinutes')}
            className="max-w-xs"
          />
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 type-micro text-ink-2">{t('audit.alerts.delivery')}</legend>
          <Switch
            isSelected={r.push}
            onChange={(v) => set('push', v)}
            description={t('audit.alerts.pushDesc')}
          >
            {t('audit.alerts.push')}
          </Switch>
          <Switch
            isSelected={r.nostrDm}
            onChange={(v) => set('nostrDm', v)}
            description={t('audit.alerts.nostrDesc')}
          >
            {t('audit.alerts.nostr')}
          </Switch>
          <Switch
            isSelected={r.quietHours}
            onChange={(v) => set('quietHours', v)}
            description={t('audit.alerts.quietDesc')}
          >
            {t('audit.alerts.quiet', { start: r.quietStart, end: r.quietEnd })}
          </Switch>
        </fieldset>
        <CliStrip command={rulesCli(r)} />
      </div>
    </Sheet>
  );
};

const download = (name: string, body: string, type: string) => {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const ExportSheet = ({
  isOpen,
  onOpenChange,
  events,
  agent,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  events: AuditEvent[];
  agent?: string;
}) => {
  const call = useCall();
  const toast = useToast();
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('audit.export.title')}
      subtitle={t('audit.export.subtitle')}
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="type-micro text-ink-2">{t('audit.export.these', { count: events.length })}</h3>
          <p className="type-body-sm text-ink-2">{t('audit.export.theseBody')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<DownloadSimple size={16} aria-hidden="true" />}
              isDisabled={!events.length}
              onPress={() => {
                download(`beamhop-audit-${stamp}.jsonl`, toJsonl(events), 'application/x-ndjson');
                toast.show({ message: t('audit.export.downloaded', { count: events.length }) });
              }}
            >
              JSONL
            </Button>
            <Button
              variant="secondary"
              icon={<DownloadSimple size={16} aria-hidden="true" />}
              isDisabled={!events.length}
              onPress={() => {
                download(`beamhop-audit-${stamp}.csv`, toCsv(events), 'text/csv');
                toast.show({ message: t('audit.export.downloaded', { count: events.length }) });
              }}
            >
              CSV
            </Button>
          </div>
        </section>
        <section className="flex flex-col gap-2 border-t border-line pt-5">
          <h3 className="type-micro text-ink-2">{t('audit.export.archive')}</h3>
          <p className="type-body-sm text-ink-2">
            {agent ? t('audit.export.archiveAgent', { agent }) : t('audit.export.archiveBody')}
          </p>
          {path ? (
            <div className="flex items-center gap-2 rounded-md bg-sunken py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 type-meta text-ink [overflow-wrap:anywhere]">{path}</code>
              <CopyButton value={path} label={t('common.copy')} compact />
            </div>
          ) : (
            <Button
              variant="primary"
              className="self-start"
              isDisabled={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  const r = await call('data.export', agent ? { agent } : {});
                  setPath(r.path);
                } catch (err) {
                  toast.show({ message: (err as Error).message, tone: 'error' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t('audit.export.running') : t('audit.export.run')}
            </Button>
          )}
          <MetaLine items={[t('audit.export.retention')]} />
        </section>
        <CliStrip command={`beamhop data export${agent ? ` --agent ${agent}` : ''}`} />
      </div>
    </Sheet>
  );
};
