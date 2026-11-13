/**
 * Role editor (SCREENS §7 Roles): edit a role or create one (`role.define`), reset / delete it
 * (`role.delete`). Every save goes through a confirm that lists the change in plain language
 * (roleDiff). The owner and agent roles are locked and never reach this sheet.
 */
import { BUILTIN_ROLES, DEFAULT_ROLES, type RoleDef, RoleName } from '@beamhop/core';
import { useEffect, useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { useShowCli } from '../../lib/desktop.ts';
import { Button } from '../../ui/Button.tsx';
import { Select, Switch } from '../../ui/Choice.tsx';
import { NumberField, TextField } from '../../ui/Field.tsx';
import { ConfirmDialog, Sheet, SheetActions } from '../../ui/Sheet.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { DLP_WORD, definePayload, MODE_WORD, roleDiff, roleUses } from './roles.ts';

export type RoleEditTarget = { mode: 'edit'; role: RoleDef } | { mode: 'new'; base: RoleDef };

const isBuiltin = (name: string) => (BUILTIN_ROLES as readonly string[]).includes(name);

const optNum = (v: number) => (Number.isFinite(v) ? v : undefined);

export const RoleEditor = ({
  target,
  roles,
  grants,
  onClose,
}: {
  target: RoleEditTarget | null;
  roles: RoleDef[];
  grants: Record<string, string>;
  onClose: () => void;
}) => {
  const agents = useApi('agent.list');
  const showCli = useShowCli();
  const define = useMutationApi('role.define');
  const remove = useMutationApi('role.delete');
  const toast = useToast();
  const before = target ? (target.mode === 'edit' ? target.role : target.base) : null;
  const [draft, setDraft] = useState<RoleDef | null>(before);
  const [confirm, setConfirm] = useState<'save' | 'delete' | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever another role opens
  useEffect(() => {
    setDraft(before ? { ...before, name: target?.mode === 'new' ? '' : before.name } : null);
    setConfirm(null);
  }, [target]);
  if (!target || !before || !draft) return null;

  const isNew = target.mode === 'new';
  const set = <K extends keyof RoleDef>(k: K, v: RoleDef[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setBudget = (k: 'dailyUsd' | 'messagesPerMinute', v: number | undefined) =>
    setDraft((d) => {
      if (!d) return d;
      const { [k]: _old, ...rest } = d.budget;
      return { ...d, budget: v === undefined ? rest : { ...rest, [k]: v } };
    });

  const name = draft.name.trim();
  const nameError = !isNew
    ? undefined
    : !name
      ? t('policy.roleEdit.nameRequired')
      : !RoleName.safeParse(name).success
        ? t('policy.roleEdit.nameFormat')
        : roles.some((r) => r.name === name)
          ? t('policy.roleEdit.nameTaken', { name })
          : undefined;
  const changes = roleDiff(before, draft);
  const canSave = isNew ? !nameError : changes.length > 0;
  const usedBy = Object.entries(grants).filter(([, r]) => r === before.name).length;
  // The daemon refuses to delete a role that any grant or channel membership still uses.
  const uses = roleUses(before.name, grants, agents.data?.agents ?? []);
  const builtin = !isNew && isBuiltin(before.name);
  const stock = DEFAULT_ROLES.find((r) => r.name === before.name);
  // A built-in role can only be reset once it differs from the stock definition.
  const overridden = builtin && !!stock && roleDiff(stock, before).length > 0;

  const save = async () => {
    try {
      const r = await define.mutateAsync({
        role: definePayload({ ...draft, name: isNew ? name : before.name }),
      });
      toast.show({
        message: isNew
          ? t('policy.roleEdit.created', { name: r.name })
          : t('policy.roleEdit.saved', { name: r.name }),
        tone: 'success',
      });
      onClose();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
      setConfirm(null);
    }
  };
  const del = async () => {
    try {
      await remove.mutateAsync({ name: before.name });
      toast.show({
        message: builtin
          ? t('policy.roleEdit.resetDone', { name: before.name })
          : t('policy.roleEdit.deleted', { name: before.name }),
        tone: 'success',
      });
      onClose();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
      setConfirm(null);
    }
  };

  return (
    <>
      <Sheet
        isOpen
        onOpenChange={(o) => !o && onClose()}
        desktop="pane"
        title={isNew ? t('policy.roleEdit.newTitle') : t('policy.roleEdit.title', { name: before.name })}
        subtitle={isNew ? t('policy.roleEdit.basedOn', { name: before.name }) : undefined}
        footer={
          <SheetActions>
            <Button variant="primary" fullWidth isDisabled={!canSave} onPress={() => setConfirm('save')}>
              {isNew ? t('policy.roleEdit.create') : t('policy.roleEdit.review')}
            </Button>
            <Button variant="secondary" fullWidth onPress={onClose}>
              {t('common.cancel')}
            </Button>
          </SheetActions>
        }
      >
        <div className="flex flex-col gap-5">
          {isNew && (
            <TextField
              label={t('policy.roleEdit.name')}
              mono
              value={draft.name}
              onChange={(v) => set('name', v)}
              placeholder="reviewer-guest"
              isInvalid={!!draft.name && !!nameError}
              errorMessage={nameError}
              description={t(showCli ? 'policy.roleEdit.nameHint' : 'policy.roleEdit.nameHintApp')}
            />
          )}
          <TextField
            label={t('policy.roleEdit.description')}
            value={draft.description}
            onChange={(v) => set('description', v)}
          />
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
            <Switch isSelected={draft.canPrompt} onChange={(v) => set('canPrompt', v)}>
              {t('policy.roleEdit.canPrompt')}
            </Switch>
            <Switch isSelected={draft.canApprove} onChange={(v) => set('canApprove', v)}>
              {t('policy.roleEdit.canApprove')}
            </Switch>
            <Switch isSelected={draft.canReconfigure} onChange={(v) => set('canReconfigure', v)}>
              {t('policy.roleEdit.canReconfigure')}
            </Switch>
          </div>
          <Select
            label={t('policy.roleEdit.mode')}
            options={(Object.keys(MODE_WORD) as RoleDef['permissionMode'][]).map((m) => ({
              id: m,
              label: MODE_WORD[m],
            }))}
            selectedKey={draft.permissionMode}
            onSelectionChange={(k) => set('permissionMode', String(k) as RoleDef['permissionMode'])}
          />
          <Select
            label={t('policy.roles.sandbox')}
            options={(['strict', 'workspace', 'custom'] as const).map((p) => ({ id: p, label: p }))}
            selectedKey={draft.sandboxProfile}
            onSelectionChange={(k) => set('sandboxProfile', String(k) as RoleDef['sandboxProfile'])}
          />
          <Select
            label={t('policy.roles.dlp')}
            options={(Object.keys(DLP_WORD) as RoleDef['dlp'][]).map((d) => ({ id: d, label: DLP_WORD[d] }))}
            selectedKey={draft.dlp}
            onSelectionChange={(k) => set('dlp', String(k) as RoleDef['dlp'])}
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label={t('policy.roleEdit.dailyUsd')}
              unit="$"
              minValue={0}
              value={draft.budget.dailyUsd ?? Number.NaN}
              onChange={(v) => setBudget('dailyUsd', optNum(v))}
            />
            <NumberField
              label={t('policy.roleEdit.rate')}
              unit="msg/min"
              minValue={1}
              value={draft.budget.messagesPerMinute ?? Number.NaN}
              onChange={(v) => setBudget('messagesPerMinute', optNum(v) && Math.round(v))}
            />
          </div>
          {!isNew && (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <p className="type-body-sm text-ink-2">
                {builtin
                  ? overridden
                    ? t('policy.roleEdit.resetHint')
                    : t('policy.roleEdit.builtinHint')
                  : uses.length > 0
                    ? t('policy.roleEdit.inUseBy', { count: uses.length, list: uses.slice(0, 3).join(', ') })
                    : t('policy.roleEdit.deleteHint')}
              </p>
              {(builtin ? overridden : uses.length === 0 && !!agents.data) && (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  className="self-start"
                  onPress={() => setConfirm('delete')}
                >
                  {builtin ? t('policy.roleEdit.reset') : t('policy.roleEdit.delete')}
                </Button>
              )}
            </div>
          )}
        </div>
      </Sheet>
      <ConfirmDialog
        isOpen={confirm === 'save'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          isNew
            ? t('policy.roleEdit.confirmNew', { name })
            : t('policy.roleEdit.confirmEdit', { name: before.name })
        }
        confirmLabel={isNew ? t('policy.roleEdit.create') : t('policy.roleEdit.save')}
        variant="primary"
        isPending={define.isPending}
        onConfirm={save}
      >
        <span className="flex flex-col gap-2">
          <span>
            {isNew
              ? t('policy.roleEdit.confirmNewBody', { base: before.name })
              : t('policy.roleEdit.confirmBody', { count: usedBy })}
          </span>
          {changes.length > 0 && (
            <span role="list" aria-label={t('policy.roleEdit.changes')} className="flex flex-col gap-1">
              {changes.map((c) => (
                <span role="listitem" key={c} className="type-body-sm text-ink">
                  · {c}
                </span>
              ))}
            </span>
          )}
        </span>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          builtin
            ? t('policy.roleEdit.confirmReset', { name: before.name })
            : t('policy.roleEdit.confirmDelete', { name: before.name })
        }
        confirmLabel={builtin ? t('policy.roleEdit.reset') : t('policy.roleEdit.delete')}
        isPending={remove.isPending}
        onConfirm={del}
      >
        {builtin ? t('policy.roleEdit.confirmResetBody') : t('policy.roleEdit.confirmDeleteBody')}
      </ConfirmDialog>
    </>
  );
};
