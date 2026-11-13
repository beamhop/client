/**
 * /pair — the PHONE side of device pairing (JOURNEYS §9, §1.04; SCREENS §0.1). Bare chrome.
 *
 * Flow: open the link from the computer's QR (`/pair#<one-time token>`) or type the 8-char code →
 * name this device (prefilled from the user agent) → compare the 4-word safety phrase with the computer
 * → `They match · Pair` (device key generated here, only the public key leaves) → install (iOS
 * instructions / Android prompt) → notifications after a purpose pre-prompt → open beamhop.
 *
 * Research used:
 * - Linked-device QR phishing (confirm a short authentication string, name the device, make removal easy):
 *   https://attack.mitre.org/techniques/T1676 ; Signal on comparing one value instead of two and
 *   pitfalls of echoing it back: https://signal.org/blog/safety-number-updates/
 * - WCAG 3.3.8 Accessible Authentication: a match check, never recall; paste allowed for the code.
 * - iOS web push needs the installed app (16.4+) and a user gesture; no beforeinstallprompt on iOS:
 *   https://developer.mozilla.org/en-US/docs/Web/Progressive_Web_Apps/Add_to_home_screen
 * Safety phrase: local derivation (`safetyPhrase.ts`), TODO switch to packages/channel-nostr pairing.ts.
 */
import type { DeviceView } from '@beamhop/core';
import { ArrowRight, Bell, Check, DeviceMobile, Export, PlusSquare, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { useCall } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { Wordmark } from '../../shell/Wordmark.tsx';
import { Button, LinkButton } from '../../ui/Button.tsx';
import { TicketCard } from '../../ui/Card.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Eyebrow } from '../../ui/Meta.tsx';
import { Banner, ErrorState } from '../../ui/States.tsx';
import { Stepper } from '../../ui/Stepper.tsx';
import { createDeviceKey, deviceNameFromUA, rememberDeviceId } from './deviceKey.ts';
import { SafetyPhrase } from './PairingPanel.tsx';
import { requestPush, useInstallPrompt, usePushEnv } from './push.tsx';
import { formatPairCode, useSafetyPhrase } from './safetyPhrase.ts';

type Phase = 'enter' | 'compare' | 'cancelled' | 'done';

const readToken = () => {
  if (typeof window === 'undefined') return '';
  const h = window.location.hash.replace(/^#/, '');
  return h && !h.includes('=') ? decodeURIComponent(h) : '';
};

const Frame = ({ step, children }: { step: number; children: React.ReactNode }) => (
  <div
    className="mx-auto flex min-h-svh w-full max-w-[560px] flex-col gap-6 px-gutter pt-[calc(var(--bh-safe-top)+20px)] pb-[calc(var(--bh-safe-bottom)+32px)]"
    id="bh-main-content"
  >
    <div className="flex items-center justify-between gap-3">
      <Wordmark />
      <span className="type-meta text-ink-2">{t('pair.eyebrow')}</span>
    </div>
    <Stepper steps={[t('pair.step.compare'), t('pair.step.install'), t('pair.step.alerts')]} current={step} />
    {children}
  </div>
);

// ─────────── 1 · enter code ───────────
const EnterCode = ({ onCode }: { onCode: (code: string) => void }) => {
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const code = formatPairCode(raw);
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="type-title-1 text-ink">{t('pair.enter.title')}</h1>
        <p className="type-body text-ink-2">{t('pair.enter.body')}</p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (code) onCode(code);
          else haptic('error');
        }}
      >
        <TextField
          label={t('pair.enter.label')}
          value={raw}
          onChange={(v) => setRaw(v.toUpperCase())}
          onBlur={() => setTouched(true)}
          mono
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="AMBR-RLY8"
          description={t('pair.enter.hint')}
          isInvalid={touched && raw.length > 0 && !code}
          errorMessage={t('pair.enter.invalid')}
        />
        <Button type="submit" variant="primary" size="lg" fullWidth>
          {t('pair.enter.submit')}
        </Button>
      </form>
      <section
        aria-labelledby="pair-where"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="pair-where" className="type-micro text-ink-2">
          {t('pair.where.title')}
        </h2>
        <p className="type-body-sm text-ink">{t('pair.where.body')}</p>
        <code className="self-start rounded-sm bg-sunken px-2 py-1 type-meta text-ink">
          beamhop pair-device
        </code>
      </section>
    </>
  );
};

// ─────────── 2 · compare ───────────
const Compare = ({
  secret,
  onPaired,
  onCancel,
}: {
  secret: string;
  onPaired: (d: DeviceView) => void;
  onCancel: () => void;
}) => {
  const words = useSafetyPhrase(secret);
  const [name, setName] = useState(deviceNameFromUA);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const call = useCall();

  const pair = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const pubkey = await createDeviceKey();
      const d = await call('device.pairComplete', { code: secret, pubkey, name: name.trim() });
      rememberDeviceId(d.id);
      haptic('confirm');
      announce(t('pair.done.title', { name: d.name }));
      onPaired(d);
    } catch (e) {
      haptic('error');
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="type-title-1 text-ink">{t('pair.compare.title')}</h1>
        <p className="type-body text-ink-2">{t('pair.compare.body')}</p>
      </div>
      <TextField
        label={t('pair.name.label')}
        value={name}
        onChange={setName}
        description={t('pair.name.hint')}
        isRequired
        isInvalid={!name.trim()}
        errorMessage={t('pair.name.required')}
      />
      {error && (
        <ErrorState title={t('pair.error.title')} details={error} onRetry={() => void pair()}>
          {error.message} {t('pair.error.body')}
        </ErrorState>
      )}
      <TicketCard
        eyebrow={t('pair.phrase.eyebrow')}
        decision={
          <div className="flex flex-col gap-2 medium:flex-row-reverse">
            <Button
              variant="allow"
              size="lg"
              fullWidth
              icon={<Check size={18} weight="bold" aria-hidden="true" />}
              isPending={busy}
              isDisabled={!words || !name.trim()}
              onPress={() => void pair()}
            >
              {t('pair.compare.yes')}
            </Button>
            <Button
              variant="deny"
              size="lg"
              fullWidth
              icon={<X size={18} weight="bold" aria-hidden="true" />}
              onPress={onCancel}
            >
              {t('pair.compare.no')}
            </Button>
          </div>
        }
      >
        <SafetyPhrase words={words} size="lg" />
        <p className="mt-3 type-body-sm text-ink-2">{t('pair.phrase.hint')}</p>
      </TicketCard>
    </>
  );
};

// ─────────── 3 · install + push ───────────
const AfterPair = ({ device }: { device: DeviceView }) => {
  const [env, refresh] = usePushEnv();
  const install = useInstallPrompt();
  const call = useCall();
  const [pushState, setPushState] = useState<'idle' | 'busy' | 'on' | 'denied' | 'later'>(
    env.permission === 'granted' ? 'on' : 'idle',
  );
  const step = env.standalone || !env.ios ? 2 : 1;

  const turnOn = async () => {
    setPushState('busy');
    const r = await requestPush();
    refresh();
    if (r.permission === 'granted') {
      try {
        await call('device.pushSubscribe', { id: device.id, subscription: r.subscription });
      } catch {
        /* the daemon will ask again next time */
      }
      haptic('confirm');
      setPushState('on');
      announce(t('pair.push.on'));
    } else setPushState(r.permission === 'denied' ? 'denied' : 'idle');
  };

  return (
    <Frame step={step}>
      <div className="flex items-start gap-3">
        <span className="mt-1 grid size-10 shrink-0 place-items-center rounded-md bg-go-wash text-go-text">
          <Check size={22} weight="bold" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="type-title-1 text-ink">{t('pair.done.title', { name: device.name })}</h1>
          <p className="mt-1 type-body text-ink-2">{t('pair.done.body')}</p>
        </div>
      </div>

      {!env.standalone && (
        <section aria-labelledby="pair-install" className="flex flex-col gap-3">
          <Eyebrow id="pair-install">{t('pair.install.eyebrow')}</Eyebrow>
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="type-title-3 text-ink">{t('pair.install.title')}</h2>
            <p className="mt-1 type-body-sm text-ink-2">
              {env.ios ? t('pair.install.why.ios') : t('pair.install.why')}
            </p>
            {env.ios ? (
              <ol className="mt-3 flex flex-col gap-2 type-body-sm text-ink">
                <li className="flex items-center gap-2">
                  <span className="type-micro text-ink-3">1</span> {t('pair.install.ios1')}
                  <Export size={18} aria-label="Share" className="text-ink" />
                </li>
                <li className="flex items-center gap-2">
                  <span className="type-micro text-ink-3">2</span> {t('pair.install.ios2')}
                  <PlusSquare size={18} aria-hidden="true" className="text-ink" />
                </li>
              </ol>
            ) : install.available ? (
              <Button
                variant="secondary"
                className="mt-3"
                icon={<DeviceMobile size={16} aria-hidden="true" />}
                onPress={() => void install.prompt()}
              >
                {t('pair.install.button')}
              </Button>
            ) : (
              <p className="mt-2 type-meta text-ink-2">{t('pair.install.menu')}</p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="pair-push" className="flex flex-col gap-3">
        <Eyebrow id="pair-push">{t('pair.push.eyebrow')}</Eyebrow>
        <div
          className={cx(
            'rounded-lg border border-line p-4',
            pushState === 'on' ? 'bg-go-wash' : 'bg-surface',
          )}
        >
          <h2 className="flex items-center gap-2 type-title-3 text-ink">
            <Bell size={20} aria-hidden="true" />
            {pushState === 'on' ? t('pair.push.on') : t('pair.push.title')}
          </h2>
          {pushState !== 'on' && <p className="mt-1 type-body-sm text-ink-2">{t('pair.push.body')}</p>}
          {env.needsInstall ? (
            <p className="mt-3 type-body-sm text-caution-text">{t('pair.push.needsInstall')}</p>
          ) : env.permission === 'unsupported' ? (
            <p className="mt-3 type-body-sm text-ink-2">{t('pair.push.unsupported')}</p>
          ) : pushState === 'denied' || env.permission === 'denied' ? (
            <p className="mt-3 type-body-sm text-ink-2">{t('pair.push.denied')}</p>
          ) : pushState === 'on' ? null : pushState === 'later' ? (
            <p className="mt-3 type-body-sm text-ink-2">{t('pair.push.later')}</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" isPending={pushState === 'busy'} onPress={() => void turnOn()}>
                {t('pair.push.button')}
              </Button>
              <Button variant="quiet" onPress={() => setPushState('later')}>
                {t('pair.push.notNow')}
              </Button>
            </div>
          )}
        </div>
      </section>

      <LinkButton
        href="/"
        variant="primary"
        size="lg"
        fullWidth
        icon={<ArrowRight size={18} weight="bold" aria-hidden="true" />}
      >
        {t('pair.open')}
      </LinkButton>
    </Frame>
  );
};

export const PairScreen = () => {
  const initialToken = useMemo(readToken, []);
  const [secret, setSecret] = useState(initialToken);
  const [phase, setPhase] = useState<Phase>(initialToken ? 'compare' : 'enter');
  const [device, setDevice] = useState<DeviceView>();

  // The token is a one-time secret: drop it from the address bar (and history) once read.
  useEffect(() => {
    if (initialToken && typeof history !== 'undefined')
      history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }, [initialToken]);

  if (phase === 'done' && device) return <AfterPair device={device} />;

  return (
    <Frame step={0}>
      {phase === 'enter' && (
        <EnterCode
          onCode={(c) => {
            setSecret(c);
            setPhase('compare');
          }}
        />
      )}
      {phase === 'compare' && (
        <Compare
          secret={secret}
          onPaired={(d) => {
            setDevice(d);
            setPhase('done');
          }}
          onCancel={() => {
            haptic('reject');
            announce(t('pair.cancelled.title'));
            setPhase('cancelled');
          }}
        />
      )}
      {phase === 'cancelled' && (
        <>
          <Banner tone="caution">{t('pair.cancelled.banner')}</Banner>
          <div className="flex flex-col gap-2">
            <h1 className="type-title-1 text-ink">{t('pair.cancelled.title')}</h1>
            <p className="type-body text-ink-2">{t('pair.cancelled.body')}</p>
          </div>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onPress={() => {
              setSecret('');
              setPhase('enter');
            }}
          >
            {t('pair.cancelled.again')}
          </Button>
        </>
      )}
    </Frame>
  );
};
