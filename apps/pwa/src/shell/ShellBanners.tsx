/**
 * Panic band + connection banners (SCREENS §0.2, DESIGN §10): offline, not paired yet, unpaired by
 * the daemon (hosted: "Pair again"), daemon not answering (hosted, after a request timed out), demo.
 * Reconnecting (<10 s) is the pill's job, not a banner.
 */
import { CloudSlash, DeviceMobile, Flask, LinkBreak, WifiSlash } from '@phosphor-icons/react';
import { useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useDaemons } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { useInstall } from '../lib/install.ts';
import { useExpanded } from '../lib/media.ts';
import { Button, LinkButton } from '../ui/Button.tsx';
import { Banner } from '../ui/States.tsx';
import { useConnectionSummary } from './Connection.tsx';
import { PanicBand } from './panic.tsx';

const DEMO_KEY = 'bh.demoBanner.dismissed';
const INSTALL_KEY = 'bh.install.dismissed';

const readFlag = (k: string, store: () => Storage) => {
  try {
    return store().getItem(k) === '1';
  } catch {
    return false;
  }
};

/**
 * Install hint (DESIGN §11): on a phone browser, on Home only, once until dismissed. Android gets the
 * browser's own prompt behind our button; iPhone gets the Share → Add to Home Screen instructions,
 * because iOS only sends approval alerts to installed web apps.
 */
const InstallBanner = ({ show }: { show: boolean }) => {
  const install = useInstall();
  const expanded = useExpanded();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [dismissed, setDismissed] = useState(() => readFlag(INSTALL_KEY, () => localStorage));
  if (!show || expanded || dismissed || install.installed || pathname !== '/') return null;
  if (!install.ios && !install.available) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <Banner
      tone="info"
      icon={<DeviceMobile size={18} weight="bold" />}
      action={
        install.ios ? (
          <Button variant="quiet" size="sm" onPress={dismiss}>
            {t('install.later')}
          </Button>
        ) : (
          <span className="flex items-center gap-1">
            <Button variant="quiet" size="sm" onPress={dismiss}>
              {t('install.later')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => void install.prompt().then((ok) => ok && dismiss())}
            >
              {t('install.button')}
            </Button>
          </span>
        )
      }
    >
      <strong className="font-semibold">{t('install.title')}</strong>{' '}
      {install.ios ? t('install.ios') : t('install.android')}
    </Banner>
  );
};

export const ShellBanners = () => {
  const { conn, link } = useConnectionSummary();
  const { active } = useDaemons();
  const name = active?.name ?? '';
  const [demoDismissed, setDemoDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DEMO_KEY) === '1';
    } catch {
      return false;
    }
  });
  return (
    <>
      <PanicBand />
      {link === 'offline' && (
        <Banner tone="caution" icon={<CloudSlash size={18} weight="bold" />}>
          {t('offline.banner')}
        </Banner>
      )}
      {link === 'not-paired' && (
        <Banner
          tone="info"
          icon={<DeviceMobile size={18} weight="bold" />}
          action={
            <LinkButton href="/pair" variant="secondary" size="sm">
              {t('conn.none.pair')}
            </LinkButton>
          }
        >
          {t('conn.banner.none')}
        </Banner>
      )}
      {link === 'unpaired' && (
        <Banner
          tone="stop"
          icon={<LinkBreak size={18} weight="bold" />}
          action={
            <LinkButton href="/pair" variant="secondary" size="sm">
              {t('conn.unpaired.pair')}
            </LinkButton>
          }
        >
          {t('conn.banner.unpaired', { name })}
        </Banner>
      )}
      {link === 'no-answer' && (
        <Banner tone="caution" icon={<WifiSlash size={18} weight="bold" />}>
          {t('conn.banner.noAnswer', { name })}
        </Banner>
      )}
      <InstallBanner show={conn.kind === 'nostr' || conn.kind === 'local'} />
      {conn.kind === 'mock' && conn.reason === 'no-token' && !demoDismissed && (
        <Banner
          tone="info"
          icon={<Flask size={18} weight="bold" />}
          action={
            <Button
              variant="quiet"
              size="sm"
              onPress={() => {
                setDemoDismissed(true);
                try {
                  sessionStorage.setItem(DEMO_KEY, '1');
                } catch {
                  /* ignore */
                }
              }}
            >
              {t('common.dismiss')}
            </Button>
          }
        >
          {t('demo.banner')} {t('demo.run', { cmd: 'beamhop ui' })}
        </Banner>
      )}
    </>
  );
};
