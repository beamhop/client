/**
 * Panic band + connection banners (SCREENS §0.2, DESIGN §10): offline, not paired yet, unpaired by
 * the daemon (hosted: "Pair again"), daemon not answering (hosted, after a request timed out), demo.
 * Reconnecting (<10 s) is the pill's job, not a banner.
 */
import { CloudSlash, DeviceMobile, Flask, LinkBreak, WifiSlash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useDaemons } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { Button, LinkButton } from '../ui/Button.tsx';
import { Banner } from '../ui/States.tsx';
import { useConnectionSummary } from './Connection.tsx';
import { PanicBand } from './panic.tsx';

const DEMO_KEY = 'bh.demoBanner.dismissed';

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
