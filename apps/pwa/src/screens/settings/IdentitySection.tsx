/**
 * Settings → Identity & NIP-05 (SCREENS §10). Owner key (copy, backup export once), the daemon's
 * control key, agent npubs with attestation state (publish), and a NIP-05 generator: domain → names →
 * generated `nostr.json` (copy / download) → hosting snippets (static, nginx, Cloudflare Pages) →
 * live `Check handle`.
 * NIP-05 reference: https://github.com/nostr-protocol/nips/blob/master/05.md (CORS header required).
 */
import { tryDecodePubkey } from '@beamhop/channel-nostr/keys';
import { Cpu, DownloadSimple, Key, LockSimple, MagnifyingGlass, SealCheck } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { middleTruncate } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { Checkbox, Tabs } from '../../ui/Choice.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Badge, MetaLine } from '../../ui/Meta.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { Group, List, Row } from './kit.tsx';

export const DOMAIN_RE = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
export const NIP05_NAME_RE = /^[a-z0-9._-]+$/;

/** Clean what people paste: `https://example.com/` → `example.com`. */
export const normalizeDomain = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

const KeyLine = ({ value, label }: { value: string; label: string }) => (
  <div className="flex min-w-0 items-center gap-1">
    <code title={value} className="min-w-0 flex-1 truncate type-meta text-ink">
      {middleTruncate(value, 28)}
    </code>
    <CopyButton value={value} label={t('settings.identity.copy', { label })} compact />
  </div>
);

// ─────────── backup ───────────
const BackupSheet = ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => {
  const exp = useMutationApi('identity.ownerExport');
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => {
        if (!o) exp.reset();
        onOpenChange(o);
      }}
      title={t('settings.identity.exportOwnerKeyBackup')}
      isDismissable={false}
      focusTitle
      footer={
        exp.data ? (
          <Button variant="secondary" size="lg" fullWidth onPress={() => onOpenChange(false)}>
            {t('settings.identity.iVeStoredIt')}
          </Button>
        ) : (
          <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              isPending={exp.isPending}
              onPress={() => exp.mutate({})}
            >
              {t('settings.identity.revealSecretKey')}
            </Button>
            <Button variant="secondary" size="lg" fullWidth onPress={() => onOpenChange(false)}>
              {t('settings.identity.cancel')}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-3 type-body text-ink-2">
        <p>{t('settings.identity.anyoneWithThisKey')}</p>
        <p className="type-body-sm">{t('settings.identity.shownOnceOnlyOn')}</p>
        {exp.isError && (
          <ErrorState title={t('settings.identity.couldnTExportThe')} details={exp.error}>
            {exp.error.message}
          </ErrorState>
        )}
        {exp.data && (
          <CodeBlock code={exp.data.nsec} label={t('settings.identity.ownerSecretKeyNsec')} wrap />
        )}
      </div>
    </Sheet>
  );
};

// ─────────── NIP-05 ───────────
type CheckResult = { ok: boolean; text: string };

const checkHandle = async (domain: string, name: string, hex: string): Promise<CheckResult> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, {
      signal: ctl.signal,
    });
    if (!r.ok) return { ok: false, text: `${domain} answered ${r.status}. Upload nostr.json first.` };
    const j = (await r.json()) as { names?: Record<string, string> };
    const got = j.names?.[name];
    if (!got) return { ok: false, text: `nostr.json has no entry for "${name}".` };
    return got.toLowerCase() === hex.toLowerCase()
      ? { ok: true, text: `${name}@${domain} resolves to this agent.` }
      : { ok: false, text: `${name}@${domain} points to a different key.` };
  } catch {
    return {
      ok: false,
      text: `Couldn't fetch https://${domain}/.well-known/nostr.json. It may not be uploaded yet, or the CORS header is missing.`,
    };
  } finally {
    clearTimeout(timer);
  }
};

const Nip05 = ({ agents }: { agents: Array<{ name: string; npub?: string }> }) => {
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  // nostr.json wants hex keys; anything we cannot decode is passed through for the daemon to reject.
  const withKeys = agents.filter((a) => !!a.npub);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(withKeys.map((a) => a.name)));
  const gen = useMutationApi('identity.nip05');
  const [checks, setChecks] = useState<Record<string, CheckResult | 'busy'>>({});
  const domain = normalizeDomain(raw);
  const valid = DOMAIN_RE.test(domain);
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const a of withKeys)
      if (picked.has(a.name) && NIP05_NAME_RE.test(a.name)) out[a.name] = tryDecodePubkey(a.npub!) ?? a.npub!;
    return out;
  }, [withKeys, picked]);

  const download = (json: string) => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nostr.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="type-body-sm text-ink-2">
        {t('settings.identity.nip05Lead')} <span className="font-mono text-ink">reviewer@example.com</span>{' '}
        {t('settings.identity.nip05Tail')}
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid && Object.keys(names).length) gen.mutate({ domain, names });
        }}
      >
        <TextField
          label={t('settings.identity.domain')}
          mono
          value={raw}
          onChange={setRaw}
          onBlur={() => setTouched(true)}
          placeholder="example.com"
          description={t('settings.identity.theDomainYouControl')}
          isInvalid={touched && raw.length > 0 && !valid}
          errorMessage={t('settings.identity.thatDoesnTLook')}
        />
        <fieldset className="flex flex-col">
          <legend className="type-label text-ink">{t('settings.identity.agentsToInclude')}</legend>
          {withKeys.map((a) => (
            <Checkbox
              key={a.name}
              isSelected={picked.has(a.name)}
              onChange={(on) =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (on) n.add(a.name);
                  else n.delete(a.name);
                  return n;
                })
              }
              description={
                <span className="font-mono text-[12px]">
                  {a.name}@{valid ? domain : 'example.com'}
                </span>
              }
            >
              {a.name}
            </Checkbox>
          ))}
        </fieldset>
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          isPending={gen.isPending}
          isDisabled={!Object.keys(names).length}
        >
          {t('settings.identity.generateNostrJson')}
        </Button>
      </form>
      {gen.isError && (
        <ErrorState title={t('settings.identity.couldnTGenerateNostr')} details={gen.error}>
          {gen.error.message}
        </ErrorState>
      )}
      {gen.data && (
        <div className="flex flex-col gap-4" data-nip05="result">
          <CodeBlock code={gen.data.json} label={`https://${domain}/.well-known/nostr.json`} />
          <Button
            variant="quiet"
            size="sm"
            className="-mt-2 self-start"
            icon={<DownloadSimple size={16} aria-hidden="true" />}
            onPress={() => download(gen.data.json)}
          >
            {t('settings.identity.downloadNostrJson')}
          </Button>
          <Tabs
            label={t('settings.identity.hosting')}
            tabs={Object.entries(gen.data.snippets).map(([id, code]) => ({
              id,
              label: { static: 'Static host', nginx: 'nginx', cloudflare: 'Cloudflare Pages' }[id] ?? id,
              content: <CodeBlock code={code} label={`${id} snippet`} wrap />,
            }))}
          />
          <div className="flex flex-col gap-2">
            <span className="type-label text-ink">{t('settings.identity.checkHandles')}</span>
            {Object.entries(names).map(([n, hex]) => {
              const c = checks[n];
              return (
                <div key={n} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button
                    variant="quiet"
                    size="sm"
                    className="-ml-3"
                    icon={<MagnifyingGlass size={16} aria-hidden="true" />}
                    isPending={c === 'busy'}
                    onPress={async () => {
                      setChecks((s) => ({ ...s, [n]: 'busy' }));
                      const r = await checkHandle(domain, n, hex);
                      setChecks((s) => ({ ...s, [n]: r }));
                    }}
                  >
                    {t('settings.identity.checkHandle', { handle: `${n}@${domain}` })}
                  </Button>
                  {c && c !== 'busy' && (
                    <span role="status" className="flex items-center gap-2">
                      <StatusDot
                        state={c.ok ? 'ready' : 'error'}
                        label={c.ok ? 'resolves' : t('settings.identity.notYet')}
                      />
                      <span className="type-body-sm text-ink-2">{c.text}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export const IdentitySection = () => {
  const q = useApi('identity.get');
  const toast = useToast();
  const publish = useMutationApi('identity.publish', { invalidate: ['identity.get'] });
  const [backup, setBackup] = useState(false);
  const showSkeleton = useDelayedLoading(q.isPending);

  if (q.isError)
    return (
      <ErrorState
        title={t('settings.identity.couldnTLoadIdentities')}
        details={q.error}
        onRetry={() => void q.refetch()}
      >
        {q.error.message}
      </ErrorState>
    );
  if (q.isPending)
    return showSkeleton ? (
      <Skeleton variant="detail" count={3} label={t('settings.identity.loadingIdentities')} />
    ) : null;
  const id = q.data;

  return (
    <div className="flex flex-col gap-8">
      <Group title={t('settings.identity.ownerKey')} id="id-owner">
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          {id.npub ? (
            <>
              <div className="flex items-center gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-ink text-bg">
                  <Key size={16} weight="bold" aria-hidden="true" />
                </span>
                <span className="type-title-3 text-ink">{t('settings.identity.you')}</span>
                <Badge tone={id.ownerKeyHeld ? 'neutral' : 'outline'}>
                  {id.ownerKeyHeld
                    ? t('settings.identity.inOsKeychain')
                    : t('settings.identity.yourOwnSigner')}
                </Badge>
              </div>
              <KeyLine value={id.npub} label={t('settings.identity.ownerNpub')} />
              <p className="type-body-sm text-ink-2">{t('settings.identity.signsRoleChangesPairings')}</p>
              {id.ownerKeyHeld && (
                <Button
                  variant="secondary"
                  className="self-start"
                  icon={<LockSimple size={16} aria-hidden="true" />}
                  onPress={() => setBackup(true)}
                >
                  {t('settings.identity.exportBackup')}
                </Button>
              )}
            </>
          ) : (
            <p className="type-body-sm text-ink-2">
              {t('settings.identity.noOwnerKey')}{' '}
              <code className="font-mono text-ink">beamhop identity create</code>.
            </p>
          )}
        </div>
      </Group>

      {id.daemonNpub && (
        <Group
          title={t('settings.identity.thisDaemon')}
          id="id-daemon"
          note={t('settings.identity.pairedDevicesSendEncrypted')}
        >
          <div className="rounded-lg border border-line bg-surface px-4 py-3">
            <KeyLine value={id.daemonNpub} label={t('settings.identity.daemonNpub')} />
          </div>
        </Group>
      )}

      <Group
        title={t('settings.identity.agents')}
        id="id-agents"
        note={t('settings.identity.attestedYourOwnerKey')}
      >
        <List>
          {id.agents.map((a) => (
            <Row
              key={a.name}
              leading={<Cpu size={22} aria-hidden="true" />}
              title={a.name}
              aside={
                a.attested ? (
                  <span className="inline-flex items-center gap-1 type-meta text-go-text">
                    <SealCheck size={14} weight="bold" aria-hidden="true" />
                    attested
                  </span>
                ) : (
                  <span className="type-meta text-ink-2">{t('settings.identity.notAttested')}</span>
                )
              }
              slug={
                <MetaLine
                  items={[
                    a.npub ? { value: a.npub, truncate: 22 } : t('settings.identity.noKeyYet'),
                    a.nip05 && { value: a.nip05, tone: 'ink' },
                  ]}
                />
              }
              actions={
                <span className="flex items-center">
                  {a.npub && (
                    <CopyButton
                      value={a.npub}
                      label={t('settings.identity.copyNpub', { name: a.name })}
                      compact
                    />
                  )}
                  {!a.attested && (
                    <Button
                      variant="quiet"
                      size="sm"
                      isPending={publish.isPending && publish.variables?.name === a.name}
                      onPress={async () => {
                        try {
                          const r = await publish.mutateAsync({ name: a.name });
                          toast.show({
                            message:
                              r.attestation === 'published'
                                ? `Published · ${a.name} profile + attestation`
                                : r.attestation === 'needs-owner-signature'
                                  ? `Published · ${a.name} profile. Sign the attestation with your owner key.`
                                  : `Published · ${a.name} profile`,
                            tone: 'success',
                          });
                        } catch (e) {
                          toast.show({ message: (e as Error).message, tone: 'error' });
                        }
                      }}
                    >
                      {t('settings.identity.publish')}
                    </Button>
                  )}
                </span>
              }
            />
          ))}
        </List>
      </Group>

      <Group title={t('settings.identity.nip05Handles')} id="id-nip05">
        <Nip05 agents={id.agents} />
      </Group>

      <CliStrip command="beamhop identity nip05 example.com --names reviewer,help" />
      <BackupSheet open={backup} onOpenChange={setBackup} />
    </div>
  );
};
