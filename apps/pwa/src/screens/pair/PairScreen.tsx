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
 * Payload + safety phrase: shared `@beamhop/channel-nostr/pairing` (words from daemon + device pubkeys).
 * The final "Yes, pair" happens on the computer (device.pairConfirm); the phone only sends the request.
 */

import { completePairing } from '@beamhop/channel-nostr/pairing';
import type { DeviceView } from '@beamhop/core';
import {
  ArrowRight,
  Bell,
  Check,
  DeviceMobile,
  Export,
  PaperPlaneTilt,
  PlusSquare,
  X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useBeamhop, useCall } from '../../api/index.ts';
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
import { StatusDot } from '../../ui/Status.tsx';
import { Stepper } from '../../ui/Stepper.tsx';
import { deviceNameFromUA, newDeviceKey, rememberDeviceId, saveDeviceKey } from './deviceKey.ts';
import { SafetyPhrase } from './PairingPanel.tsx';
import { requestPush, useInstallPrompt, usePushEnv } from './push.tsx';
import { formatPairCode, type PairingPayload, tryDecodePayload, tryPhrase } from './safetyPhrase.ts';

type Phase = 'enter' | 'invalid' | 'compare' | 'confirm' | 'cancelled' | 'done';

const readToken = () => {
  if (typeof window === 'undefined') return '';
  const h = window.location.hash.replace(/^#/, '');
  return h && !h.includes('=') ? h : '';
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
          spellCheck="false"
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

// ─────────── 2 · compare + send ───────────
interface Target {
  /** From the QR link: daemon key, relays, code, computer name, expiry. */
  payload?: PairingPayload;
  /** Manual code entry (needs a direct connection to the daemon: the local PWA, or the demo). */
  code?: string;
}

const Compare = ({
  target,
  onSent,
  onCancel,
}: {
  target: Target;
  onSent: (d: DeviceView, words: string[] | undefined) => void;
  onCancel: () => void;
}) => {
  const key = useMemo(newDeviceKey, []);
  const { mock } = useBeamhop();
  const identity = useApi('identity.get', undefined, { enabled: !target.payload });
  const daemon = target.payload?.daemon ?? identity.data?.daemonNpub;
  const words = useMemo(() => tryPhrase(daemon, key.pubkey), [daemon, key.pubkey]);
  const [name, setName] = useState(deviceNameFromUA);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const call = useCall();
  const computer = target.payload?.name;
  const expired = !!target.payload?.exp && target.payload.exp * 1000 < Date.now();

  const send = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveDeviceKey(key);
      const code = target.payload?.code ?? target.code ?? '';
      let device: DeviceView;
      if (target.payload && !mock) {
        // Hosted PWA: reach the daemon over its relays, signed with the new device key.
        device = (await completePairing(target.payload, key.secretKey, { name: name.trim() })).device;
      } else {
        device = await call('device.pairComplete', { code, pubkey: key.npub, name: name.trim() });
      }
      rememberDeviceId(device.id);
      haptic('confirm');
      onSent(device, words);
    } catch (e) {
      haptic('error');
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  if (expired)
    return (
      <>
        <div className="flex flex-col gap-2">
          <h1 className="type-title-1 text-ink">{t('pair.expired.title')}</h1>
          <p className="type-body text-ink-2">{t('pair.expired.body')}</p>
        </div>
        <Button variant="primary" size="lg" fullWidth onPress={onCancel}>
          {t('pair.cancelled.again')}
        </Button>
      </>
    );

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="type-title-1 text-ink">
          {computer ? t('pair.compare.titleNamed', { name: computer }) : t('pair.compare.title')}
        </h1>
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
        <ErrorState title={t('pair.error.title')} details={error} onRetry={() => void send()}>
          {error.message} {t('pair.error.body')}
        </ErrorState>
      )}
      <TicketCard
        eyebrow={t('pair.phrase.eyebrow')}
        decision={
          <div className="flex flex-col gap-1">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              icon={<PaperPlaneTilt size={18} weight="bold" aria-hidden="true" />}
              isPending={busy}
              isDisabled={!words || !name.trim()}
              onPress={() => void send()}
            >
              {t('pair.compare.send')}
            </Button>
            <Button variant="quiet" fullWidth onPress={onCancel}>
              {t('pair.compare.notMine')}
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

// ─────────── 2b · confirm on the computer ───────────
const ConfirmThere = ({
  device,
  words,
  onContinue,
  onMismatch,
}: {
  device: DeviceView;
  words?: string[];
  onContinue: () => void;
  onMismatch: () => void;
}) => (
  <>
    <div className="flex flex-col gap-2">
      <h1 className="type-title-1 text-ink">{t('pair.confirm.title')}</h1>
      <p className="type-body text-ink-2">{t('pair.confirm.body', { name: device.name })}</p>
    </div>
    <TicketCard
      eyebrow={t('pair.phrase.eyebrow')}
      tag={<StatusDot state="needs-you" label={t('pair.confirm.waiting')} />}
      decision={
        <div className="grid gap-2 medium:grid-cols-2 medium:[&>*:first-child]:order-2">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            icon={<ArrowRight size={18} weight="bold" aria-hidden="true" />}
            onPress={onContinue}
          >
            {t('pair.confirm.continue')}
          </Button>
          <Button
            variant="deny"
            size="lg"
            fullWidth
            icon={<X size={18} weight="bold" aria-hidden="true" />}
            onPress={onMismatch}
          >
            {t('pair.confirm.mismatch')}
          </Button>
        </div>
      }
    >
      <SafetyPhrase words={words} size="lg" />
    </TicketCard>
  </>
);

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
  const initial = useMemo(readToken, []);
  const [target, setTarget] = useState<Target | null>(() => {
    const payload = tryDecodePayload(initial);
    return payload ? { payload } : null;
  });
  const [phase, setPhase] = useState<Phase>(target ? 'compare' : initial ? 'invalid' : 'enter');
  const [sent, setSent] = useState<{ device: DeviceView; words?: string[] }>();

  // The fragment carries a one-time secret: drop it from the address bar (and history) once read.
  useEffect(() => {
    if (initial && typeof history !== 'undefined')
      history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }, [initial]);

  const restart = () => {
    setTarget(null);
    setPhase('enter');
  };

  if (phase === 'done' && sent) return <AfterPair device={sent.device} />;

  return (
    <Frame step={0}>
      {phase === 'invalid' && <Banner tone="caution">{t('pair.invalid')}</Banner>}
      {(phase === 'enter' || phase === 'invalid') && (
        <EnterCode
          onCode={(code) => {
            setTarget({ code });
            setPhase('compare');
          }}
        />
      )}
      {phase === 'compare' && target && (
        <Compare
          target={target}
          onSent={(device, words) => {
            setSent({ device, words });
            announce(t('pair.confirm.title'));
            setPhase('confirm');
          }}
          onCancel={restart}
        />
      )}
      {phase === 'confirm' && sent && (
        <ConfirmThere
          device={sent.device}
          words={sent.words}
          onContinue={() => setPhase('done')}
          onMismatch={() => {
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
          <Button variant="primary" size="lg" fullWidth onPress={restart}>
            {t('pair.cancelled.again')}
          </Button>
        </>
      )}
    </Frame>
  );
};
