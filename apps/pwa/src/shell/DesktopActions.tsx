/**
 * Buttons that replace "run `beamhop …`" messages in the desktop app (docs/desktop-ux.md §3): restart the
 * daemon the app supervises, open its log. Render nothing outside the desktop app.
 */
import { ArrowClockwise, FileText } from '@phosphor-icons/react';
import { useState } from 'react';
import { t } from '../i18n/index.ts';
import { desktop } from '../lib/desktop.ts';
import { announce } from '../lib/live.ts';
import { Button, type ButtonProps } from '../ui/Button.tsx';

export const RestartBeamhopButton = ({
  onDone,
  variant = 'primary',
  size = 'sm',
  className,
}: {
  /** After the daemon restarted. Default: reload the page (it reconnects with a fresh token). */
  onDone?: () => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const d = desktop();
  if (!d) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        size={size}
        className={className}
        isPending={busy}
        icon={<ArrowClockwise size={16} aria-hidden="true" />}
        onPress={async () => {
          setBusy(true);
          setError(undefined);
          announce(t('desktop.restarting'));
          try {
            await d.daemon.restart();
            announce(t('desktop.restarted'));
            if (onDone) onDone();
            else window.location.reload();
          } catch (e) {
            const msg = t('desktop.restartFailed', { message: (e as Error).message });
            setError(msg);
            announce(msg);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('desktop.restart')}
      </Button>
      {error && (
        <span role="alert" className="type-meta text-stop-text">
          {error}
        </span>
      )}
    </span>
  );
};

export const OpenLogButton = ({ className }: { className?: string }) => {
  const d = desktop();
  if (!d) return null;
  return (
    <Button
      variant="quiet"
      size="sm"
      className={className}
      icon={<FileText size={16} aria-hidden="true" />}
      onPress={() => void d.daemon.openLog().catch(() => announce(t('desktop.openLogFailed')))}
    >
      {t('desktop.openLog')}
    </Button>
  );
};
