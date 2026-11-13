/**
 * Settings → Owners & people (§6 multiple owners, linked identities, approval quorum).
 * - Owners: you + co-owners (`owner.add` / `owner.remove`; at least one owner always remains — the
 *   last owner's Remove is not offered and the reason is stated, never a disabled button).
 * - Approval quorum: how many owners must approve owner-level requests (deploys over the cost cap,
 *   owner changes).
 * - People with roles (global grants from `role.list`), role change (`role.grant`) and revoke.
 * - Linked identities: `principal.link` makes alice on Telegram and alice on Nostr one person.
 *
 * TODO(core): there is no `owner.list` / `config.get` yet, so co-owners added here, the quorum and the
 * linked identities are remembered on this device only (useLocalPref) and the CLI equivalent is shown.
 */
import { npubEncode, tryDecodePubkey } from '@beamhop/channel-nostr/keys';
import { Crown, Link as LinkIcon, Plus, UserCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { middleTruncate } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Badge, MetaLine } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { Group, List, Row, RowMenu, useLocalPref } from './kit.tsx';


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
    await add.mutateAsync({ principal });
    onAdded(principal);
    setRaw('');
    setTouched(false);
    onOpenChange(false);
  };
  return (
    <Sheet
      isOpen={open}
      onOpenChange={onOpenChange}
      title="Add an owner"
      footer={
        <div className="flex flex-col gap-2 expanded:flex-row-reverse">
          <Button variant="primary" size="lg" fullWidth isPending={add.isPending} onPress={() => void submit()}>
            Add owner
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body-sm text-ink-2">
          Owners can do everything you can: change sandboxes, add owners, approve deploys and stop everything.
          The change is signed with your owner key and logged.
        </p>
        <TextField
          label="Their Nostr public key"
          mono
          value={raw}
          onChange={setRaw}
          onBlur={() => setTouched(true)}
          placeholder="npub1…"
          description="Ask them for their npub. Never their nsec."
          isInvalid={touched && !principal}
          errorMessage="That isn't an npub or a 64-character hex key."
        />
        {add.isError && <p className="type-body-sm text-stop-text">{add.error.message}</p>}
      </div>
    </Sheet>
  );
};

export const OwnersSection = () => {
  const status = useApi('system.status');
  const roles = useApi('role.list');
  const grant = useMutationApi('role.grant');
  const revoke = useMutationApi('role.revoke');
  const removeOwner = useMutationApi('owner.remove');
  const link = useMutationApi('principal.link');
  const toast = useToast();
  const [prefs, setPrefs] = useLocalPref('bh.settings.owners', {
    coOwners: [] as string[],
    quorum: 1,
    links: [] as Array<{ person: string; principal: string }>,
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [person, setPerson] = useState('');
  const [linkRaw, setLinkRaw] = useState('');
  const showSkeleton = useDelayedLoading(status.isPending || roles.isPending);

  if (status.isError || roles.isError) {
    const err = status.error ?? roles.error;
    return (
      <ErrorState
        title="Couldn't load owners and roles."
        details={err}
        onRetry={() => {
          void status.refetch();
          void roles.refetch();
        }}
      >
        {err?.message}
      </ErrorState>
    );
  }
  if (!status.data || !roles.data)
    return showSkeleton ? <Skeleton variant="list" count={4} label="Loading owners" /> : null;

  const me = status.data.owner.npub ? `nostr:${status.data.owner.npub}` : undefined;
  const owners = [...(me ? [me] : []), ...prefs.coOwners.filter((o) => o !== me)];
  const quorum = Math.min(prefs.quorum, Math.max(1, owners.length));
  const grants = Object.entries(roles.data.grants).filter(([, r]) => r !== 'owner');
  const roleOptions = roles.data.roles.map((r) => ({ id: r.name, label: r.name, description: r.description }));

  return (
    <div className="flex flex-col gap-8">
      <Group
        title="Owners"
        id="own-owners"
        action={
          <Button variant="quiet" size="sm" icon={<Plus size={16} weight="bold" aria-hidden="true" />} onPress={() => setAdding(true)}>
            Add owner
          </Button>
        }
        note={owners.length === 1 ? "You're the only owner. At least one owner always remains." : undefined}
      >
        <List>
          {owners.map((o) => (
            <Row
              key={o}
              leading={<Crown size={22} aria-hidden="true" />}
              title={o === me ? 'You' : short(o)}
              aside={o === me ? <Badge tone="outline">primary</Badge> : null}
              slug={<MetaLine items={[{ value: o.replace(/^nostr:/, ''), truncate: 26 }, 'owner']} />}
              actions={
                owners.length > 1 && o !== me ? (
                  <RowMenu
                    label={`Actions for ${short(o)}`}
                    items={[{ id: 'remove', label: 'Remove owner…', destructive: true, onAction: () => setRemoving(o) }]}
                  />
                ) : undefined
              }
            />
          ))}
        </List>
      </Group>

      <Group
        title="Approval quorum"
        id="own-quorum"
        note="Deploys over the cost cap and owner changes wait until this many owners approve. Agents' everyday approvals need one."
      >
        {owners.length > 1 ? (
          <SegmentedControl
            label="Owners needed to approve"
            value={String(quorum)}
            onChange={(v) => setPrefs({ quorum: Number(v) })}
            options={owners.map((_, i) => ({ id: String(i + 1), label: `${i + 1} of ${owners.length}` }))}
          />
        ) : (
          <p className="type-body-sm text-ink">1 of 1 · add another owner to require two approvals.</p>
        )}
      </Group>

      <Group
        title="People with roles"
        id="own-people"
        note="Global roles apply to every agent unless an agent overrides them."
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
                      label={`Actions for ${short(principal)}`}
                      items={[
                        ...roleOptions
                          .filter((r) => r.id !== role && r.id !== 'owner')
                          .map((r) => ({
                            id: `role:${r.id}`,
                            label: `Make ${r.label}`,
                            onAction: () =>
                              void grant
                                .mutateAsync({ principal, role: r.id })
                                .then(() => toast.show({ message: `${short(principal)} is now ${r.label}`, tone: 'success' }))
                                .catch((e: Error) => toast.show({ message: e.message, tone: 'error' })),
                          })),
                        {
                          id: 'revoke',
                          label: 'Revoke role',
                          destructive: true,
                          onAction: () =>
                            void revoke
                              .mutateAsync({ principal })
                              .then(() => toast.show({ message: `Revoked · ${short(principal)}`, tone: 'success' })),
                        },
                      ]}
                    />
                  </span>
                }
              />
            ))}
          </List>
        ) : (
          <p className="type-body-sm text-ink-2">Nobody else has a role yet. Grant one from an agent's Access tab.</p>
        )}
      </Group>

      <Group
        title="Linked identities"
        id="own-links"
        note="One person, several accounts: alice on Telegram and alice on Nostr share one role and one budget."
      >
        {prefs.links.length > 0 && (
          <List>
            {prefs.links.map((l) => (
              <Row
                key={`${l.person}-${l.principal}`}
                leading={<LinkIcon size={20} aria-hidden="true" />}
                title={l.person}
                slug={<MetaLine items={[{ value: l.principal, truncate: 30 }]} />}
              />
            ))}
          </List>
        )}
        <form
          className="mt-2 flex flex-col gap-3 medium:flex-row medium:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!person.trim() || !linkRaw.includes(':')) return;
            try {
              await link.mutateAsync({ person: person.trim(), principal: linkRaw.trim() });
              setPrefs({ links: [...prefs.links, { person: person.trim(), principal: linkRaw.trim() }] });
              toast.show({ message: `Linked · ${linkRaw.trim()} → ${person.trim()}`, tone: 'success' });
              setLinkRaw('');
            } catch (err) {
              toast.show({ message: (err as Error).message, tone: 'error' });
            }
          }}
        >
          <TextField label="Person" value={person} onChange={setPerson} placeholder="alice" className="medium:w-40" />
          <TextField
            label="Account"
            mono
            value={linkRaw}
            onChange={setLinkRaw}
            placeholder="telegram:5551"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" isPending={link.isPending} isDisabled={!person.trim() || !linkRaw.includes(':')}>
            Link
          </Button>
        </form>
      </Group>

      <CliStrip command={`beamhop owner add npub1… && beamhop config set approvals.quorum ${quorum}`} />

      <AddOwnerSheet
        open={adding}
        onOpenChange={setAdding}
        onAdded={(p) => {
          setPrefs({ coOwners: [...prefs.coOwners.filter((o) => o !== p), p] });
          toast.show({ message: `Added owner · ${short(p)}`, tone: 'success' });
        }}
      />
      <ConfirmDialog
        isOpen={!!removing}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        title={`Remove ${removing ? short(removing) : ''} as owner?`}
        confirmLabel="Remove owner"
        isPending={removeOwner.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeOwner.mutateAsync({ principal: removing });
          } catch (e) {
            toast.show({ message: (e as Error).message, tone: 'error' });
            return;
          }
          setPrefs({ coOwners: prefs.coOwners.filter((o) => o !== removing), quorum: Math.min(quorum, owners.length - 1) });
          toast.show({ message: `Removed owner · ${short(removing)}`, tone: 'success' });
          setRemoving(undefined);
        }}
      >
        They lose owner rights on every agent right away. Their devices stay paired until you remove them in Devices.
      </ConfirmDialog>
    </div>
  );
};
