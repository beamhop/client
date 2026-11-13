/**
 * Resumable wizard drafts (JOURNEYS §4: "leaving to the provider's site is safe").
 * One draft per provider in localStorage `bh.channelDraft.<provider>`. **Secrets are never stored**:
 * before `channel.add` the token lives only in memory; after it, it lives in the daemon's keychain.
 * A reload before Connect means pasting the token again; everything else comes back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChannelDraft {
  provider: string;
  /** Last step (1-based) the user was on. */
  step: number;
  /** Chosen channel name and whether the user typed it (otherwise it follows the bot handle). */
  name?: string;
  nameEdited?: boolean;
  /** Non-secret values (relay, group, intent checkbox…). */
  values: Record<string, unknown>;
  /** Discord/Telegram checklist the user ticked on Create. */
  checklist?: string[];
  identity?: { name: string; handle?: string };
  /** Set once `channel.add` succeeded: from here on the wizard is about this channel. */
  channel?: string;
  /** Pair code issued for this draft (re-used on reload until it expires). */
  pair?: { code: string; expiresAt: string; issuedAt: string };
  /** Principal the owner confirmed as "This is me". */
  confirmed?: string;
  /** Discord application id (from the token) for the invite link. */
  clientId?: string;
  updatedAt: string;
}

const KEY = (provider: string) => `bh.channelDraft.${provider}`;
const EVENT = 'bh-channel-draft';

export const readDraft = (provider: string): ChannelDraft | undefined => {
  try {
    const raw = localStorage.getItem(KEY(provider));
    if (!raw) return undefined;
    const d = JSON.parse(raw) as ChannelDraft;
    return d && d.provider === provider ? d : undefined;
  } catch {
    return undefined;
  }
};

export const writeDraft = (d: ChannelDraft) => {
  try {
    localStorage.setItem(KEY(d.provider), JSON.stringify(d));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage full / blocked: the wizard still works, it just won't resume */
  }
};

export const clearDraft = (provider: string) => {
  try {
    localStorage.removeItem(KEY(provider));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* ignore */
  }
};

/** Drafts older than a day are stale (pair codes expire after 10 min; tokens may have been reset). */
const FRESH_MS = 24 * 60 * 60 * 1000;

/** Worth offering to resume: something happened beyond opening a step. */
export const hasProgress = (d: ChannelDraft): boolean =>
  !!d.channel || !!d.values.openedCreate || (d.checklist?.length ?? 0) > 0 || !!d.values.relay;

export const listDrafts = (providers: string[]): ChannelDraft[] =>
  providers
    .map(readDraft)
    .filter(
      (d): d is ChannelDraft =>
        !!d && Date.now() - new Date(d.updatedAt).getTime() < FRESH_MS && hasProgress(d),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const useDrafts = (providers: string[]): ChannelDraft[] => {
  const key = providers.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: providers is keyed by `key`
  const read = useCallback(() => listDrafts(providers), [key]);
  const [drafts, setDrafts] = useState(read);
  useEffect(() => {
    const on = () => setDrafts(read());
    on();
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener('storage', on);
    };
  }, [read]);
  return drafts;
};

/** Draft state for one wizard. `patch` merges and persists. */
export const useDraft = (provider: string) => {
  const [draft, setDraft] = useState<ChannelDraft>(
    () => readDraft(provider) ?? { provider, step: 1, values: {}, updatedAt: new Date().toISOString() },
  );
  const ref = useRef(draft);
  ref.current = draft;
  const patch = useCallback((p: Partial<ChannelDraft>) => {
    const d = ref.current;
    const next = {
      ...d,
      ...p,
      values: { ...d.values, ...(p.values ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    ref.current = next;
    setDraft(next);
    writeDraft(next);
  }, []);
  const reset = useCallback(() => {
    clearDraft(provider);
    setDraft({ provider, step: 1, values: {}, updatedAt: new Date().toISOString() });
  }, [provider]);
  return { draft, patch, reset };
};
