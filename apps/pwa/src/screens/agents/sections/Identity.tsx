/**
 * Identity: the agent's own Nostr key (npub, copy), kind-0 profile (name, about — the AI disclosure line
 * is fixed and not removable), NIP-05 handle (domain setup lives in Settings → Identity), the relays it
 * publishes to, and a preview of how Nostr clients will show it.
 */
import type { AgentView } from '@beamhop/core';
import { CellTower, LockSimple } from '@phosphor-icons/react';
import { useApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { middleTruncate } from '../../../lib/format.ts';
import { TextLink } from '../../../ui/Button.tsx';
import { Card } from '../../../ui/Card.tsx';
import { CopyButton } from '../../../ui/CliStrip.tsx';
import { TextField } from '../../../ui/Field.tsx';
import { LetterTile, MetaLine } from '../../../ui/Meta.tsx';
import { StatusDot } from '../../../ui/Status.tsx';
import { validateNip05 } from '../model.ts';
import { Block, Rows, SaveBar, useAgentDraft } from '../parts.tsx';

export const IdentitySection = ({ agent }: { agent: AgentView }) => {
  const d = useAgentDraft(agent);
  const c = d.draft;
  const name = c.name;
  const status = useApi('system.status');
  const channels = useApi('channel.list');
  const owner = status.data?.owner.npub;
  const disclosure = t('agents.aiDisclosure', { owner: owner ? middleTruncate(owner, 14) : t('agents.you') });
  const nostr = channels.data?.channels.find((x) => x.config.provider === 'nostr');
  const relays = (nostr?.config.settings.relays as string[] | undefined) ?? [];
  const up = new Set((nostr?.config.settings.relaysUp as string[] | undefined) ?? []);
  const nipErr = validateNip05(c.identity.nip05 ?? '');
  const npub = c.identity.npub;

  return (
    <div className="flex flex-col gap-10">
      <Block id="id-key" title={t('agents.id.key')} description={t('agents.id.keyHint', { name })}>
        {npub ? (
          <div className="flex items-center gap-1 rounded-md border border-line-strong bg-sunken pl-3">
            <code className="min-w-0 flex-1 truncate type-meta text-ink" title={npub}>
              {npub}
            </code>
            <CopyButton value={npub} label={t('agents.copyNpub')} />
          </div>
        ) : (
          <p className="type-body-sm text-ink-2">{t('agents.id.noKey')}</p>
        )}
        {c.identity.nostrKeyRef && (
          <MetaLine items={[t('agents.id.keyRef'), { value: c.identity.nostrKeyRef }]} />
        )}
      </Block>

      <Block
        id="id-profile"
        title={t('agents.id.profile')}
        cli={`beamhop agent set ${name} --display-name "${c.displayName ?? name}"`}
      >
        <TextField
          label={t('agents.id.displayName')}
          value={c.displayName ?? ''}
          placeholder={name}
          onChange={(v) => d.set((x) => ({ ...x, displayName: v || undefined }))}
        />
        <TextField
          label={t('agents.id.about')}
          value={c.description}
          multiline
          rows={3}
          onChange={(v) => d.set((x) => ({ ...x, description: v }))}
        />
        <p className="flex items-center gap-1.5 type-meta text-ink-2">
          <LockSimple size={12} weight="bold" aria-hidden="true" />
          {t('agents.id.fixedLine', { line: disclosure })}
        </p>
        <TextField
          label={t('agents.id.nip05')}
          value={c.identity.nip05 ?? ''}
          mono
          placeholder={`${name}@example.com`}
          onChange={(v) =>
            d.set((x) => ({ ...x, identity: { ...x.identity, nip05: v.trim() || undefined } }))
          }
          isInvalid={!!nipErr}
          errorMessage={nipErr}
          description={
            <>
              {t('agents.id.nip05Hint')}{' '}
              <TextLink href="/settings/identity">{t('agents.id.nip05Link')}</TextLink>
            </>
          }
        />
      </Block>

      <Block id="id-preview" title={t('agents.id.preview')} description={t('agents.id.previewHint')}>
        <Card>
          <div className="flex items-start gap-3">
            <LetterTile code={name.slice(0, 2).toUpperCase()} size={40} tone="ink" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="type-title-3 text-ink">{c.displayName || name}</p>
              <MetaLine
                items={[
                  c.identity.nip05 && !nipErr ? c.identity.nip05 : undefined,
                  npub && { value: npub, truncate: 16 },
                ]}
              />
              {c.description && <p className="mt-1 type-body-sm text-ink">{c.description}</p>}
              <p className="mt-1 type-body-sm text-ink-2">{disclosure}</p>
            </div>
          </div>
        </Card>
      </Block>

      <Block
        id="id-relays"
        title={t('agents.id.relays', { count: relays.length })}
        description={t('agents.id.relaysHint')}
      >
        {relays.length ? (
          <Rows label={t('agents.id.relaysLabel')}>
            {relays.map((r) => (
              <li key={r} className="flex min-h-12 items-center gap-3 px-4 py-2">
                <CellTower size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1 truncate type-meta text-ink">
                  {r.replace(/^wss:\/\//, '')}
                </span>
                <StatusDot
                  state={up.has(r) ? 'ready' : 'offline'}
                  label={up.has(r) ? t('agents.id.up') : t('agents.id.down')}
                />
              </li>
            ))}
          </Rows>
        ) : (
          <p className="type-body-sm text-ink-2">{t('agents.id.noRelays')}</p>
        )}
        <TextLink href="/channels" className="self-start type-body-sm">
          {t('agents.id.editRelays')}
        </TextLink>
      </Block>
      <SaveBar agent={agent} d={d} />
    </div>
  );
};
