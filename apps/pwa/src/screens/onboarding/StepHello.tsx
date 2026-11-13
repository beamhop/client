/**
 * Onboarding 06 Hello (round trip) and 07 Next steps — JOURNEYS §1.06–07, SCREENS §11 "Step 06".
 * The agent DMs you over Nostr (`onboarding.hello`); a vertical beam line shows agent → relays → phone,
 * a pulse travels down when it's sent and back up when your reply lands (`onboarding.helloStatus`,
 * polled). Live waiting timer (Doto). After 2 min: Resend · Open in another Nostr app (npub copy) ·
 * Finish without testing. Success: "It works." with the measured round trip.
 */
import { ArrowRight, CloudArrowUp, IdentificationBadge, Plugs } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { countdown } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { UntrustedQuote } from '../../ui/Card.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { Readout } from '../../ui/Meta.tsx';
import { useReduced } from '../../ui/motion.ts';
import { ErrorState, Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { markDone, markSkipped, SETUP_STEPS, STEP_LABEL, useSetupProgress } from './progress.ts';
import { StepFrame, useGoStep } from './StepFrame.tsx';

const STILL_WAITING_MS = 120_000;

/** Vertical beam line: agent ── relays ── phone, with a pulse down (sent) and up (reply). */
const VerticalBeam = ({
  agent,
  relays,
  up,
  phase,
  waitingFor,
}: {
  agent: string;
  relays: string[];
  up: string[];
  phase: 'sending' | 'waiting' | 'done';
  waitingFor?: string;
}) => {
  const reduce = useReduced();
  const travelling = phase !== 'sending' && !reduce;
  return (
    <div
      role="img"
      aria-label={`${t('setup.hello.route', { agent: agent ?? '', relays: relays.length })} ${phase === 'done' ? t('setup.hello.replyReceived') : phase === 'waiting' ? t('setup.hello.messageDeliveredToThe') : t('setup.hello.sending')}`}
      className="relative pl-1"
    >
      <span aria-hidden="true" className="absolute top-3 bottom-3 left-[13px] w-px bg-line-strong" />
      {travelling && (
        <motion.span
          aria-hidden="true"
          key={phase}
          className="absolute left-[12px] h-4 w-[3px] bg-flare"
          initial={{ top: phase === 'done' ? '90%' : '6%', opacity: 1 }}
          animate={{ top: phase === 'done' ? '6%' : '90%', opacity: [1, 1, 0] }}
          transition={{ duration: 0.9, ease: 'linear' }}
        />
      )}
      <ol aria-hidden="true" className="relative flex flex-col gap-3">
        <li className="flex min-h-9 items-center gap-3">
          <span
            className={cx(
              'size-[18px] rounded-full border-[1.5px] border-ink',
              phase === 'done' ? 'bg-flare' : 'bg-surface',
            )}
          />
          <span className="type-title-3 text-ink">{agent}</span>
          <span className="type-meta text-ink-2">agent</span>
        </li>
        {relays.map((r) => {
          const ok = up.includes(r);
          return (
            <li key={r} className="flex min-h-8 items-center gap-3 pl-[3px]">
              <span className={cx('size-3 rounded-full', ok ? 'bg-ink' : 'bg-stop')} />
              <span className="min-w-0 flex-1 truncate type-meta text-ink">
                {r.replace(/^wss?:\/\//, '')}
              </span>
              <span className={cx('type-meta', ok ? 'text-go-text' : 'text-stop-text')}>
                {ok
                  ? phase === 'sending'
                    ? 'connecting'
                    : t('setup.hello.relayed')
                  : t('setup.hello.offline')}
              </span>
            </li>
          );
        })}
        <li className="flex min-h-9 items-center gap-3">
          <span
            className={cx(
              'size-[18px] border-[1.5px] border-ink',
              phase === 'done' ? 'bg-ink' : 'bg-surface',
            )}
          />
          <span className="flex-1 type-title-3 text-ink">{t('setup.hello.yourPhone')}</span>
          {phase === 'done' ? (
            <StatusDot state="ready" label="replied" />
          ) : (
            <StatusDot state="needs-you" label={waitingFor ?? 'waiting'} />
          )}
        </li>
      </ol>
    </div>
  );
};

export const NextSteps = ({ agent }: { agent?: string }) => (
  <nav aria-label={t('setup.hello.nextSteps')}>
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {[
        {
          href: '/channels/add',
          icon: Plugs,
          title: t('setup.hello.addTelegramSlackOr'),
          slug: t('setup.hello.letPeopleReachYour'),
        },
        {
          href: '/settings/identity',
          icon: IdentificationBadge,
          title: t('setup.hello.setUpANip'),
          slug: t('setup.hello.reviewerExampleComInstead'),
        },
        {
          href: agent ? `/deploy/new?agent=${agent}` : '/deploy/new',
          icon: CloudArrowUp,
          title: agent ? `Move ${agent} to the cloud` : t('setup.hello.runAnAgentIn'),
          slug: t('setup.hello.answersWhileThisComputer'),
        },
      ].map((r) => (
        <li key={r.href}>
          <Link
            href={r.href}
            className="flex min-h-16 items-center gap-3 px-4 py-3 outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
          >
            <r.icon size={22} aria-hidden="true" className="shrink-0 text-ink-2" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="type-title-3 text-ink">{r.title}</span>
              <span className="type-meta text-ink-2">{r.slug}</span>
            </span>
            <ArrowRight size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
          </Link>
        </li>
      ))}
    </ul>
  </nav>
);

export const StepHello = () => {
  const [progress, update] = useSetupProgress();
  const go = useGoStep();
  const navigate = useNavigate();
  const now = useNow(1000);
  const agents = useApi('agent.list');
  const channels = useApi('channel.list');
  const agent = progress.agent ?? agents.data?.agents[0]?.config.name;
  const agentView = agents.data?.agents.find((a) => a.config.name === agent);
  const hello = useMutationApi('onboarding.hello');
  const [sentOnce, setSentOnce] = useState(false);
  const status = useApi(
    'onboarding.helloStatus',
    { agent: agent ?? '' },
    {
      enabled: !!agent && sentOnce,
      refetchInterval: (q) => (q.state.data?.replied ? false : 1500),
    },
  );
  const announced = useRef(false);

  // Send the hello once when the step opens (resend is explicit).
  useEffect(() => {
    if (!agent || sentOnce) return;
    setSentOnce(true);
    hello.mutate({ agent });
  }, [agent, sentOnce, hello]);

  const st = status.data;
  const replied = !!st?.replied;
  const sentAt = st?.sentAt
    ? new Date(st.sentAt).getTime()
    : hello.data
      ? new Date(hello.data.sentAt).getTime()
      : undefined;
  const elapsed = sentAt ? now - sentAt : 0;
  const rtt =
    st?.repliedAt && st.sentAt ? new Date(st.repliedAt).getTime() - new Date(st.sentAt).getTime() : undefined;
  const nostr = channels.data?.channels.find((c) => c.config.provider === 'nostr');
  const relays = (nostr?.config.settings.relays as string[] | undefined) ?? [];
  const up = (nostr?.config.settings.relaysUp as string[] | undefined) ?? relays;
  const shownRelays = relays.slice(0, 3);
  const upCount = shownRelays.filter((r) => up.includes(r)).length;

  useEffect(() => {
    if (replied && !announced.current) {
      announced.current = true;
      haptic('confirm');
      announce(`It works. Round trip in ${((rtt ?? 0) / 1000).toFixed(1)} seconds.`);
      update((p) => markDone(p, 'hello', rtt !== undefined ? { helloMs: rtt } : {}));
    }
  }, [replied, rtt, update]);

  if (!agents.isPending && !agent)
    return (
      <StepFrame
        step="hello"
        title={t('setup.hello.sayHelloFromYour')}
        lede="There's no agent to say hello yet."
        primary={{ label: t('setup.hello.createAnAgent'), onPress: () => go('agent') }}
        skip={{ label: t('setup.hello.finishSetup'), onPress: () => go('next') }}
      >
        <p className="type-body-sm text-ink-2">{t('setup.hello.step05CreatesOne')}</p>
      </StepFrame>
    );

  return (
    <StepFrame
      step="hello"
      title={replied ? t('setup.hello.itWorks') : t('setup.hello.sayHelloFromYour')}
      lede={
        replied
          ? `Your phone → ${upCount} relays → ${agent} → back, in ${((rtt ?? 0) / 1000).toFixed(1)} s.`
          : `${agent} just sent you a Nostr DM. Reply to it on your phone with anything.`
      }
      cli={`beamhop hello ${agent ?? ''}`}
      primary={
        replied ? { label: t('setup.hello.goToHome'), onPress: () => void navigate({ to: '/' }) } : undefined
      }
      skip={
        replied
          ? undefined
          : {
              label: t('setup.hello.finishWithoutTesting'),
              onPress: () => {
                update((p) => markSkipped(p, 'hello'));
                go('next');
              },
            }
      }
    >
      {hello.isError ? (
        <ErrorState
          title={t('setup.hello.couldnTSendThe')}
          details={hello.error}
          onRetry={() => agent && hello.mutate({ agent })}
        >
          {hello.error.message} {t('setup.hello.checkNetwork')}
        </ErrorState>
      ) : !agent || !channels.data ? (
        <Skeleton variant="detail" count={2} label={t('setup.hello.preparing')} />
      ) : (
        <>
          {upCount === 0 && (
            <ErrorState title={t('setup.hello.noRelayIsReachable')}>
              {t('setup.hello.checkYourNetworkOr')}
            </ErrorState>
          )}
          <VerticalBeam
            agent={agent}
            relays={shownRelays}
            up={up}
            phase={replied ? 'done' : hello.isSuccess || st?.sent ? 'waiting' : 'sending'}
          />
          {replied ? (
            <>
              {st?.text && (
                <UntrustedQuote
                  label={t('setup.hello.replied', { from: st.from ?? t('setup.hello.yourPhone') })}
                >
                  {st.text}
                </UntrustedQuote>
              )}
              <h2 className="type-micro text-ink-2">{t('setup.hello.next')}</h2>
              <NextSteps agent={agent} />
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <div
                className="flex items-baseline gap-3"
                role="timer"
                aria-label={t('setup.hello.waitingSeconds', { s: Math.floor(elapsed / 1000) })}
              >
                <span className="type-body-sm text-ink-2">{t('setup.hello.waitingForYourReply')}</span>
                <Readout size="md" tone={elapsed > STILL_WAITING_MS ? 'caution' : 'ink'}>
                  {countdown(elapsed)}
                </Readout>
              </div>
              {elapsed > STILL_WAITING_MS && (
                <p className="type-body-sm text-ink" role="status">
                  {t('setup.hello.stillWaitingDidThe')}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  isPending={hello.isPending}
                  onPress={() => agent && hello.mutate({ agent })}
                >
                  {t('setup.hello.resend')}
                </Button>
                {agentView?.config.identity.npub && (
                  <CopyButton
                    value={agentView.config.identity.npub}
                    label={t('setup.hello.copyNpub', { agent })}
                  />
                )}
              </div>
              <p className="type-body-sm text-ink-2">{t('setup.hello.noPhone', { agent })}</p>
            </div>
          )}
        </>
      )}
    </StepFrame>
  );
};

export const StepNext = () => {
  const [progress] = useSetupProgress();
  const navigate = useNavigate();
  const go = useGoStep();
  const skipped = SETUP_STEPS.filter((s) => progress.skipped.includes(s));
  return (
    <StepFrame
      step="next"
      title={t('setup.hello.youReSetUp')}
      lede={
        progress.helloMs
          ? `Round trip verified in ${(progress.helloMs / 1000).toFixed(1)} s. Here's what usually comes next.`
          : t('setup.hello.hereSWhatUsually')
      }
      primary={{ label: t('setup.hello.goToHome'), onPress: () => void navigate({ to: '/' }) }}
    >
      {skipped.length > 0 && (
        <section aria-labelledby="setup-skipped" className="flex flex-col gap-2">
          <h2 id="setup-skipped" className="type-micro text-ink-2">
            {t('setup.hello.skipped', { count: skipped.length })}
          </h2>
          <div className="flex flex-wrap gap-2">
            {skipped.map((s) => (
              <Button key={s} variant="secondary" size="sm" onPress={() => go(s)}>
                {t('setup.hello.finish', { step: STEP_LABEL[s] })}
              </Button>
            ))}
          </div>
        </section>
      )}
      <NextSteps agent={progress.agent} />
    </StepFrame>
  );
};
