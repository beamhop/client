/**
 * The agent's model, picked from what its harness offers with the current sign-in (asked of the harness
 * itself: `harness.models`). "Harness default" leaves the choice to the harness; "Other model…" keeps a
 * typed id for anything the list does not show. Falls back to a plain text field when the harness cannot
 * list its models.
 */
import type { HarnessView } from '@beamhop/core';
import { ArrowClockwise } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { Button } from '../../ui/Button.tsx';
import { Select, type SelectOption } from '../../ui/Choice.tsx';
import { TextField } from '../../ui/Field.tsx';

export const DEFAULT_MODEL = 'default';
const CUSTOM = '__custom';

/** Select options for a model list: harness default first, the listed models, then a custom id. */
export const modelOptions = (
  models: { id: string; label?: string; description?: string; isDefault?: boolean }[],
): SelectOption[] => {
  const listed = models.filter((m) => m.id !== DEFAULT_MODEL);
  const def = models.find((m) => m.isDefault);
  return [
    {
      id: DEFAULT_MODEL,
      label: t('agents.model.harnessDefault'),
      description:
        def && def.id !== DEFAULT_MODEL
          ? t('agents.model.currently', { model: def.label ?? def.id })
          : undefined,
    },
    ...listed.map((m) => ({
      id: m.id,
      // The id is shown only when the name does not already say it (it is what /model and the CLI take).
      label: !m.label
        ? m.id
        : m.label.toLowerCase() === m.id.toLowerCase()
          ? m.label
          : `${m.label} (${m.id})`,
      ...(m.description ? { description: m.description } : {}),
    })),
    { id: CUSTOM, label: t('agents.model.other') },
  ];
};

export const ModelField = ({
  harness,
  value,
  onChange,
}: {
  harness: HarnessView | undefined;
  value: string;
  onChange: (model: string) => void;
}) => {
  const [refresh, setRefresh] = useState(false);
  const ready = harness?.status === 'ready';
  const q = useApi(
    'harness.models',
    { id: harness?.id ?? '', refresh },
    { enabled: !!harness && ready, staleTime: 5 * 60_000, retry: false },
  );
  const models = q.data?.models ?? [];
  const listed = models.length > 0;
  const known = value === DEFAULT_MODEL || models.some((m) => m.id === value);
  // Typed ids stay editable: "Other model…" is selected whenever the value is not in the list.
  const [custom, setCustom] = useState(!known && value !== DEFAULT_MODEL);
  const selected = custom || (listed && !known) ? CUSTOM : value;

  const hint = !harness
    ? t('agents.model.pickHarness')
    : !ready
      ? t('agents.model.notReady', { name: harness.displayName })
      : q.isFetching
        ? t('agents.model.loading', { name: harness.displayName })
        : q.data?.error
          ? t('agents.model.cannotList', { error: q.data.error })
          : q.isError
            ? t('agents.model.cannotList', { error: q.error.message })
            : t('agents.model.hint');

  if (!listed) {
    return (
      <div className="flex flex-col gap-2">
        <TextField
          label={t('agents.setup.model')}
          value={value}
          onChange={(v) => onChange(v.trim() || DEFAULT_MODEL)}
          mono
          description={hint}
        />
        {ready && !q.isFetching && (
          <Button
            size="sm"
            variant="quiet"
            className="self-start"
            icon={<ArrowClockwise size={16} aria-hidden="true" />}
            onPress={() => (refresh ? void q.refetch() : setRefresh(true))}
          >
            {t('agents.model.reload')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Select
        label={t('agents.setup.model')}
        selectedKey={selected}
        onSelectionChange={(k) => {
          const id = String(k);
          if (id === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(id);
        }}
        options={modelOptions(models)}
        description={hint}
      />
      {selected === CUSTOM && (
        <TextField
          label={t('agents.model.customLabel')}
          value={value === DEFAULT_MODEL ? '' : value}
          onChange={(v) => onChange(v.trim() || DEFAULT_MODEL)}
          placeholder={t('agents.model.customPlaceholder')}
          mono
        />
      )}
      <Button
        size="sm"
        variant="quiet"
        className="self-start"
        icon={<ArrowClockwise size={16} aria-hidden="true" />}
        isDisabled={q.isFetching}
        onPress={() => (refresh ? void q.refetch() : setRefresh(true))}
      >
        {t('agents.model.reload')}
      </Button>
    </div>
  );
};
