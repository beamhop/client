/**
 * Text inputs (DESIGN §9.3): label above, h-48, 16px body (no iOS zoom), description below,
 * invalid = 1.5px stop border + icon + message linked via aria-describedby (RAC does the wiring).
 */
import {
  CheckCircle,
  ClipboardText,
  Eye,
  EyeSlash,
  LockSimple,
  MagnifyingGlass,
  Minus,
  Plus,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import {
  FieldError,
  Group,
  Input,
  Label,
  Button as RACButton,
  NumberField as RACNumberField,
  type NumberFieldProps as RACNumberFieldProps,
  SearchField as RACSearchField,
  type SearchFieldProps as RACSearchFieldProps,
  TextArea as RACTextArea,
  TextField as RACTextField,
  type TextFieldProps as RACTextFieldProps,
  Text,
} from 'react-aria-components';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { HopMeter } from './glyphs/index.tsx';

export const labelClass = 'type-label text-ink';
export const descriptionClass = 'type-body-sm text-ink-2';
export const inputShell =
  'w-full min-w-0 rounded-md border border-line-strong bg-surface text-ink placeholder:text-ink-3 type-body outline-none ' +
  'data-[hovered]:border-ink-2 data-[invalid]:border-[1.5px] data-[invalid]:border-stop-text ' +
  'data-[focused]:border-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus data-[disabled]:opacity-50';

export const FieldErrorText = ({ children }: { children?: ReactNode }) => (
  <FieldError className="flex items-start gap-1.5 type-body-sm text-stop-text">
    {(v) => (
      <>
        <WarningCircle size={16} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{children ?? v.validationErrors.join(' ')}</span>
      </>
    )}
  </FieldError>
);

export interface TextFieldProps extends Omit<RACTextFieldProps, 'className' | 'children'> {
  label: string;
  description?: ReactNode;
  errorMessage?: ReactNode;
  placeholder?: string;
  /** Monospace value (ids, hosts, paths, tokens). */
  mono?: boolean;
  multiline?: boolean;
  rows?: number;
  /** Trailing adornment inside the input (e.g. an IconButton). */
  trailing?: ReactNode;
  className?: string;
}

export const TextField = ({
  label,
  description,
  errorMessage,
  placeholder,
  mono,
  multiline,
  rows = 4,
  trailing,
  className,
  ...rest
}: TextFieldProps) => (
  <RACTextField {...rest} className={cx('flex flex-col gap-1.5', className)}>
    <Label className={labelClass}>{label}</Label>
    <div className="relative flex items-center">
      {multiline ? (
        <RACTextArea
          rows={rows}
          placeholder={placeholder}
          className={cx(inputShell, 'min-h-24 resize-y px-3 py-3', mono && 'font-mono text-[15px]')}
        />
      ) : (
        <Input
          placeholder={placeholder}
          className={cx(inputShell, 'h-12 px-3', trailing ? 'pr-12' : undefined, mono && 'font-mono')}
          style={mono ? { fontVariationSettings: '"wdth" 87.5' } : undefined}
        />
      )}
      {trailing && <div className="absolute right-0.5 flex items-center">{trailing}</div>}
    </div>
    {description && (
      <Text slot="description" className={descriptionClass}>
        {description}
      </Text>
    )}
    <FieldErrorText>{errorMessage}</FieldErrorText>
  </RACTextField>
);

export interface SecretFieldProps extends Omit<TextFieldProps, 'mono' | 'multiline' | 'trailing' | 'type'> {
  /** Shape check before any network call, e.g. Telegram token regex. */
  format?: RegExp;
  formatLabel?: string;
  /** After save: show `Saved to the vault · …a91f` instead of the input. */
  savedHint?: string;
  /** Show a "Paste" button that reads the clipboard on press (never silently). */
  allowPaste?: boolean;
}

/**
 * Secret field: password type, no autocomplete/spellcheck, show/hide toggle, explicit paste button,
 * live format check (hop-meter style "format ✓"). Values are never rendered again after save.
 */
export const SecretField = ({
  format,
  formatLabel = 'Looks right',
  savedHint,
  allowPaste = true,
  label,
  description,
  ...rest
}: SecretFieldProps) => {
  const [shown, setShown] = useState(false);
  const [inner, setInner] = useState(rest.defaultValue ?? '');
  const value = rest.value ?? inner;
  const setValue = (v: string) => {
    setInner(v);
    rest.onChange?.(v);
  };
  const formatOk = format && value ? format.test(value.trim()) : undefined;
  if (savedHint) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className={labelClass}>{label}</span>
        <p className="flex h-12 items-center gap-2 rounded-md bg-go-wash px-3 type-meta text-go-text">
          <LockSimple size={16} weight="bold" aria-hidden="true" />
          Saved to the vault · {savedHint}
        </p>
      </div>
    );
  }
  const canPaste = allowPaste && typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;
  return (
    <div className="flex flex-col gap-1.5">
      <RACTextField
        {...rest}
        value={value}
        onChange={setValue}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        spellCheck="false"
        className="flex flex-col gap-1.5"
      >
        <Label className={labelClass}>{label}</Label>
        <div className="relative flex items-center">
          <Input
            className={cx(inputShell, 'h-12 px-3 font-mono', canPaste ? 'pr-24' : 'pr-12')}
            style={{ fontVariationSettings: '"wdth" 87.5' }}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <div className="absolute right-0.5 flex items-center">
            {canPaste && (
              <RACButton
                aria-label={`Paste ${label} from clipboard`}
                onPress={async () => {
                  try {
                    setValue((await navigator.clipboard.readText()).trim());
                  } catch {
                    /* permission denied: user can still paste with the keyboard */
                  }
                }}
                className="grid size-11 place-items-center rounded-md text-ink-2 data-[hovered]:bg-sunken"
              >
                <ClipboardText size={20} aria-hidden="true" />
              </RACButton>
            )}
            <RACButton
              aria-label={shown ? `Hide ${label}` : `Show ${label}`}
              aria-pressed={shown}
              onPress={() => setShown((s) => !s)}
              className="grid size-11 place-items-center rounded-md text-ink-2 data-[hovered]:bg-sunken"
            >
              {shown ? <EyeSlash size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
            </RACButton>
          </div>
        </div>
        {description && (
          <Text slot="description" className={descriptionClass}>
            {description}
          </Text>
        )}
        <FieldErrorText />
      </RACTextField>
      {formatOk !== undefined && (
        <p
          className={cx('flex items-center gap-2 type-meta', formatOk ? 'text-go-text' : 'text-ink-2')}
          aria-live="polite"
        >
          <HopMeter up={formatOk ? 3 : 1} total={3} tone={formatOk ? 'ink' : 'ink'} />
          {formatOk ? (
            <>
              <CheckCircle size={14} weight="bold" aria-hidden="true" /> format ✓ · {formatLabel}
            </>
          ) : (
            t('ui.field.formatDoesnTLook')
          )}
        </p>
      )}
    </div>
  );
};

export interface NumberFieldProps extends Omit<RACNumberFieldProps, 'className' | 'children'> {
  label: string;
  description?: ReactNode;
  errorMessage?: ReactNode;
  /** Unit suffix shown after the stepper, e.g. `USD/day`. */
  unit?: string;
  className?: string;
}

/** Budgets use a stepper NumberField, never a slider (precise values, no drag dependency). */
export const NumberField = ({
  label,
  description,
  errorMessage,
  unit,
  className,
  ...rest
}: NumberFieldProps) => (
  <RACNumberField {...rest} className={cx('flex flex-col gap-1.5', className)}>
    <Label className={labelClass}>{label}</Label>
    <div className="flex items-center gap-3">
      <Group className="flex h-12 items-stretch overflow-hidden rounded-md border border-line-strong bg-surface data-[focus-within]:border-ink data-[invalid]:border-stop-text">
        <RACButton
          slot="decrement"
          className="grid w-11 place-items-center text-ink data-[hovered]:bg-sunken data-[disabled]:opacity-40"
        >
          <Minus size={18} aria-hidden="true" />
        </RACButton>
        <Input className="w-20 border-x border-line bg-transparent text-center font-mono tabular-nums outline-none" />
        <RACButton
          slot="increment"
          className="grid w-11 place-items-center text-ink data-[hovered]:bg-sunken data-[disabled]:opacity-40"
        >
          <Plus size={18} aria-hidden="true" />
        </RACButton>
      </Group>
      {unit && <span className="type-meta text-ink-2">{unit}</span>}
    </div>
    {description && (
      <Text slot="description" className={descriptionClass}>
        {description}
      </Text>
    )}
    <FieldErrorText>{errorMessage}</FieldErrorText>
  </RACNumberField>
);

export interface SearchFieldProps extends Omit<RACSearchFieldProps, 'className' | 'children'> {
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  className?: string;
}

export const SearchField = ({
  label,
  hideLabel = true,
  placeholder,
  className,
  ...rest
}: SearchFieldProps) => (
  <RACSearchField {...rest} className={cx('group flex flex-col gap-1.5', className)}>
    <Label className={cx(labelClass, hideLabel && 'sr-only')}>{label}</Label>
    <div className="relative flex items-center">
      <MagnifyingGlass
        size={18}
        className="pointer-events-none absolute left-3 text-ink-2"
        aria-hidden="true"
      />
      <Input
        placeholder={placeholder ?? label}
        className={cx(inputShell, 'h-11 pl-10 pr-11 [&::-webkit-search-cancel-button]:hidden')}
      />
      <RACButton
        aria-label={t('ui.field.clearSearch')}
        className="absolute right-0 grid size-11 place-items-center text-ink-2 group-data-[empty]:hidden data-[hovered]:text-ink"
      >
        <X size={16} aria-hidden="true" />
      </RACButton>
    </div>
  </RACSearchField>
);
