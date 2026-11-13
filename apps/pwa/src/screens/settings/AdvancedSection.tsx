/**
 * Settings → Advanced (desktop app only; docs/desktop-ux.md §2, §7): show the command-line equivalents
 * the app hides by default, and opt in to the `beamhop` command in the terminal. Nothing is installed
 * automatically, and no shell profile is touched unless the user switches it on.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.ts';
import { type DesktopCliStatus, desktop, useShowCliPref } from '../../lib/desktop.ts';
import { announce } from '../../lib/live.ts';
import { Switch } from '../../ui/Choice.tsx';
import { Skeleton } from '../../ui/States.tsx';
import { Group } from './kit.tsx';

const CliInstall = () => {
  const d = desktop();
  const [status, setStatus] = useState<DesktopCliStatus>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    d?.cli
      .status()
      .then((s) => live && setStatus(s))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [d]);

  if (!d || status?.state === 'unsupported') return null;
  if (!status)
    return error ? (
      <p role="alert" className="type-body-sm text-stop-text">
        {t('settings.advanced.cliError', { message: error })}
      </p>
    ) : (
      <Skeleton variant="list" count={1} />
    );

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      if (on) {
        const r = await d.cli.install();
        setStatus(r.status);
        const msg =
          r.status.state === 'installed'
            ? r.status.onPath
              ? t('settings.advanced.cliInstalled')
              : t('settings.advanced.cliNewTerminal')
            : r.status.state === 'other'
              ? t('settings.advanced.cliOther', { path: r.status.path })
              : undefined;
        setNote(msg);
        if (msg) announce(msg);
      } else {
        await d.cli.uninstall();
        setStatus({ state: 'absent' });
        setNote(t('settings.advanced.cliRemoved'));
        announce(t('settings.advanced.cliRemoved'));
      }
    } catch (e) {
      setError((e as Error).message);
      announce((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const description =
    status.state === 'other'
      ? t('settings.advanced.cliUsing', { path: status.path })
      : status.state === 'installed'
        ? status.onPath
          ? t('settings.advanced.cliAt', { path: status.path })
          : t('settings.advanced.cliNewTerminal')
        : t('settings.advanced.cliLead');

  return (
    <div className="flex flex-col gap-1">
      <Switch
        isSelected={status.state === 'installed' || status.state === 'other'}
        isDisabled={busy || status.state === 'other'}
        onChange={(v) => void toggle(v)}
        description={description}
      >
        {t('settings.advanced.cliToggle')}
      </Switch>
      <div aria-live="polite">
        {note && <p className="type-body-sm text-ink-2">{note}</p>}
        {error && (
          <p role="alert" className="type-body-sm text-stop-text">
            {t('settings.advanced.cliError', { message: error })}
          </p>
        )}
      </div>
    </div>
  );
};

export const AdvancedSection = () => {
  const [showCli, setShowCli] = useShowCliPref();
  if (!desktop()) return <p className="type-body-sm text-ink-2">{t('settings.advanced.browserOnly')}</p>;
  return (
    <div className="flex flex-col gap-8">
      <Group title={t('settings.advanced.terminal')} id="adv-terminal">
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <Switch isSelected={showCli} onChange={setShowCli} description={t('settings.advanced.showCliLead')}>
            {t('settings.advanced.showCli')}
          </Switch>
          <CliInstall />
        </div>
      </Group>
    </div>
  );
};
