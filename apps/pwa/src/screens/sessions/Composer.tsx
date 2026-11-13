/**
 * Session footer (SCREENS §3): progress strip (`▂▄▆ running tests… · 0:42`), the `↓ 3 new` pill, and the
 * pill composer. While the agent works, Stop (ink square) stays one tap away and typing becomes
 * **Steer** (queued as the next user turn). Slash commands autocomplete above the input (§6A.7).
 * Enter sends, Shift+Enter adds a line. Auto-grows to 6 lines. Draft survives navigation (sessionStorage).
 */
import type { SessionView } from '@beamhop/core';
import { ArrowDown, ArrowUp, Stop } from '@phosphor-icons/react';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { HopMeter } from '../../ui/glyphs/index.tsx';
import { type Activity, elapsed, matchSlash, SLASH_COMMANDS } from './model.ts';

const draftKey = (id: string) => `bh.session.draft.${id}`;
const readDraft = (id: string) => {
  try {
    return sessionStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return '';
  }
};
const writeDraft = (id: string, v: string) => {
  try {
    if (v) sessionStorage.setItem(draftKey(id), v);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
};

export const ProgressStrip = ({
  activity,
  agent,
  now,
}: {
  activity: Activity | null;
  agent: string;
  now: number;
}) => {
  if (!activity) return null;
  const since = 'since' in activity ? new Date(activity.since).getTime() : now;
  const label =
    activity.kind === 'tool'
      ? (activity.detail ?? activity.label)
      : activity.kind === 'responding'
        ? t('session.activity.responding', { agent })
        : activity.kind === 'waiting'
          ? t('session.activity.waiting', { what: activity.label })
          : activity.kind === 'queued'
            ? t('session.activity.queued')
            : t('session.activity.thinking', { agent });
  const waiting = activity.kind === 'waiting';
  return (
    <div
      className={cx(
        'flex min-h-9 items-center gap-2.5 px-gutter type-meta',
        waiting ? 'bg-caution-wash text-caution-text' : 'text-ink-2',
      )}
      data-testid="progress-strip"
    >
      {waiting ? (
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full border-[1.5px] border-current" />
      ) : (
        <HopMeter up={3} total={3} busy={activity.kind !== 'queued'} tone="flare" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {label}
        {activity.kind === 'tool' && activity.detail && (
          <span className="text-ink-3"> · {activity.label}</span>
        )}
      </span>
      {activity.kind !== 'queued' && (
        <span className="shrink-0 text-ink tabular-nums">{elapsed(now - since)}</span>
      )}
    </div>
  );
};

export const JumpPill = ({ count, onPress }: { count: number; onPress: () => void }) => (
  <RACButton
    onPress={onPress}
    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 type-label text-ink shadow-pop outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus pointer-coarse:h-11"
  >
    <ArrowDown size={16} weight="bold" aria-hidden="true" />
    {count > 0 ? t('session.jump.new', { count }) : t('session.jump.latest')}
  </RACButton>
);

export interface ComposerProps {
  session: SessionView;
  live: boolean;
  disabledReason?: string;
  sending: boolean;
  stopping: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onSlash: (cmd: string) => boolean;
  /** Text to insert (quote), with a nonce so the same quote can be inserted twice. */
  insert?: { text: string; n: number };
}

export const Composer = ({
  session,
  live,
  disabledReason,
  sending,
  stopping,
  onSend,
  onStop,
  onSlash,
  insert,
}: ComposerProps) => {
  const [text, setText] = useState(() => readDraft(session.id));
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const listId = useId();

  useEffect(() => {
    setText(readDraft(session.id));
  }, [session.id]);
  useEffect(() => writeDraft(session.id, text), [session.id, text]);

  useEffect(() => {
    if (!insert) return;
    const quoted = `${insert.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}\n\n`;
    setText((cur) => quoted + cur);
    requestAnimationFrame(() => ref.current?.focus());
  }, [insert]);

  // Auto-grow to 6 lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text drives height
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = 24 * 6 + 24;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);

  const suggestions = matchSlash(text);
  const disabled = !!disabledReason;
  const trimmed = text.trim();

  const submit = async (raw = text) => {
    const v = raw.trim();
    if (!v || disabled) return;
    const cmd = v.split(/\s/)[0]!.toLowerCase();
    if (SLASH_COMMANDS.some((c) => c.cmd === cmd && c.local) && v === cmd) {
      if (onSlash(cmd)) setText('');
      return;
    }
    if (await onSend(v)) setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const pick = suggestions[Math.min(hi, suggestions.length - 1)]!;
        if (pick.cmd !== trimmed || e.key === 'Tab') {
          e.preventDefault();
          setText(pick.local ? pick.cmd : `${pick.cmd} `);
          setHi(0);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const steer = live && trimmed.length > 0;
  return (
    <div className="px-gutter pt-2 pb-3">
      {suggestions.length > 0 && (
        <div
          id={listId}
          role="group"
          aria-label={t('session.composer.slash')}
          className="mb-2 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-pop"
        >
          {suggestions.map((s, i) => (
            <RACButton
              key={s.cmd}
              onPress={() => {
                if (s.local) void submit(s.cmd);
                else {
                  setText(`${s.cmd} `);
                  ref.current?.focus();
                }
              }}
              className={cx(
                'flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus',
                i === hi && 'bg-sunken',
              )}
            >
              <span className="w-20 shrink-0 font-mono text-[13px] text-ink">{s.cmd}</span>
              <span className="min-w-0 flex-1 truncate type-body-sm text-ink-2">
                {t(`session.slash.${s.cmd.slice(1)}` as 'session.slash.stop')}
              </span>
            </RACButton>
          ))}
        </div>
      )}
      {(steer || disabled) && (
        <p className={cx('mb-1.5 px-1 type-micro', disabled ? 'text-ink-2' : 'text-flare-text')} id={hintId}>
          {disabled ? disabledReason : t('session.composer.steerHint', { agent: session.agent })}
        </p>
      )}
      <div
        className={cx(
          'flex items-end gap-1 rounded-[24px] border border-line-strong bg-surface p-1 transition-colors focus-within:border-ink has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-focus',
          disabled && 'opacity-60',
        )}
      >
        <label htmlFor={`composer-${session.id}`} className="sr-only">
          {live
            ? t('session.composer.steerLabel', { agent: session.agent })
            : t('session.composer.label', { agent: session.agent })}
        </label>
        <textarea
          ref={ref}
          id={`composer-${session.id}`}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setHi(0);
          }}
          onKeyDown={onKeyDown}
          enterKeyHint="send"
          aria-describedby={steer || disabled ? hintId : undefined}
          placeholder={
            live
              ? t('session.composer.steerPlaceholder', { agent: session.agent })
              : session.status === 'ended'
                ? t('session.composer.endedPlaceholder', { thread: session.threadId })
                : t('session.composer.placeholder', { agent: session.agent })
          }
          className="min-h-10 flex-1 resize-none bg-transparent py-2 pl-3.5 text-base leading-6 text-ink outline-none placeholder:text-ink-3"
        />
        {live && (
          <RACButton
            onPress={onStop}
            isDisabled={stopping}
            aria-label={t('session.composer.stop', { agent: session.agent })}
            className="grid size-11 shrink-0 place-items-center rounded-full outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[disabled]:opacity-45"
          >
            <span className="grid size-10 place-items-center rounded-full bg-ink text-bg">
              <Stop size={16} weight="fill" aria-hidden="true" />
            </span>
          </RACButton>
        )}
        {(!live || trimmed.length > 0) && (
          <RACButton
            onPress={() => void submit()}
            isDisabled={disabled || !trimmed || sending}
            aria-label={steer ? t('session.composer.steer') : t('session.composer.send')}
            className="grid size-11 shrink-0 place-items-center rounded-full outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[disabled]:cursor-not-allowed"
          >
            <span
              className={cx(
                'grid size-10 place-items-center rounded-full transition-colors',
                trimmed && !disabled ? 'bg-flare text-on-flare' : 'bg-sunken text-ink-3',
              )}
            >
              <ArrowUp size={18} weight="bold" aria-hidden="true" />
            </span>
          </RACButton>
        )}
      </div>
    </div>
  );
};
