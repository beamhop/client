/**
 * Settings → Secrets (§8 vault). Names only: values are write-only from the PWA — set or replace,
 * never shown again. Delete names the consequence (agents/channels referencing it stop authenticating).
 */
import { Key, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { ago } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Switch } from '../../ui/Choice.tsx';
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
      toast.show({ message: `Saved to the vault · ${n}`, tone: 'success' });
      close();
    } catch {
      /* shown inline */
    }
  };
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={fixed ? `Replace ${fixed}` : t('settings.secrets.addASecret')}
      isDismissable={false}
      footer={
        <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
          <Button variant="primary" size="lg" fullWidth isPending={set.isPending} onPress={() => void save()}>
            {fixed ? t('settings.secrets.replaceValue') : t('settings.secrets.saveToKeychain')}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={close}>
            {t('settings.identity.cancel')}
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
            label={t('settings.secrets.name')}
            mono
            value={name}
            onChange={setName}
            placeholder="ANTHROPIC_API_KEY"
            description={t('settings.secrets.lettersDigitsAgentsAnd')}
            isInvalid={touched && !nameOk}
            errorMessage={t('settings.secrets.useLettersDigitsAnd')}
          />
        )}
        <SecretField
          label={t('settings.secrets.value')}
          value={value}
          onChange={setValue}
          isInvalid={touched && !value}
          description={t('settings.secrets.storedInTheOs')}
        />
        {set.isError && <p className="type-body-sm text-stop-text">{set.error.message}</p>}
      </form>
    </Sheet>
  );
};

/**
 * Where the vault key lives: a 0600 file in the beamhop home (default, never prompts) or one item in the
 * OS keychain (opt-in). Switching moves the key; secrets are not re-encrypted. With
 * BEAMHOP_VAULT_PASSPHRASE the vault is passphrase-locked and the switch is off.
 */
const VaultKeyGroup = ({
  keySource,
  keychainAvailable,
}: {
  keySource?: 'file' | 'keychain' | 'passphrase';
  keychainAvailable?: boolean;
}) => {
  const set = useMutationApi('secret.setKeySource');
  const toast = useToast();
  const passphrase = keySource === 'passphrase';
  const on = keySource === 'keychain';
  const toggle = async (v: boolean) => {
    try {
      await set.mutateAsync({ keySource: v ? 'keychain' : 'file' });
      toast.show({
        message: v ? t('settings.secrets.keyMovedToKeychain') : t('settings.secrets.keyMovedToFile'),
        tone: 'success',
      });
    } catch {
      haptic('error');
    }
  };
  return (
    <Group
      title={t('settings.secrets.vaultKey')}
      id="sec-vault-key"
      note={set.isError ? <span className="text-stop-text">{set.error.message}</span> : undefined}
    >
      <Switch
        isSelected={on}
        isDisabled={passphrase || keychainAvailable === false || set.isPending}
        onChange={(v) => void toggle(v)}
        description={
          passphrase
            ? t('settings.secrets.keyPassphrase')
            : keychainAvailable === false
              ? t('settings.secrets.noKeychain')
              : on
                ? t('settings.secrets.keyInKeychain')
                : t('settings.secrets.keyInFile')
        }
      >
        {t('settings.secrets.useKeychain')}
      </Switch>
      <CliStrip command={`beamhop secret keychain ${on ? 'off' : 'on'}`} />
    </Group>
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
      <ErrorState
        title={t('settings.secrets.couldnTReadThe')}
        details={q.error}
        onRetry={() => void q.refetch()}
      >
        {q.error.message}
      </ErrorState>
    );
  if (q.isPending)
    return showSkeleton ? (
      <Skeleton variant="list" count={5} label={t('settings.secrets.loadingSecrets')} />
    ) : null;
  const secrets = [...q.data.secrets].sort((a, b) => a.name.localeCompare(b.name));
  const vault = q.data.backend === 'file';

  return (
    <div className="flex flex-col gap-8">
      <p className="flex items-start gap-2 type-body-sm text-ink-2">
        <Key size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-ink" />
        <span>
          {vault ? (
            t('settings.secrets.vaultLead')
          ) : (
            <>
              {t('settings.secrets.storedIn')} <span className="text-ink">{q.data.backend}</span>.
            </>
          )}{' '}
          {t('settings.secrets.broker')}
        </span>
      </p>
      {vault && <VaultKeyGroup keySource={q.data.keySource} keychainAvailable={q.data.keychainAvailable} />}
      {secrets.length === 0 ? (
        <EmptyState
          glyph={<Key size={32} aria-hidden="true" />}
          title={t('settings.secrets.noSecretsYet')}
          cli="beamhop secret set ANTHROPIC_API_KEY"
          action={
            <Button variant="primary" onPress={() => setAdding(true)}>
              {t('settings.secrets.addASecret')}
            </Button>
          }
        >
          {t('settings.secrets.apiKeysAndBot')}
        </EmptyState>
      ) : (
        <Group
          title={t('settings.secrets.count', { count: secrets.length })}
          id="sec-list"
          action={
            <Button
              variant="quiet"
              size="sm"
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
              onPress={() => setAdding(true)}
            >
              {t('settings.secrets.add')}
            </Button>
          }
        >
          <List label={t('settings.section.secrets')}>
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
                slug={
                  <MetaLine
                    items={[t('settings.secrets.hidden'), s.updatedAt && `updated ${ago(s.updatedAt)}`]}
                  />
                }
                actions={
                  <RowMenu
                    label={t('settings.actionsFor', { name: s.name })}
                    items={[
                      {
                        id: 'replace',
                        label: t('settings.secrets.replaceValue2'),
                        onAction: () => setReplacing(s.name),
                      },
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
        title={t('settings.secrets.deleteTitle', { name: deleting ?? '' })}
        confirmLabel={t('settings.secrets.deleteName', { name: deleting ?? '' })}
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
        {t('settings.secrets.deleteBody', { name: deleting ?? '' })}
      </ConfirmDialog>
    </div>
  );
};
