/**
 * Channel wizard — SCREENS §5 "Wizard step", JOURNEYS §4 (Telegram / Slack / Discord / Nostr group).
 * Route: /channels/add/$provider/$step. The step list comes from `channel.providers` (normalizeSteps);
 * Validate and Connect resolve in place on Credentials and fill their stepper nodes on their own.
 *
 * Fool-proofing and resumability:
 * - Every step is a URL; non-secret progress is saved per provider (draft.ts), so leaving for
 *   BotFather / Slack / the Discord portal — or the PWA being killed by the OS — loses nothing but
 *   an un-submitted token (secrets are never written to storage).
 * - The first provider deep link is the primary action until it has been opened; then Continue is.
 * - Live shape check → live `channel.validate` (shows the bot's identity) → one deliberate
 *   "Connect @bot" press (widening access is deliberate, DESIGN §2) → nodes 03/04 fill → auto-advance
 *   only while focus is still inside the step (WCAG 3.2.2), otherwise a visible Continue waits.
 * - On return from a provider tab (`visibilitychange`), focus goes to the next empty field and a
 *   one-tap "Paste token" is offered (clipboard read only on press, never silently).
 * - Slack: a token pasted into the wrong field is recognised by prefix and can be moved.
 * - Pairing never needs typing: Telegram deep link + QR (WCAG 3.3.8); the owner confirms the paired
 *   account ("This is me" / "Not me — unpair") so a code leak can't silently add an owner.
 *
 * Research used (beyond JOURNEYS §4's sources):
 * - Slack prefilled manifest link `api.slack.com/apps?new_app=1&manifest_json=…` and `socket_mode_enabled`
 *   (docs.slack.dev/app-manifests/configuring-apps-with-app-manifests, api.slack.com/reference/manifests).
 * - Save-and-resume wizards: create the draft on the first screen, track current vs completed steps, make
 *   resuming discoverable (appmaster.io/blog/save-and-resume-multi-step-wizard; dataanddesign.substack.com
 *   "Wizards may be an ancient design pattern"); announce progress politely (ezud.com accessible wizards).
 * - Discord: a bot token's first segment is the base64 bot user id (= application/client id), used to
 *   build the invite link without asking for the id again (WCAG 3.3.7 Redundant Entry).
 */
import type { ChannelView, Params } from '@beamhop/core';
import { ArrowLeft, ArrowRight, ClipboardText, Info, LockSimple, WarningCircle } from '@phosphor-icons/react';
import { Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Disclosure, DisclosurePanel, Heading, Button as RACButton } from 'react-aria-components';
import { createPortal } from 'react-dom';
import { useApi, useCall, useConnection } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useExpanded } from '../../lib/media.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';
import { Checkbox, Radio, RadioGroup, Switch } from '../../ui/Choice.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { SecretField, TextField } from '../../ui/Field.tsx';
import { Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { Banner, ErrorState } from '../../ui/States.tsx';
import { Stepper } from '../../ui/Stepper.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { type ChannelDraft, readDraft, useDraft } from './draft.ts';
import { PairPanel } from './PairPanel.tsx';
import { ExternalButton, IdentityCard, ScriptStep, StepHeading, WaitingLine } from './parts.tsx';
import {
  AUTO_STEPS,
  BOTFATHER_URL,
  channelChats,
  DEFAULT_NAME,
  DISCORD_PORTAL_URL,
  discordClientId,
  discordInviteUrl,
  isSlug,
  misplacedSecret,
  normalizeSteps,
  type ProviderMeta,
  parseRelay,
  providerMeta,
  type SecretSpec,
  STEP_LABEL,
  slackCreateUrl,
  slackManifest,
  suggestBotUsername,
  telegramGroupLink,
  toSlug,
  uniqueName,
  validationCaution,
} from './providers.ts';

/** Kept for the router/kitchen: the common 6-step frame (JOURNEYS §4). */
export const WIZARD_STEPS = [
  t('channels.channelWizard.create'),
  t('channels.channelWizard.credentials'),
  t('channels.channelWizard.validate'),
  t('channels.channelWizard.connect'),
  t('channels.detail.pair'),
  t('channels.channelWizard.join'),
];

type Phase = 'idle' | 'validating' | 'invalid' | 'valid' | 'adding' | 'connecting' | 'connected' | 'failed';

interface Ctx {
  meta: ProviderMeta;
  steps: string[];
  index: number;
  draft: ChannelDraft;
  patch: (p: Partial<ChannelDraft>) => void;
  channel?: ChannelView;
  channels: ChannelView[];
  go: (i: number, opts?: { replace?: boolean }) => void;
  next: () => void;
  finish: () => void;
  footer: HTMLElement | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  setAuto: (i: number | undefined) => void;
  /** Set when the user just came back from a provider tab. */
  returned: number;
  markLeft: () => void;
  offline: boolean;
}

const label = (s: string) => STEP_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

/** Sticky action bar (portal into the Screen footer): primary on the right, Back on the left. */
const Actions = ({ ctx, children, back = true }: { ctx: Ctx; children: ReactNode; back?: boolean }) => {
  if (!ctx.footer) return null;
  const prev = ctx.index - 1;
  return createPortal(
    <div className="flex items-center gap-2">
      {back && prev >= 0 && (
        <Button
          variant="quiet"
          size="lg"
          icon={<ArrowLeft size={18} aria-hidden="true" />}
          onPress={() => {
            // Back skips the auto steps (they live on Credentials).
            let p = prev;
            while (p > 0 && AUTO_STEPS.has(ctx.steps[p]!)) p--;
            ctx.go(p);
          }}
        >
          {t('channels.wizard.back')}
        </Button>
      )}
      <div className="ml-auto flex min-w-0 flex-1 justify-end gap-2 expanded:flex-none">{children}</div>
    </div>,
    ctx.footer,
  );
};

const nextLabel = (ctx: Ctx, from = ctx.index) => {
  let n = from + 1;
  while (n < ctx.steps.length && AUTO_STEPS.has(ctx.steps[n]!)) n++;
  return n < ctx.steps.length
    ? t('channels.wizard.continueTo', { step: label(ctx.steps[n]!) })
    : t('channels.wizard.finish', { provider: ctx.meta.name });
};

// ─────────── 01 Create ───────────

const CreateStep = ({ ctx }: { ctx: Ctx }) => {
  const { meta, draft, patch } = ctx;
  const agents = useApi('agent.list');
  // Set up for one agent (from creating it): name the bot after that agent.
  const agent =
    (typeof draft.values.forAgent === 'string' ? draft.values.forAgent : undefined) ??
    agents.data?.agents[0]?.config.name ??
    'beamhop';
  const opened = !!draft.values.openedCreate;
  const open = () => {
    patch({ values: { openedCreate: true } });
    ctx.markLeft();
  };
  const [appName, setAppName] = useState(String(draft.values.appName ?? 'beamhop'));
  const salt = useMemo(() => Math.random().toString(36).slice(2, 6), []);
  const username = String(draft.values.botUsername ?? suggestBotUsername(agent, salt));
  const checklist = draft.checklist ?? [];
  const toggle = (id: string, on: boolean) => {
    const list = on ? [...new Set([...checklist, id])] : checklist.filter((x) => x !== id);
    patch({ checklist: list, values: { intentChecked: list.includes('intent') } });
  };

  let link: { href: string; label: string };
  let body: ReactNode;
  if (meta.id === 'telegram') {
    link = { href: BOTFATHER_URL, label: t('channels.create.tg.open') };
    body = (
      <ol
        aria-label={t('channels.create.scriptLabel')}
        className="rounded-lg border border-line bg-surface px-4"
      >
        <ScriptStep n={1} copy="/newbot">
          {t('channels.create.tg.s1')}
        </ScriptStep>
        <ScriptStep n={2} copy={`${agent} (beamhop)`} note={t('channels.create.tg.s2note')}>
          {t('channels.create.tg.s2')}
        </ScriptStep>
        <ScriptStep n={3} copy={username} note={t('channels.create.tg.s3note')}>
          {t('channels.create.tg.s3')}
        </ScriptStep>
        <ScriptStep n={4}>{t('channels.create.tg.s4')}</ScriptStep>
      </ol>
    );
  } else if (meta.id === 'slack') {
    link = { href: slackCreateUrl(appName || 'beamhop'), label: t('channels.create.sl.open') };
    body = (
      <div className="flex flex-col gap-4">
        <TextField
          label={t('channels.create.sl.appName')}
          description={t('channels.create.sl.appNameHint')}
          value={appName}
          onChange={(v) => {
            setAppName(v);
            patch({ values: { appName: v } });
          }}
        />
        <ol
          aria-label={t('channels.create.scriptLabel')}
          className="rounded-lg border border-line bg-surface px-4"
        >
          <ScriptStep n={1}>{t('channels.create.sl.s1')}</ScriptStep>
          <ScriptStep n={2}>{t('channels.create.sl.s2')}</ScriptStep>
        </ol>
        <Disclosure className="rounded-md border border-line">
          <Heading level={3} className="m-0">
            <RACButton
              slot="trigger"
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left type-label text-ink-2 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
            >
              {t('channels.create.sl.manifest')}
              <ArrowRight size={14} className="ml-auto" aria-hidden="true" />
            </RACButton>
          </Heading>
          <DisclosurePanel>
            <div className="border-t border-line p-2">
              <CodeBlock
                code={JSON.stringify(slackManifest(appName || 'beamhop'), null, 2)}
                label={t('channels.create.sl.manifest')}
                maxLines={14}
              />
            </div>
          </DisclosurePanel>
        </Disclosure>
      </div>
    );
  } else {
    link = { href: DISCORD_PORTAL_URL, label: t('channels.create.dc.open') };
    body = (
      <fieldset className="flex flex-col rounded-lg border border-line bg-surface px-4 py-1">
        <legend className="sr-only">{t('channels.create.dc.checklist')}</legend>
        {(['app', 'bot', 'token', 'intent'] as const).map((id) => (
          <Checkbox
            key={id}
            isSelected={checklist.includes(id)}
            onChange={(on) => toggle(id, on)}
            description={id === 'intent' ? t('channels.create.dc.intentWhy') : undefined}
            className="border-b border-line py-1 last:border-b-0"
          >
            {t(`channels.create.dc.${id}`)}
          </Checkbox>
        ))}
      </fieldset>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        ref={ctx.headingRef}
        index={ctx.index}
        total={ctx.steps.length}
        label={label('create')}
        lead={t(`channels.create.${meta.id === 'telegram' ? 'tg' : meta.id === 'slack' ? 'sl' : 'dc'}.lead`)}
      >
        {t(`channels.create.${meta.id === 'telegram' ? 'tg' : meta.id === 'slack' ? 'sl' : 'dc'}.title`)}
      </StepHeading>
      <ExternalButton href={link.href} variant={opened ? 'secondary' : 'primary'} onOpen={open} fullWidth>
        {link.label}
      </ExternalButton>
      {body}
      {meta.id === 'discord' && <p className="type-body-sm text-ink-2">{t('channels.create.dc.note')}</p>}
      <Actions ctx={ctx}>
        <Button
          variant={opened ? 'primary' : 'secondary'}
          size="lg"
          onPress={ctx.next}
          className="flex-1 expanded:flex-none"
          trailing={<ArrowRight size={18} aria-hidden="true" />}
        >
          {nextLabel(ctx)}
        </Button>
      </Actions>
    </div>
  );
};

// ─────────── 02 Credentials (+ 03 Validate, 04 Connect in place) ───────────

/**
 * "Saved" hint kept in the draft (localStorage): a few characters of a LONG token only. A short
 * secret (plugin channels) would be fully revealed by prefix + suffix, so it gets no characters.
 */
const hint = (v: string) => (v.length >= 20 ? `${v.slice(0, 5)}…${v.slice(-4)}` : '•••');

const useChannelName = (ctx: Ctx, identityHandle?: string) => {
  const taken = ctx.channels.map((c) => c.config.name);
  const fallback = uniqueName(DEFAULT_NAME[ctx.meta.id] ?? ctx.meta.id, taken);
  const fromHandle = identityHandle ? uniqueName(toSlug(identityHandle), taken) : undefined;
  const name = ctx.draft.nameEdited
    ? (ctx.draft.name ?? fallback)
    : (fromHandle ?? ctx.draft.name ?? fallback);
  const error = !isSlug(name)
    ? t('channels.cred.nameRule')
    : taken.includes(name) && name !== ctx.draft.channel
      ? t('channels.cred.nameTaken', { name })
      : undefined;
  return { name, error };
};

/** Waits for a freshly added channel to report `connected` (live via channel.updated events). */
const useConnected = (
  channels: ChannelView[],
  name: string | undefined,
  active: boolean,
  onDone: () => void,
) => {
  const c = channels.find((x) => x.config.name === name);
  const ref = useRef(onDone);
  ref.current = onDone;
  useEffect(() => {
    if (active && c?.status === 'connected') ref.current();
  }, [active, c?.status]);
  return c;
};

const CredentialsStep = ({ ctx }: { ctx: Ctx }) => {
  const { meta, draft, patch } = ctx;
  const call = useCall();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>(draft.channel ? 'connected' : 'idle');
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    identity?: { name: string; handle?: string };
  }>();
  const [failure, setFailure] = useState<Error>();
  const container = useRef<HTMLDivElement>(null);
  const focusField = (key: string) => {
    const i = meta.secrets.findIndex((s) => s.key === key);
    container.current
      ?.querySelectorAll<HTMLInputElement>('input[type="password"],input[type="text"]')
      [i]?.focus();
  };
  const identity = result?.ok ? result.identity : draft.identity;
  const { name, error: nameError } = useChannelName(ctx, identity?.handle ?? identity?.name);
  // Only provider settings go to the daemon (not the wizard's own bookkeeping).
  const intentChecked = !!draft.values.intentChecked;
  const appName = draft.values.appName as string | undefined;
  const values = useMemo(
    () =>
      meta.id === 'slack'
        ? { mode: 'socket', ...(appName ? { appName } : {}) }
        : meta.id === 'telegram'
          ? { mode: 'long-poll' }
          : meta.id === 'discord'
            ? { intentChecked }
            : {},
    [meta.id, appName, intentChecked],
  );
  const shapesOk = meta.secrets.every((s) => s.format.test((secrets[s.key] ?? '').trim()));
  const allFilled = meta.secrets.every((s) => (secrets[s.key] ?? '').trim().length > 0);
  const vIndex = ctx.steps.indexOf('validate');
  const cIndex = ctx.steps.indexOf('connect');

  // Stepper: Validate / Connect fill on their own.
  useEffect(() => {
    const auto =
      phase === 'validating' || phase === 'invalid'
        ? vIndex
        : phase === 'valid' || phase === 'adding' || phase === 'connecting' || phase === 'failed'
          ? cIndex
          : phase === 'connected'
            ? cIndex + 1
            : undefined;
    ctx.setAuto(auto !== undefined && auto >= 0 ? auto : undefined);
  }, [phase, vIndex, cIndex, ctx.setAuto]);
  useEffect(() => () => ctx.setAuto(undefined), [ctx.setAuto]);

  const validate = useCallback(
    async (s: Record<string, string>) => {
      setPhase('validating');
      try {
        const r = await call('channel.validate', { provider: meta.id, values, secrets: s });
        setResult(r);
        setPhase(r.ok ? 'valid' : 'invalid');
        if (r.ok) {
          haptic('confirm');
          announce(
            t('channels.cred.validSpoken', { bot: r.identity?.handle ?? r.identity?.name ?? meta.name }),
          );
          patch({
            identity: r.identity,
            clientId: meta.id === 'discord' ? discordClientId(s.botToken ?? '') : undefined,
          });
        } else {
          haptic('error');
          announce(r.message);
        }
      } catch (e) {
        setFailure(e as Error);
        setPhase('failed');
      }
    },
    [call, meta.id, meta.name, values, patch],
  );

  // Live validation: once every field has the right shape, check with the provider (debounced).
  const key = JSON.stringify(secrets);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the secret values
  useEffect(() => {
    if (draft.channel || !shapesOk || phase === 'adding' || phase === 'connecting') return;
    const tm = setTimeout(() => void validate(secrets), 450);
    return () => clearTimeout(tm);
  }, [key, shapesOk]);

  const connect = async () => {
    if (nameError) return;
    setPhase('adding');
    setFailure(undefined);
    try {
      const c = await call('channel.add', { name, provider: meta.id, values, secrets });
      const hints = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, hint(v.trim())]));
      patch({ channel: c.config.name, name, values: { hints } });
      setSecrets({});
      setPhase(c.status === 'connected' ? 'connected' : 'connecting');
    } catch (e) {
      setFailure(e as Error);
      setPhase('failed');
    }
  };

  const advanceIfFocused = () => {
    const a = document.activeElement;
    const focusInside =
      !a || a === document.body || !!container.current?.contains(a) || !!ctx.footer?.contains(a);
    announce(t('channels.cred.connectedSpoken', { bot: identity?.handle ?? name }));
    haptic('confirm');
    if (focusInside) window.setTimeout(ctx.next, 600);
  };
  useConnected(ctx.channels, draft.channel, phase === 'connecting', () => {
    setPhase('connected');
    advanceIfFocused();
  });

  // Back from BotFather/Slack/Discord: focus the first empty field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run on each return
  useEffect(() => {
    if (!ctx.returned) return;
    const empty = meta.secrets.find((s) => !(secrets[s.key] ?? '').trim());
    if (empty) focusField(empty.key);
  }, [ctx.returned]);

  const set = (k: string, v: string) => {
    setSecrets((s) => ({ ...s, [k]: v }));
    if (phase === 'invalid' || phase === 'valid' || phase === 'failed') setPhase('idle');
  };

  const pasteInto = async (s: SecretSpec) => {
    try {
      set(s.key, (await navigator.clipboard.readText()).trim());
    } catch {
      focusField(s.key);
    }
  };

  const saved = !!draft.channel;
  const hints = (draft.values.hints as Record<string, string> | undefined) ?? {};
  const busy = phase === 'validating' || phase === 'adding' || phase === 'connecting';
  const caution = !!result?.ok && validationCaution(result.message);
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;
  const firstEmpty = meta.secrets.find((s) => !(secrets[s.key] ?? '').trim());

  return (
    <div ref={container} className="flex flex-col gap-5">
      <StepHeading
        ref={ctx.headingRef}
        index={ctx.index}
        total={ctx.steps.length}
        label={label(ctx.steps[ctx.index]!)}
        lead={
          saved
            ? t('channels.cred.savedLead')
            : t(`channels.cred.lead.${meta.id === 'slack' ? 'slack' : 'one'}`)
        }
      >
        {saved
          ? t('channels.cred.savedTitle', { bot: identity?.handle ?? draft.channel ?? name })
          : t(`channels.cred.title.${meta.id === 'slack' ? 'slack' : 'one'}`, { provider: meta.name })}
      </StepHeading>

      {!saved && ctx.returned > 0 && canPaste && firstEmpty && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-flare-wash px-3 py-2">
          <ClipboardText size={20} className="shrink-0 text-flare-text" aria-hidden="true" />
          <p className="min-w-0 flex-1 type-body-sm text-ink">
            {t('channels.cred.welcomeBack', { label: firstEmpty.label })}
          </p>
          <Button variant="secondary" size="sm" onPress={() => void pasteInto(firstEmpty)}>
            {t('channels.cred.paste')}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {meta.secrets.map((s) => {
          const v = secrets[s.key] ?? '';
          const wrong = meta.secrets.length > 1 ? misplacedSecret(meta, s.key, v) : undefined;
          return (
            <div key={s.key} className="flex flex-col gap-2">
              <SecretField
                label={s.label}
                savedHint={saved ? (hints[s.key] ?? s.shape) : undefined}
                description={
                  s.help !== undefined
                    ? s.help || undefined
                    : t(`channels.cred.how.${meta.id}.${s.key}` as 'channels.cred.how.telegram.token')
                }
                format={s.format}
                formatLabel={s.formatLabel}
                value={v}
                onChange={(x) => set(s.key, x)}
                isDisabled={busy}
              />
              {!v && !saved && (
                <p className="type-meta text-ink-3">{t('channels.cred.shape', { shape: s.shape })}</p>
              )}
              {wrong && (
                <div className="flex items-center gap-3 rounded-md bg-caution-wash px-3 py-2 type-body-sm text-ink">
                  <WarningCircle size={18} className="shrink-0 text-caution-text" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    {t('channels.cred.wrongField', { label: wrong.label })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => {
                      setSecrets((x) => ({ ...x, [s.key]: x[wrong.key] ?? '', [wrong.key]: v }));
                      announce(t('channels.cred.movedSpoken', { label: wrong.label }));
                    }}
                  >
                    {t('channels.cred.move')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {phase === 'validating' && (
        <WaitingLine>{t('channels.cred.validating', { provider: meta.name })}</WaitingLine>
      )}
      {phase === 'invalid' && result && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-md border-l-[3px] border-stop-text bg-stop-wash px-3 py-2.5"
        >
          <WarningCircle
            size={18}
            weight="bold"
            className="mt-0.5 shrink-0 text-stop-text"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="type-body-strong text-ink">{t('channels.cred.invalidTitle')}</p>
            <p className="type-body-sm text-ink-2">{result.message}</p>
          </div>
        </div>
      )}
      {failure && (
        <ErrorState
          title={t('channels.cred.failedTitle', { provider: meta.name })}
          details={failure}
          onRetry={() =>
            void (draft.channel
              ? undefined
              : shapesOk
                ? result?.ok
                  ? connect()
                  : validate(secrets)
                : undefined)
          }
        >
          {failure.message}
        </ErrorState>
      )}
      {identity && (result?.ok || saved) && (
        <IdentityCard
          name={identity.name}
          handle={identity.handle}
          provider={meta.name}
          tone={caution ? 'caution' : 'go'}
          note={caution ? result?.message : undefined}
        />
      )}
      {(phase === 'valid' || phase === 'adding' || phase === 'failed') && !saved && (
        <TextField
          label={t('channels.cred.name')}
          description={t('channels.cred.nameHint', { name })}
          value={name}
          mono
          isInvalid={!!nameError}
          errorMessage={nameError}
          onChange={(v) => patch({ name: v.toLowerCase(), nameEdited: true })}
        />
      )}
      {(phase === 'adding' || phase === 'connecting') && (
        <WaitingLine>
          {phase === 'adding'
            ? t('channels.cred.saving')
            : t('channels.cred.connecting', { transport: meta.transport })}
        </WaitingLine>
      )}
      {phase === 'connected' && (
        <p role="status" className="flex items-center gap-2 type-meta text-go-text">
          <LockSimple size={16} weight="bold" aria-hidden="true" />
          {t('channels.cred.connected', { transport: meta.transport })}
        </p>
      )}

      <Actions ctx={ctx}>
        {saved || phase === 'connected' ? (
          <Button
            variant="primary"
            size="lg"
            onPress={ctx.next}
            className="flex-1 expanded:flex-none"
            trailing={<ArrowRight size={18} aria-hidden="true" />}
          >
            {nextLabel(ctx, Math.max(ctx.index, cIndex))}
          </Button>
        ) : phase === 'valid' ||
          phase === 'adding' ||
          phase === 'connecting' ||
          (phase === 'failed' && result?.ok) ? (
          <Button
            variant="primary"
            size="lg"
            isPending={phase === 'adding' || phase === 'connecting'}
            isDisabled={!!nameError || ctx.offline}
            onPress={() => void connect()}
            className="flex-1 expanded:flex-none"
          >
            {t('channels.cred.connect', { bot: identity?.handle ?? meta.name })}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            isDisabled={!allFilled || ctx.offline}
            isPending={phase === 'validating'}
            onPress={() => void validate(secrets)}
            className="flex-1 expanded:flex-none"
          >
            {t('channels.cred.check')}
          </Button>
        )}
      </Actions>
    </div>
  );
};

// ─────────── Pair ───────────

const PairStep = ({ ctx }: { ctx: Ctx }) => {
  const { channel, draft, patch, meta } = ctx;
  const last = ctx.index === ctx.steps.length - 1;
  if (!channel) return null;
  const bot = channel.self?.handle ?? draft.identity?.handle ?? channel.config.name;
  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        ref={ctx.headingRef}
        index={ctx.index}
        total={ctx.steps.length}
        label={label('pair')}
        lead={t('channels.pairStep.lead', { provider: meta.name, bot })}
      >
        {t('channels.pairStep.title', { provider: meta.name })}
      </StepHeading>
      <PairPanel
        channel={channel}
        bot={draft.identity?.handle}
        initial={draft.pair}
        onCode={(c) => patch({ pair: c })}
        confirmLabel={
          last
            ? t('channels.pairStep.confirmFinish')
            : t('channels.pairStep.confirmNext', { step: nextLabel(ctx).replace(/^Continue · /, '') })
        }
        onConfirmed={(p) => {
          patch({ confirmed: p.principal });
          if (last) ctx.finish();
          else ctx.next();
        }}
      />
      <Actions ctx={ctx}>
        <Button variant="quiet" size="lg" onPress={last ? ctx.finish : ctx.next}>
          {t('channels.pairStep.later')}
        </Button>
      </Actions>
    </div>
  );
};

// ─────────── Join ───────────

const JoinStep = ({ ctx }: { ctx: Ctx }) => {
  const { channel, meta, draft, patch } = ctx;
  const agents = useApi('agent.list');
  const roles = useApi('role.list');
  const call = useCall();
  const toast = useToast();
  const last = ctx.index === ctx.steps.length - 1;
  const list = agents.data?.agents ?? [];
  const [picked, setPicked] = useState<string[] | undefined>(draft.values.agents as string[] | undefined);
  const selected = picked ?? (list[0] ? [list[0].config.name] : []);
  const [dms, setDms] = useState(meta.id !== 'nostr');
  const [role, setRole] = useState('viewer');
  const [mention, setMention] = useState(true);
  const [reply, setReply] = useState(true);
  const [chatPick, setChatPick] = useState<string[]>([]);
  const [threads, setThreads] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  if (!channel) return null;
  const name = channel.config.name;
  const bot = channel.self?.handle ?? draft.identity?.handle ?? name;
  const chats = channelChats(channel);
  const pick = (a: string, on: boolean) => {
    const next = on ? [...new Set([...selected, a])] : selected.filter((x) => x !== a);
    setPicked(next);
    patch({ values: { agents: next } });
  };
  const nostrTarget =
    meta.id === 'nostr'
      ? `${name}:group/${String(channel.config.settings.relay ?? '').replace('wss://', '')}'${String(channel.config.settings.group ?? '')}`
      : undefined;
  const targets = [
    ...(dms ? [`${name}:dm`] : []),
    ...(nostrTarget ? [nostrTarget] : []),
    ...chatPick.map((c) => `${name}:${c}`),
  ];
  const clientId = draft.clientId ?? (channel.config.settings.applicationId as string | undefined);
  const roleOptions = (roles.data?.roles ?? []).filter((r) => r.name !== 'owner');

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const triggers: Params<'membership.join'>['membership']['triggers'] = [
        ...(mention ? (['mention'] as const) : []),
        ...(reply ? (['reply'] as const) : []),
      ];
      for (const agent of selected)
        for (const target of targets)
          await call('membership.join', {
            agent,
            membership: {
              target,
              defaultRole: role,
              triggers: target.endsWith(':dm') ? ['dm', ...triggers] : triggers,
            },
          });
      if (selected.length && targets.length)
        toast.show({
          message: t('channels.join.done', { agents: selected.join(', '), count: targets.length }),
          tone: 'success',
        });
      if (last) ctx.finish();
      else ctx.next();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        ref={ctx.headingRef}
        index={ctx.index}
        total={ctx.steps.length}
        label={label('join')}
        lead={t('channels.join.lead', { bot })}
      >
        {t('channels.join.title')}
      </StepHeading>

      {meta.id === 'discord' && (
        <section aria-labelledby="dc-invite" className="flex flex-col gap-3">
          <Eyebrow id="dc-invite" level={3}>
            {t('channels.join.dc.eyebrow')}
          </Eyebrow>
          {clientId ? (
            <ExternalButton
              href={discordInviteUrl(clientId, threads)}
              variant="secondary"
              fullWidth
              onOpen={ctx.markLeft}
            >
              {t('channels.join.dc.invite')}
            </ExternalButton>
          ) : (
            <p className="type-body-sm text-ink-2">{t('channels.join.dc.noClient')}</p>
          )}
          <p className="type-body-sm text-ink-2">{t('channels.join.dc.perms')}</p>
          <Switch isSelected={threads} onChange={setThreads} description={t('channels.join.dc.threadsHint')}>
            {t('channels.join.dc.threads')}
          </Switch>
        </section>
      )}

      <section aria-labelledby="join-agents" className="flex flex-col gap-2">
        <Eyebrow id="join-agents" level={3} count={selected.length}>
          {t('channels.join.agents')}
        </Eyebrow>
        {list.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('channels.join.noAgents')}</p>
        ) : (
          <div className="flex flex-col rounded-lg border border-line bg-surface px-4 py-1">
            {list.map((a) => (
              <Checkbox
                key={a.config.name}
                isSelected={selected.includes(a.config.name)}
                onChange={(on) => pick(a.config.name, on)}
                description={`${a.config.harness} · ${t('channels.join.inChannels', { count: new Set(a.config.memberships.map((m) => m.target.split(':')[0])).size })}`}
                className="border-b border-line py-1 last:border-b-0"
              >
                {a.config.name}
              </Checkbox>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="join-where" className="flex flex-col gap-2">
        <Eyebrow id="join-where" level={3}>
          {t('channels.join.where')}
        </Eyebrow>
        <div className="flex flex-col rounded-lg border border-line bg-surface px-4 py-1">
          {meta.id !== 'nostr' && (
            <Switch
              isSelected={dms}
              onChange={setDms}
              description={t('channels.join.dmsHint', { bot })}
              className="border-b border-line py-1 last:border-b-0"
            >
              {t('channels.join.dms')}
            </Switch>
          )}
          {nostrTarget && (
            <p className="flex min-h-12 items-center gap-2 py-2 type-body text-ink">
              <LetterTile code="NS" />
              <MetaLine items={[nostrTarget.slice(name.length + 1)]} className="text-ink" />
            </p>
          )}
          {chats.map((c) => (
            <Checkbox
              key={c.target}
              isSelected={chatPick.includes(c.target)}
              onChange={(on) => setChatPick((x) => (on ? [...x, c.target] : x.filter((y) => y !== c.target)))}
              description={c.target}
              className="border-b border-line py-1 last:border-b-0"
            >
              {c.title}
            </Checkbox>
          ))}
        </div>
        {meta.id === 'telegram' && (
          <div className="flex flex-col gap-3 pt-1">
            <ExternalButton
              href={telegramGroupLink(bot, draft.pair?.code ?? name)}
              onOpen={ctx.markLeft}
              fullWidth
            >
              {t('channels.join.tg.group')}
            </ExternalButton>
            {chats.length === 0 && <WaitingLine>{t('channels.join.tg.waitingGroup')}</WaitingLine>}
            <div className="flex gap-2.5 rounded-md border-l-[3px] border-caution-text bg-caution-wash px-3 py-2.5 type-body-sm text-ink">
              <Info size={18} className="mt-0.5 shrink-0 text-caution-text" aria-hidden="true" />
              <p>{t('channels.join.tg.privacy')}</p>
            </div>
          </div>
        )}
        {meta.id === 'slack' && (
          <div className="flex flex-col gap-1.5 pt-1">
            <p className="type-body-sm text-ink-2">{t('channels.join.sl.invite')}</p>
            <div className="flex items-center gap-1 rounded-md bg-sunken pl-3">
              <code className="min-w-0 flex-1 truncate py-2 type-code text-ink">/invite {bot}</code>
              <CopyButton value={`/invite ${bot}`} label={t('channels.join.sl.copy')} compact />
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="join-role" className="flex flex-col gap-3">
        <Eyebrow id="join-role" level={3}>
          {t('channels.join.roleEyebrow')}
        </Eyebrow>
        <RadioGroup label={t('channels.join.role')} hideLabel value={role} onChange={setRole} variant="cards">
          {(roleOptions.length
            ? roleOptions
            : [
                { name: 'viewer', description: '' },
                { name: 'user', description: '' },
              ]
          ).map((r) => (
            <Radio key={r.name} value={r.name} description={r.description || undefined}>
              {r.name}
              {r.name === 'viewer' ? ` · ${t('channels.join.default')}` : ''}
            </Radio>
          ))}
        </RadioGroup>
        <fieldset className="flex flex-col">
          <legend className="type-label text-ink">{t('channels.join.triggers')}</legend>
          <Checkbox isSelected={mention} onChange={setMention}>
            {t('channels.join.mention', { bot })}
          </Checkbox>
          <Checkbox isSelected={reply} onChange={setReply}>
            {t('channels.join.reply')}
          </Checkbox>
        </fieldset>
      </section>

      {error && (
        <ErrorState title={t('channels.join.error')} details={error} onRetry={() => void submit()}>
          {error.message}
        </ErrorState>
      )}

      <Actions ctx={ctx}>
        <Button
          variant="primary"
          size="lg"
          isPending={busy}
          isDisabled={ctx.offline}
          onPress={() => void submit()}
          className="flex-1 expanded:flex-none"
        >
          {selected.length === 0 || targets.length === 0
            ? last
              ? t('channels.join.finishEmpty')
              : nextLabel(ctx)
            : nextLabel(ctx)}
        </Button>
      </Actions>
    </div>
  );
};

// ─────────── Nostr: Relay, Group ───────────

const SUGGESTED_RELAYS = [
  'wss://groups.fiatjaf.com',
  'wss://groups.0xchat.com',
  'wss://relay.groups.nip29.com',
];

const RelayStep = ({ ctx }: { ctx: Ctx }) => {
  const { draft, patch } = ctx;
  const call = useCall();
  const [raw, setRaw] = useState(String(draft.values.relay ?? ''));
  const [check, setCheck] = useState<{ state: 'idle' | 'checking' | 'ok' | 'bad'; message?: string }>({
    state: 'idle',
  });
  const parsed = parseRelay(raw);
  const url = 'url' in parsed ? parsed.url : undefined;
  const keyMode = String(draft.values.keyMode ?? 'daemon');
  const [nsec, setNsec] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `call` is a new function every render
  useEffect(() => {
    if (!url) {
      setCheck({ state: 'idle' });
      return;
    }
    setCheck({ state: 'checking' });
    const tm = setTimeout(async () => {
      try {
        const r = await call('channel.validate', { provider: 'nostr', values: { relay: url }, secrets: {} });
        setCheck({ state: r.ok ? 'ok' : 'bad', message: r.message });
      } catch (e) {
        setCheck({ state: 'bad', message: (e as Error).message });
      }
    }, 400);
    return () => clearTimeout(tm);
  }, [url]);
  const nsecOk = keyMode === 'daemon' || /^nsec1[02-9ac-hj-np-z]{58}$/.test(nsec.trim());
  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        ref={ctx.headingRef}
        index={ctx.index}
        total={ctx.steps.length}
        label={label('relay')}
        lead={t('channels.nostr.relayLead')}
      >
        {t('channels.nostr.relayTitle')}
      </StepHeading>
      <TextField
        label={t('channels.nostr.relay')}
        description={t('channels.nostr.relayHint')}
        value={raw}
        mono
        placeholder="wss://"
        onChange={setRaw}
        isInvalid={!!raw && 'error' in parsed}
        errorMessage={'error' in parsed ? parsed.error : undefined}
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('channels.nostr.suggested')}>
        {SUGGESTED_RELAYS.map((r) => (
          <Button
            key={r}
            variant="secondary"
            size="sm"
            onPress={() => setRaw(r)}
            className="font-mono text-[12px]"
          >
            {r.replace('wss://', '')}
          </Button>
        ))}
      </div>
      {check.state === 'checking' && <WaitingLine>{t('channels.nostr.checking')}</WaitingLine>}
      {check.state === 'ok' && url && (
        <IdentityCard name={url.replace('wss://', '')} handle={check.message} provider="Nostr relay" />
      )}
      {check.state === 'bad' && (
        <p role="alert" className="flex items-start gap-2 type-body-sm text-stop-text">
          <WarningCircle size={18} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
          {check.message}
        </p>
      )}
      <RadioGroup
        label={t('channels.nostr.key')}
        value={keyMode}
        onChange={(v) => patch({ values: { keyMode: v } })}
        variant="cards"
      >
        <Radio value="daemon" description={t('channels.nostr.keyDaemonHint')}>
          {t('channels.nostr.keyDaemon')}
        </Radio>
        <Radio value="own" description={t('channels.nostr.keyOwnHint')}>
          {t('channels.nostr.keyOwn')}
        </Radio>
      </RadioGroup>
      {keyMode === 'own' && (
        <SecretField
          label={t('channels.channelWizard.groupKeyNsec')}
          format={/^nsec1[02-9ac-hj-np-z]{58}$/}
          formatLabel="Looks like an nsec"
          value={nsec}
          onChange={setNsec}
          description={t('channels.nostr.nsecHint')}
        />
      )}
      <Actions ctx={ctx}>
        <Button
          variant="primary"
          size="lg"
          isDisabled={check.state !== 'ok' || !nsecOk}
          onPress={() => {
            patch({ values: { relay: url } });
            // The nsec is held in memory only until Connect (never in the draft).
            sessionNsec.current = keyMode === 'own' ? nsec.trim() : undefined;
            ctx.next();
          }}
          className="flex-1 expanded:flex-none"
          trailing={<ArrowRight size={18} aria-hidden="true" />}
        >
          {nextLabel(ctx)}
        </Button>
      </Actions>
    </div>
  );
};

/** In-memory hand-off of an optional Nostr group key from Relay → Group (never persisted). */
const sessionNsec: { current?: string } = {};

const GroupStep = ({ ctx }: { ctx: Ctx }) => {
  const { draft, patch } = ctx;
  const call = useCall();
  const relay = String(draft.values.relay ?? '');
  const [raw, setRaw] = useState(String(draft.values.group ?? ''));
  const [title, setTitle] = useState(String(draft.values.title ?? ''));
  const [phase, setPhase] = useState<Phase>(draft.channel ? 'connected' : 'idle');
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    identity?: { name: string; handle?: string };
  }>();
  const [failure, setFailure] = useState<Error>();
  // Accept `host'group` (NIP-29 group address) pasted whole.
  const group = raw.includes("'") ? raw.slice(raw.indexOf("'") + 1).trim() : raw.trim();
  const taken = ctx.channels.map((c) => c.config.name);
  const name =
    draft.nameEdited && draft.name ? draft.name : uniqueName(toSlug(`nostr-${group || 'group'}`), taken);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `call` is a new function every render
  useEffect(() => {
    if (draft.channel || group.length < 2) return;
    setPhase('validating');
    const tm = setTimeout(async () => {
      try {
        const r = await call('channel.validate', {
          provider: 'nostr',
          values: { relay, group, title },
          secrets: {},
        });
        setResult(r);
        setPhase(r.ok ? 'valid' : 'invalid');
      } catch (e) {
        setFailure(e as Error);
        setPhase('failed');
      }
    }, 400);
    return () => clearTimeout(tm);
  }, [group, title, relay, draft.channel]);
  const connect = async () => {
    setPhase('adding');
    try {
      const secrets: Record<string, string> = sessionNsec.current ? { nsec: sessionNsec.current } : {};
      const c = await call('channel.add', {
        name,
        provider: 'nostr',
        values: { relay, group, title: title || group, keyMode: draft.values.keyMode ?? 'daemon' },
        secrets,
      });
      sessionNsec.current = undefined;
      patch({ channel: c.config.name, name, identity: result?.identity, values: { group, title } });
      setPhase('connecting');
    } catch (e) {
      setFailure(e as Error);
      setPhase('failed');
    }
  };
  useConnected(ctx.channels, draft.channel, phase === 'connecting', () => {
    setPhase('connected');
    haptic('confirm');
    announce(t('channels.cred.connectedSpoken', { bot: name }));
    window.setTimeout(ctx.next, 600);
  });
  if (!relay)
    return <Navigate to="/channels/add/$provider/$step" params={{ provider: 'nostr', step: '1' }} replace />;
  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        ref={ctx.headingRef}
        index={ctx.index}
        total={ctx.steps.length}
        label={label('group')}
        lead={t('channels.nostr.groupLead', { relay: relay.replace('wss://', '') })}
      >
        {t('channels.nostr.groupTitle')}
      </StepHeading>
      <TextField
        label={t('channels.nostr.group')}
        description={t('channels.nostr.groupHint')}
        value={raw}
        mono
        isDisabled={!!draft.channel}
        onChange={setRaw}
      />
      <TextField
        label={t('channels.nostr.groupName')}
        value={title}
        onChange={setTitle}
        isDisabled={!!draft.channel}
      />
      {phase === 'validating' && <WaitingLine>{t('channels.nostr.checkingGroup')}</WaitingLine>}
      {phase === 'invalid' && result && (
        <p role="alert" className="flex items-start gap-2 type-body-sm text-stop-text">
          <WarningCircle size={18} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
          {result.message}
        </p>
      )}
      {failure && (
        <ErrorState title={t('channels.cred.failedTitle', { provider: 'Nostr' })} details={failure}>
          {failure.message}
        </ErrorState>
      )}
      {(result?.ok || draft.identity) && (
        <IdentityCard
          name={(result?.identity ?? draft.identity)!.name}
          handle={(result?.identity ?? draft.identity)?.handle}
          provider="NIP-29 group"
        />
      )}
      {(phase === 'adding' || phase === 'connecting') && (
        <WaitingLine>{t('channels.cred.connecting', { transport: 'relay' })}</WaitingLine>
      )}
      <Actions ctx={ctx}>
        {draft.channel ? (
          <Button
            variant="primary"
            size="lg"
            onPress={ctx.next}
            className="flex-1 expanded:flex-none"
            trailing={<ArrowRight size={18} aria-hidden="true" />}
          >
            {nextLabel(ctx)}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            isDisabled={phase !== 'valid' && phase !== 'failed'}
            isPending={phase === 'adding' || phase === 'connecting'}
            onPress={() => void connect()}
            className="flex-1 expanded:flex-none"
          >
            {t('channels.nostr.connect')}
          </Button>
        )}
      </Actions>
    </div>
  );
};

// ─────────── Generic (plugin) step ───────────

const GenericStep = ({ ctx }: { ctx: Ctx }) => (
  <div className="flex flex-col gap-5">
    <StepHeading
      ref={ctx.headingRef}
      index={ctx.index}
      total={ctx.steps.length}
      label={label(ctx.steps[ctx.index]!)}
    >
      {label(ctx.steps[ctx.index]!)}
    </StepHeading>
    <p className="type-body text-ink-2">{t('channels.wizard.generic')}</p>
    <CliStrip command={`beamhop channel add ${ctx.meta.id}`} />
  </div>
);

// ─────────── Frame ───────────

const STEPS_NEEDING_CHANNEL = new Set(['pair', 'join']);

export const ChannelWizardScreen = () => {
  const { provider, step } = useParams({ strict: false }) as { provider: string; step: string };
  const navigate = useNavigate();
  const expanded = useExpanded();
  const conn = useConnection();
  const toast = useToast();
  const providers = useApi('channel.providers');
  const channelsQ = useApi('channel.list');
  const wv = providers.data?.providers.find((p) => p.provider === provider);
  const steps = normalizeSteps(provider, wv?.steps);
  const meta = providerMeta(provider, wv?.steps);
  const name = wv?.displayName && provider !== 'nostr' ? wv.displayName : meta.name;
  const index = Math.min(steps.length - 1, Math.max(0, Number(step) - 1 || 0));
  const { draft, patch, reset } = useDraft(provider);
  // Only when this page was opened onto a half-finished setup (not while clicking through it).
  const [resumed] = useState(() => {
    const d = readDraft(provider);
    return !!d?.channel && d.step === Number(step);
  });
  const channels = channelsQ.data?.channels ?? [];
  const channel = draft.channel ? channels.find((c) => c.config.name === draft.channel) : undefined;
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const [auto, setAuto] = useState<number | undefined>();
  const [returned, setReturned] = useState(0);
  const left = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const go = useCallback(
    (i: number, opts?: { replace?: boolean }) =>
      void navigate({
        to: '/channels/add/$provider/$step',
        params: { provider, step: String(i + 1) },
        replace: opts?.replace,
      }),
    [navigate, provider],
  );
  const finishing = useRef(false);
  const finish = useCallback(() => {
    const target = draft.channel;
    // Opened from creating an agent: go back to that agent, which now listens here.
    const forAgent = typeof draft.values.forAgent === 'string' ? draft.values.forAgent : undefined;
    finishing.current = true;
    toast.show({ message: t('channels.wizard.doneToast', { provider: meta.name }), tone: 'success' });
    // Clear the draft only once we've left, so this screen never re-renders without its channel.
    void (
      forAgent
        ? navigate({ to: '/agents/$name', params: { name: forAgent } })
        : navigate({ to: target ? '/channels/$id' : '/channels', params: target ? { id: target } : {} })
    ).then(reset);
  }, [draft.channel, draft.values.forAgent, reset, toast, meta.name, navigate]);
  const next = useCallback(() => {
    let n = index + 1;
    while (n < steps.length && AUTO_STEPS.has(steps[n]!)) n++;
    if (n >= steps.length) finish();
    else go(n);
  }, [index, steps, go, finish]);

  // Remember where the user is (resume from the picker / channel list).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on step change only
  useEffect(() => {
    if (index > 0 || draft.step > 1) patch({ step: index + 1 });
  }, [index]);

  // Focus the step heading on change (SCREENS §5); the Stepper announces "Step 5 of 6: Pair".
  // biome-ignore lint/correctness/useExhaustiveDependencies: on step change only
  useEffect(() => {
    const tm = window.setTimeout(() => headingRef.current?.focus({ preventScroll: false }), 30);
    return () => window.clearTimeout(tm);
  }, [index]);

  // Back from a provider tab → offer paste / focus the next field.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible' && left.current) {
        left.current = false;
        setReturned((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const ctx: Ctx = {
    meta,
    steps,
    index,
    draft,
    patch,
    channel,
    channels,
    go,
    next,
    finish,
    footer,
    headingRef,
    setAuto,
    returned,
    markLeft: () => {
      left.current = true;
    },
    offline: !conn.online || conn.status === 'closed',
  };

  const id = steps[index]!;
  const needsChannel = STEPS_NEEDING_CHANNEL.has(id);
  const credIndex = Math.max(
    0,
    steps.findIndex((s) => s === 'credentials' || s === 'group'),
  );
  let body: ReactNode;
  if (finishing.current) body = null;
  else if (needsChannel && !draft.channel)
    body = (
      <Navigate
        to="/channels/add/$provider/$step"
        params={{ provider, step: String(credIndex + 1) }}
        replace
      />
    );
  else if (needsChannel && !channel)
    body = channelsQ.isPending ? null : channelsQ.error ? (
      <ErrorState
        title={t('channels.list.error')}
        details={channelsQ.error}
        onRetry={() => void channelsQ.refetch()}
      />
    ) : (
      <ErrorState
        title={t('channels.wizard.gone', { name: draft.channel ?? '' })}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              reset();
              go(0);
            }}
          >
            {t('channels.wizard.startOver')}
          </Button>
        }
      >
        {t('channels.wizard.goneBody')}
      </ErrorState>
    );
  else if (id === 'create') body = <CreateStep ctx={ctx} />;
  else if (id === 'credentials' || AUTO_STEPS.has(id))
    body = <CredentialsStep ctx={{ ...ctx, index: AUTO_STEPS.has(id) ? credIndex : index }} />;
  else if (id === 'pair') body = <PairStep ctx={ctx} />;
  else if (id === 'join') body = <JoinStep ctx={ctx} />;
  else if (id === 'relay') body = <RelayStep ctx={ctx} />;
  else if (id === 'group') body = <GroupStep ctx={ctx} />;
  else body = <GenericStep ctx={ctx} />;

  const stepLabels = steps.map(label);
  const current = auto ?? index;

  return (
    <Screen
      title={t('channels.wizard.title', { provider: name })}
      back={{ href: '/channels/add', label: t('channels.add.title') }}
      pane="detail"
      maxWidth="prose"
      crumbs={[
        { label: t('nav.channels'), href: '/channels' },
        { label: t('channels.add.crumb'), href: '/channels/add' },
        { label: name },
      ]}
      titleAside={
        expanded && (
          <span className="type-meta text-ink-2 tabular-nums" aria-hidden="true">
            {String(Math.min(current, steps.length - 1) + 1).padStart(2, '0')} /{' '}
            {String(steps.length).padStart(2, '0')}
          </span>
        )
      }
      footer={
        <div
          ref={setFooter}
          className={cx('py-3', expanded ? 'mx-auto w-full max-w-[760px] px-8' : 'px-gutter')}
        />
      }
    >
      <div
        className={cx(
          expanded ? 'grid grid-cols-[180px_minmax(0,1fr)] gap-10 pt-2' : 'flex flex-col gap-6 pt-1',
        )}
      >
        <div className={cx(expanded && 'sticky top-24 self-start')}>
          <Stepper
            steps={stepLabels}
            current={Math.min(current, steps.length - 1)}
            orientation={expanded ? 'vertical' : 'horizontal'}
            className={expanded ? undefined : '[&>p]:hidden'}
            onStepPress={(i) => go(AUTO_STEPS.has(steps[i]!) ? credIndex : i)}
          />
          {expanded && <p className="mt-2 type-meta text-ink-3">{t('channels.wizard.saved')}</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {resumed && (
            <Banner tone="info" className="-mx-gutter expanded:mx-0 expanded:rounded-md expanded:border">
              {t('channels.wizard.resumed', { name: draft.channel ?? '' })}
            </Banner>
          )}
          {body}
          <CliStrip command={cliFor(provider, draft, id)} />
        </div>
      </div>
    </Screen>
  );
};

const cliFor = (provider: string, d: ChannelDraft, step: string) => {
  const n = d.channel ?? d.name ?? DEFAULT_NAME[provider] ?? provider;
  if (step === 'pair') return `beamhop channel pair ${n}`;
  if (step === 'join') return `beamhop join <agent> ${n}:dm --role viewer`;
  if (provider === 'telegram') return `beamhop channel add telegram --name ${n} --token-stdin`;
  if (provider === 'slack')
    return `beamhop channel add slack --name ${n} --app-token-stdin --bot-token-stdin`;
  if (provider === 'discord') return `beamhop channel add discord --name ${n} --token-stdin`;
  if (provider === 'nostr')
    return `beamhop channel add nostr --name ${n} --relay ${String(d.values.relay ?? 'wss://…')} --group <id>`;
  return `beamhop channel add ${provider}`;
};
