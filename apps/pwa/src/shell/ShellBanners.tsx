/** Panic band + offline / demo banners (SCREENS §0.2, §12). */
import { CloudSlash, Flask } from '@phosphor-icons/react';
import { useState } from 'react';
import { useConnection } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { Button } from '../ui/Button.tsx';
import { Banner } from '../ui/States.tsx';
import { PanicBand } from './panic.tsx';

const DEMO_KEY = 'bh.demoBanner.dismissed';

export const ShellBanners = () => {
  const conn = useConnection();
  const [demoDismissed, setDemoDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DEMO_KEY) === '1';
    } catch {
      return false;
    }
  });
  const offline = !conn.online || conn.status === 'closed';
  return (
    <>
      <PanicBand />
      {offline && (
        <Banner tone="caution" icon={<CloudSlash size={18} weight="bold" />}>
          <strong className="font-semibold">Offline.</strong> {t('offline.banner').replace(/^Offline\.\s*/, '')}
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
              Dismiss
            </Button>
          }
        >
          {t('demo.banner')} Run <code className="font-mono text-[0.875em]">beamhop ui</code> to connect yours.
        </Banner>
      )}
    </>
  );
};
