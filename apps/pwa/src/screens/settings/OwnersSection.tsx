/**
 * Settings → Owners & people (§6 multiple owners, linked identities, approval quorum).
 * - Owners: `owner.list` (+ `owner.add` / `owner.remove`; at least one owner always remains — the
 *   last owner's Remove is not offered and the reason is stated, never a disabled button). "You" is
 *   the owner whose principal or linked person matches `system.whoami`.
 * - Approval quorum: `approval.quorumGet` / `approval.quorumSet` — N of the approver pool.
 * - People with roles (global grants from `role.list`), role change (`role.grant`) and revoke.
 * - Linked identities: `principal.list` / `principal.link` / `principal.unlink` make alice on
 *   Telegram and alice on Nostr one person.
 */
import { npubEncode, tryDecodePubkey } from '@beamhop/channel-nostr/keys';
import { Crown, Link as LinkIcon, Plus, UserCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { middleTruncate } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Badge, MetaLine } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { Group, List, Row, RowMenu } from './kit.tsx';

/** `npub1…`, hex, or `nostr:npub1…` → canonical `nostr:npub1…` principal, or null. */
export const ownerPrincipal = (raw: string): string | null => {
  const s = raw.trim().replace(/^nostr:/, '');
  const hex = tryDecodePubkey(s);
  return hex ? `nostr:${npubEncode(hex)}` : null;
};

const short = (p: string) => middleTruncate(p.replace(/^nostr:/, ''), 22);

const AddOwnerSheet = ({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: (principal: string) => void;
}) => {
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const add = useMutationApi('owner.add');
  const principal = ownerPrincipal(raw);
  const submit = async () => {
    setTouched(true);
    if (!principal) return;
    try {
      await add.mutateAsync({ principal });
    } catch {
      return; // shown below the field
    }
    onAdded(principal);
    setRaw('');
    setTouched(false);
    onOpenChange(false);
  };
  return (
    <Sheet
      isOpen={open}
      onOpenChange={onOpenChange}
      title={t('settings.owners.addAnOwner')}
      footer={
        <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            isPending={add.isPending}
            onPress={() => void submit()}
          >
            {t('settings.owners.addOwner')}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={() => onOpenChange(false)}>
            {t('settings.identity.cancel')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body-sm text-ink-2">{t('settings.owners.ownersCanDoEverything')}</p>
        <TextField
          label={t('settings.owners.theirNostrPublicKey')}
          mono
          value={raw}
          onChange={setRaw}
          onBlur={() => setTouched(true)}
          placeholder="npub1…"
          description={t('settings.owners.askThemForTheir')}
          isInvalid={touched && !principal}
          errorMessage={t('settings.owners.thatIsnTAn')}
        />
        {add.isError && <p className="type-body-sm text-stop-text">{add.error.message}</p>}
      </div>
    </Sheet>
  );
};

export const OwnersSection = () => {
  const ownersQ = useApi('owner.list');
  const whoami = useApi('system.whoami');
  const quorumQ = useApi('approval.quorumGet');
  const peopleQ = useApi('principal.list');
  const roles = useApi('role.list');
  const grant = useMutationApi('role.grant');
  const revoke = useMutationApi('role.revoke');
  const removeOwner = useMutationApi('owner.remove');
  const link = useMutationApi('principal.link');
  const unlink = useMutationApi('principal.unlink');
  const setQuorum = useMutationApi('approval.quorumSet');
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [person, setPerson] = useState('');
  const [linkRaw, setLinkRaw] = useState('');
  const queries = [ownersQ, quorumQ, peopleQ, roles];
  const showSkeleton = useDelayedLoading(queries.some((q) => q.isPending));

  const failed = queries.find((q) => q.isError);
  if (failed) {
    return (
      <ErrorState
        title="Couldn't load owners and roles."
        details={failed.error}
        onRetry={() => {
          for (const q of queries) if (q.isError) void q.refetch();
        }}
      >
        {failed.error?.message}
      </ErrorState>
    );
  }
  if (!ownersQ.data || !quorumQ.data || !peopleQ.data || !roles.data)
    return showSkeleton ? <Skeleton variant="list" count={4} label="Loading owners" /> : null;

  const you = whoami.data;
  const isYou = (o: { principal: string; person?: string }) =>
    !!you && (o.principal === you.principal || (!!you.person && o.person === you.person));
  const owners = ownersQ.data.owners;
  const { quorum, approvers } = quorumQ.data;
  const seats = Math.max(approvers, quorum, 1);
  const people = Object.entries(peopleQ.data.people).sort(([a], [b]) => a.localeCompare(b));
  const grants = Object.entries(roles.data.grants).filter(([, r]) => r !== 'owner');
  const roleOptions = roles.data.roles.map((r) => ({
    id: r.name,
    label: r.name,
    description: r.description,
  }));

  return (
    <div className="flex flex-col gap-8">
      <Group
        title={t('settings.owners.owners')}
        id="own-owners"
        action={
          <Button
            variant="quiet"
            size="sm"
            icon={<Plus size={16} weight="bold" aria-hidden="true" />}
            onPress={() => setAdding(true)}
          >
            {t('settings.owners.addOwner')}
          </Button>
        }
        note={
          owners.length <= 1
            ? owners.some(isYou)
              ? "You're the only owner. At least one owner always remains."
              : 'At least one owner always remains.'
            : undefined
        }
      >
        <List>
          {owners.map((o) => (
            <Row
              key={o.principal}
              leading={<Crown size={22} aria-hidden="true" />}
              title={isYou(o) ? 'You' : (o.person ?? short(o.principal))}
              aside={isYou(o) ? <Badge tone="outline">you</Badge> : null}
              slug={
                <MetaLine
                  items={[
                    { value: o.principal.replace(/^nostr:/, ''), truncate: 26 },
                    'owner',
                    o.linked.length > 0 ? `+${o.linked.length} linked` : undefined,
                  ]}
                />
              }
              actions={
                owners.length > 1 && !isYou(o) ? (
                  <RowMenu
                    label={t('settings.actionsFor', { name: short(o.principal) })}
                    items={[
                      {
                        id: 'remove',
                        label: t('settings.owners.removeOwner'),
                        destructive: true,
                        onAction: () => setRemoving(o.principal),
                      },
                    ]}
                  />
                ) : undefined
              }
            />
          ))}
        </List>
      </Group>

      <Group
        title={t('settings.owners.approvalQuorum')}
        id="own-quorum"
        note="Requests wait until this many approvers say yes. Approvers are the owners plus people whose role can approve."
      >
        {seats > 1 ? (
          <SegmentedControl
            label="Approvals needed"
            value={String(quorum)}
            onChange={(v) =>
              void setQuorum
                .mutateAsync({ quorum: Number(v) })
                .then((r) =>
                  toast.show({ message: `Quorum · ${r.quorum} of ${r.approvers}`, tone: 'success' }),
                )
                .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }))
            }
            options={Array.from({ length: seats }, (_, i) => ({
              id: String(i + 1),
              label: `${i + 1} of ${approvers}`,
            }))}
          />
        ) : (
          <p className="type-body-sm text-ink">{t('settings.owners.1Of1Add')}</p>
        )}
        {quorum > approvers && (
          <p className="mt-2 type-body-sm text-caution-text">
            {quorum} approvals are needed but only {approvers} can approve. Requests will expire until you add
            an owner or lower the quorum.
          </p>
        )}
      </Group>

      <Group
        title={t('settings.owners.peopleWithRoles')}
        id="own-people"
        note={t('settings.owners.globalRolesApplyTo')}
      >
        {grants.length ? (
          <List>
            {grants.map(([principal, role]) => (
              <Row
                key={principal}
                leading={<UserCircle size={22} aria-hidden="true" />}
                title={short(principal)}
                slug={<MetaLine items={[principal.split(':')[0] ?? 'nostr', role]} />}
                actions={
                  <span className="flex items-center gap-1">
                    <RowMenu
                      label={t('settings.actionsFor', { name: short(principal) })}
                      items={[
                        ...roleOptions
                          .filter((r) => r.id !== role && r.id !== 'owner')
                          .map((r) => ({
                            id: `role:${r.id}`,
                            label: `Make ${r.label}`,
                            onAction: () =>
                              void grant
                                .mutateAsync({ principal, role: r.id })
                                .then(() =>
                                  toast.show({
                                    message: `${short(principal)} is now ${r.label}`,
                                    tone: 'success',
                                  }),
                                )
                                .catch((e: Error) => toast.show({ message: e.message, tone: 'error' })),
                          })),
                        {
                          id: 'revoke',
                          label: t('settings.owners.revokeRole'),
                          destructive: true,
                          onAction: () =>
                            void revoke
                              .mutateAsync({ principal })
                              .then(() =>
                                toast.show({ message: `Revoked · ${short(principal)}`, tone: 'success' }),
                              ),
                        },
                      ]}
                    />
                  </span>
                }
              />
            ))}
          </List>
        ) : (
          <p className="type-body-sm text-ink-2">{t('settings.owners.nobodyElseHasA')}</p>
        )}
      </Group>

      <Group
        title={t('settings.owners.linkedIdentities')}
        id="own-links"
        note={t('settings.owners.onePersonSeveralAccounts')}
      >
        {people.length > 0 && (
          <List>
            {people.flatMap(([name, principals]) =>
              principals.map((principal) => (
                <Row
                  key={`${name}-${principal}`}
                  leading={<LinkIcon size={20} aria-hidden="true" />}
                  title={name}
                  aside={you?.principal === principal ? <Badge tone="outline">this browser</Badge> : null}
                  slug={<MetaLine items={[{ value: principal, truncate: 30 }]} />}
                  actions={
                    <RowMenu
                      label={`Actions for ${principal}`}
                      items={[
                        {
                          id: 'unlink',
                          label: `Unlink from ${name}`,
                          destructive: true,
                          onAction: () =>
                            void unlink
                              .mutateAsync({ person: name, principal })
                              .then(() => toast.show({ message: `Unlinked · ${principal}`, tone: 'success' }))
                              .catch((e: Error) => toast.show({ message: e.message, tone: 'error' })),
                        },
                      ]}
                    />
                  }
                />
              )),
            )}
          </List>
        )}
        <form
          className="mt-2 flex flex-col gap-3 medium:flex-row medium:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!person.trim() || !linkRaw.includes(':')) return;
            try {
              await link.mutateAsync({ person: person.trim(), principal: linkRaw.trim() });
              toast.show({ message: `Linked · ${linkRaw.trim()} → ${person.trim()}`, tone: 'success' });
              setLinkRaw('');
            } catch (err) {
              toast.show({ message: (err as Error).message, tone: 'error' });
            }
          }}
        >
          <TextField
            label={t('settings.owners.person')}
            value={person}
            onChange={setPerson}
            placeholder="alice"
            className="medium:w-40"
          />
          <TextField
            label={t('settings.owners.account')}
            mono
            value={linkRaw}
            onChange={setLinkRaw}
            placeholder="telegram:5551"
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            variant="secondary"
            isPending={link.isPending}
            isDisabled={!person.trim() || !linkRaw.includes(':')}
          >
            {t('settings.owners.link')}
          </Button>
        </form>
      </Group>

      <CliStrip command="beamhop owner add npub1…" />

      <AddOwnerSheet
        open={adding}
        onOpenChange={setAdding}
        onAdded={(p) => {
          toast.show({ message: `Added owner · ${short(p)}`, tone: 'success' });
        }}
      />
      <ConfirmDialog
        isOpen={!!removing}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        title={t('settings.owners.removeTitle', { name: removing ? short(removing) : '' })}
        confirmLabel={t('settings.owners.removeOwner2')}
        isPending={removeOwner.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeOwner.mutateAsync({ principal: removing });
          } catch (e) {
            toast.show({ message: (e as Error).message, tone: 'error' });
            return;
          }
          toast.show({ message: `Removed owner · ${short(removing)}`, tone: 'success' });
          setRemoving(undefined);
        }}
      >
        {t('settings.owners.theyLoseOwnerRights')}
      </ConfirmDialog>
    </div>
  );
};
