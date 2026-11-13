/**
 * Settings → Secrets (§8 vault). Names only: values are write-only from the PWA — set or replace,
 * never shown again. Delete names the consequence (agents/channels referencing it stop authenticating).
 */
import { Key, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { ago } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { SecretField, TextField } from '../../ui/Field.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { Group, List, Row, RowMenu } from './kit.tsx';

export const SECRET_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/;

const SetSecretSheet = ({
  name: fixed,
  open,
  onOpenChange,
}: {
  name?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const set = useMutationApi('secret.set');
  const toast = useToast();
  const n = fixed ?? name.trim();
  const nameOk = SECRET_NAME_RE.test(n);
  const close = () => {
    setName('');
    setValue('');
    setTouched(false);
    set.reset();
    onOpenChange(false);
  };
  const save = async () => {
    setTouched(true);
    if (!nameOk || !value) {
      haptic('error');
      return;
    }
    try {
      await set.mutateAsync({ name: n, value });
      toast.show({ message: `Saved to keychain · ${n}`, tone: 'success' });
      close();
    } catch {
      /* shown inline */
    }
  };
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={fixed ? `Replace ${fixed}` : 'Add a secret'}
      isDismissable={false}
      footer={
        <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
          <Button variant="primary" size="lg" fullWidth isPending={set.isPending} onPress={() => void save()}>
            {fixed ? 'Replace value' : 'Save to keychain'}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={close}>
            Cancel
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!fixed && (
          <TextField
            label="Name"
            mono
            value={name}
            onChange={setName}
            placeholder="ANTHROPIC_API_KEY"
            description="Letters, digits, _ . / -. Agents and channels refer to secrets by this name."
            isInvalid={touched && !nameOk}
            errorMessage="Use letters, digits and _ . / - only (max 128)."
          />
        )}
        <SecretField
          label="Value"
          value={value}
          onChange={setValue}
          isInvalid={touched && !value}
          description="Stored in the OS keychain on this computer. beamhop never shows it again."
        />
        {set.isError && <p className="type-body-sm text-stop-text">{set.error.message}</p>}
      </form>
    </Sheet>
  );
};

export const SecretsSection = () => {
  const q = useApi('secret.list');
  const del = useMutationApi('secret.delete');
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const showSkeleton = useDelayedLoading(q.isPending);

  if (q.isError)
    return (
      <ErrorState title="Couldn't read the secret store." details={q.error} onRetry={() => void q.refetch()}>
        {q.error.message}
      </ErrorState>
    );
  if (q.isPending) return showSkeleton ? <Skeleton variant="list" count={5} label="Loading secrets" /> : null;
  const secrets = [...q.data.secrets].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-8">
      <p className="flex items-start gap-2 type-body-sm text-ink-2">
        <Key size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-ink" />
        <span>
          Stored in <span className="text-ink">{q.data.backend}</span>. Agents never see values: beamhop's
          broker adds them to requests for the hosts you allowed.
        </span>
      </p>
      {secrets.length === 0 ? (
        <EmptyState
          glyph={<Key size={32} aria-hidden="true" />}
          title="No secrets yet."
          cli="beamhop secret set ANTHROPIC_API_KEY"
          action={
            <Button variant="primary" onPress={() => setAdding(true)}>
              Add a secret
            </Button>
          }
        >
          API keys and bot tokens live here, by name. Channel wizards add theirs automatically.
        </EmptyState>
      ) : (
        <Group
          title={`Secrets · ${secrets.length}`}
          id="sec-list"
          action={
            <Button
              variant="quiet"
              size="sm"
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
              onPress={() => setAdding(true)}
            >
              Add
            </Button>
          }
        >
          <List label="Secrets">
            {secrets.map((s) => (
              <Row
                key={s.name}
                title={
                  <span
                    className="font-mono text-[15px] font-medium"
                    style={{ fontVariationSettings: '"wdth" 87.5' }}
                  >
                    {s.name}
                  </span>
                }
                slug={<MetaLine items={['•••• hidden', s.updatedAt && `updated ${ago(s.updatedAt)}`]} />}
                actions={
                  <RowMenu
                    label={`Actions for ${s.name}`}
                    items={[
                      { id: 'replace', label: 'Replace value…', onAction: () => setReplacing(s.name) },
                      {
                        id: 'delete',
                        label: 'Delete…',
                        destructive: true,
                        onAction: () => setDeleting(s.name),
                      },
                    ]}
                  />
                }
              />
            ))}
          </List>
        </Group>
      )}
      <CliStrip command="beamhop secret set NAME   # reads the value from stdin" />
      <SetSecretSheet open={adding} onOpenChange={setAdding} />
      <SetSecretSheet
        name={replacing}
        open={!!replacing}
        onOpenChange={(o) => !o && setReplacing(undefined)}
      />
      <ConfirmDialog
        isOpen={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Delete ${deleting}?`}
        confirmLabel={`Delete ${deleting}`}
        isPending={del.isPending}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await del.mutateAsync({ name: deleting });
            toast.show({ message: `Deleted · ${deleting}`, tone: 'success' });
            setDeleting(undefined);
          } catch (e) {
            toast.show({ message: (e as Error).message, tone: 'error' });
          }
        }}
      >
        Agents and channels that use {deleting} stop authenticating until you add it again. This can't be
        undone; the value is gone from the keychain.
      </ConfirmDialog>
    </div>
  );
};
