/**
 * Instruction file sheet (Overview → Instructions): view a harness file; in a read-write mount, edit
 * it (`agent.instructionsWrite`) with a diff preview first. Before writing, the file is read again
 * (`agent.instructions`): if it changed since editing started, the write stops and offers to load
 * the new version or overwrite it.
 */
import type { AgentView } from '@beamhop/core';
import { PencilSimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useCall, useMutationApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { Button } from '../../../ui/Button.tsx';
import { CodeBlock, DiffView } from '../../../ui/CodeBlock.tsx';
import { TextField } from '../../../ui/Field.tsx';
import { Sheet, SheetActions } from '../../../ui/Sheet.tsx';
import { useToast } from '../../../ui/Toast.tsx';
import { unifiedDiff, writableMount } from '../model.ts';

export interface InstructionFile {
  path: string;
  harness: string;
  content: string;
}

type Mode =
  | { k: 'view' }
  | { k: 'edit'; base: string; draft: string }
  | { k: 'preview'; base: string; draft: string }
  | { k: 'conflict'; base: string; draft: string; current: string | null };

export const InstructionSheet = ({
  agent,
  file,
  onClose,
}: {
  agent: AgentView;
  file: InstructionFile | undefined;
  onClose: () => void;
}) => {
  const call = useCall();
  const write = useMutationApi('agent.instructionsWrite');
  const toast = useToast();
  const [mode, setMode] = useState<Mode>({ k: 'view' });
  const [checking, setChecking] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different file starts in view mode
  useEffect(() => setMode({ k: 'view' }), [file?.path]);
  const mount = file ? writableMount(agent.config.mounts, file.path) : undefined;
  const name = agent.config.name;

  const doWrite = async (draft: string) => {
    if (!file) return;
    try {
      const r = await write.mutateAsync({ name, path: file.path, content: draft });
      toast.show({ message: t('agents.ov.fileSaved', { path: r.path }), tone: 'success' });
      setMode({ k: 'view' });
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
    }
  };

  /** Re-read the file; write only if nobody changed it since editing began. */
  const save = async (base: string, draft: string) => {
    if (!file) return;
    setChecking(true);
    try {
      const fresh = await call('agent.instructions', { name });
      const current = fresh.files.find((f) => f.path === file.path)?.content ?? null;
      if (current !== base) {
        setMode({ k: 'conflict', base, draft, current });
        return;
      }
      await doWrite(draft);
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const footer =
    mode.k === 'edit' ? (
      <SheetActions>
        <Button
          variant="primary"
          fullWidth
          isDisabled={mode.draft === mode.base}
          onPress={() => setMode({ ...mode, k: 'preview' })}
        >
          {t('agents.ov.filePreview')}
        </Button>
        <Button variant="secondary" fullWidth onPress={() => setMode({ k: 'view' })}>
          {t('common.cancel')}
        </Button>
      </SheetActions>
    ) : mode.k === 'preview' ? (
      <SheetActions>
        <Button
          variant="primary"
          fullWidth
          isPending={checking || write.isPending}
          onPress={() => void save(mode.base, mode.draft)}
        >
          {t('agents.ov.fileSave')}
        </Button>
        <Button variant="secondary" fullWidth onPress={() => setMode({ ...mode, k: 'edit' })}>
          {t('agents.ov.fileBack')}
        </Button>
      </SheetActions>
    ) : mode.k === 'conflict' ? (
      <SheetActions>
        <Button
          variant="primary"
          fullWidth
          onPress={() => setMode({ k: 'edit', base: mode.current ?? '', draft: mode.current ?? '' })}
        >
          {t('agents.ov.fileReload')}
        </Button>
        <Button
          variant="destructive-outline"
          fullWidth
          isPending={write.isPending}
          onPress={() => void doWrite(mode.draft)}
        >
          {t('agents.ov.fileOverwrite')}
        </Button>
      </SheetActions>
    ) : undefined;

  return (
    <Sheet
      isOpen={!!file}
      onOpenChange={(o) => !o && onClose()}
      title={file?.path ?? ''}
      subtitle={file && t('agents.ov.fileSheet', { harness: file.harness })}
      full
      footer={footer}
    >
      {file && mode.k === 'view' && (
        <>
          {mount ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="type-body-sm text-ink-2">{t('agents.ov.fileEditable', { mount: mount.path })}</p>
              <Button
                variant="secondary"
                size="sm"
                icon={<PencilSimple size={16} aria-hidden="true" />}
                onPress={() => setMode({ k: 'edit', base: file.content, draft: file.content })}
              >
                {t('agents.ov.fileEdit')}
              </Button>
            </div>
          ) : (
            <p className="mb-3 type-body-sm text-ink-2">{t('agents.ov.fileNote')}</p>
          )}
          <CodeBlock code={file.content} label={file.path} lineNumbers wrap />
        </>
      )}
      {file && mode.k === 'edit' && (
        <TextField
          label={t('agents.ov.fileContent', { path: file.path })}
          mono
          multiline
          rows={18}
          value={mode.draft}
          onChange={(draft) => setMode({ ...mode, draft })}
          description={t('agents.ov.fileEditHint')}
        />
      )}
      {file && mode.k === 'preview' && (
        <>
          <p className="mb-3 type-body-sm text-ink-2">{t('agents.ov.filePreviewHint')}</p>
          <DiffView diff={unifiedDiff(file.path, mode.base, mode.draft)} />
        </>
      )}
      {file && mode.k === 'conflict' && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="type-body-sm text-caution-text">
            {mode.current === null
              ? t('agents.ov.fileGone', { path: file.path })
              : t('agents.ov.fileConflict', { path: file.path })}
          </p>
          {mode.current !== null && (
            <>
              <p className="type-body-sm text-ink-2">{t('agents.ov.fileTheirs')}</p>
              <DiffView diff={unifiedDiff(file.path, mode.base, mode.current)} />
            </>
          )}
        </div>
      )}
    </Sheet>
  );
};
