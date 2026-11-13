/**
 * Choice controls (DESIGN §9.3): Switch, Checkbox, RadioGroup (+ RadioCard), SegmentedControl, Select, Tabs.
 */
import { CaretDown, Check } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { type Key, type ReactNode, useContext } from 'react';
import {
  Dialog,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Button as RACButton,
  Checkbox as RACCheckbox,
  type CheckboxProps as RACCheckboxProps,
  Radio as RACRadio,
  RadioGroup as RACRadioGroup,
  type RadioGroupProps as RACRadioGroupProps,
  Select as RACSelect,
  type SelectProps as RACSelectProps,
  Switch as RACSwitch,
  type SwitchProps as RACSwitchProps,
  Tab as RACTab,
  TabList as RACTabList,
  TabPanel as RACTabPanel,
  Tabs as RACTabs,
  type TabsProps as RACTabsProps,
  SelectStateContext,
  SelectValue,
  Text,
  ToggleButton,
  ToggleButtonGroup,
} from 'react-aria-components';
import { cx } from '../lib/cx.ts';
import { useExpanded } from '../lib/media.ts';
import { descriptionClass, FieldErrorText, labelClass } from './Field.tsx';
import { spring } from './motion.ts';

// ─────────── Switch ───────────
export interface SwitchProps extends Omit<RACSwitchProps, 'className' | 'children'> {
  children: ReactNode;
  description?: ReactNode;
  className?: string;
}

/** Label left, switch right, whole row pressable. On = ink track (flare is reserved for live). */
export const Switch = ({ children, description, className, ...rest }: SwitchProps) => (
  <RACSwitch
    {...rest}
    className={cx(
      'group flex min-h-12 w-full items-center justify-between gap-4 py-2 outline-none data-[disabled]:opacity-50',
      className,
    )}
  >
    {({ isSelected }) => (
      <>
        <span className="flex min-w-0 flex-col">
          <span className="type-body text-ink">{children}</span>
          {description && <span className={descriptionClass}>{description}</span>}
        </span>
        <span
          aria-hidden="true"
          className={cx(
            'relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full border p-px',
            'group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus',
            isSelected ? 'border-ink bg-ink' : 'border-line-strong bg-sunken',
          )}
        >
          <motion.span
            layout
            transition={spring.snap}
            className={cx(
              'block size-[22px] rounded-full shadow-[0_1px_2px_oklch(0.2_0.01_60/.25)]',
              isSelected ? 'ml-auto bg-bg' : 'bg-surface border border-line-strong',
            )}
          />
        </span>
      </>
    )}
  </RACSwitch>
);

// ─────────── Checkbox ───────────
export interface CheckboxProps extends Omit<RACCheckboxProps, 'className' | 'children'> {
  children?: ReactNode;
  description?: ReactNode;
  className?: string;
}

/** 24px box inside a 44px row. */
export const Checkbox = ({ children, description, className, ...rest }: CheckboxProps) => (
  <RACCheckbox
    {...rest}
    className={cx(
      'group flex min-h-11 items-start gap-3 py-2.5 outline-none data-[disabled]:opacity-50',
      className,
    )}
  >
    {({ isSelected, isIndeterminate }) => (
      <>
        <span
          aria-hidden="true"
          className={cx(
            'grid size-6 shrink-0 place-items-center rounded-sm border-[1.5px]',
            'group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus',
            'group-data-[invalid]:border-stop-text',
            isSelected || isIndeterminate ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface',
          )}
        >
          {isSelected && <Check size={16} weight="bold" />}
          {isIndeterminate && <span className="h-0.5 w-3 bg-bg" />}
        </span>
        {(children || description) && (
          <span className="flex min-w-0 flex-col pt-px">
            {children && <span className="type-body text-ink">{children}</span>}
            {description && <span className={descriptionClass}>{description}</span>}
          </span>
        )}
      </>
    )}
  </RACCheckbox>
);

// ─────────── Radio ───────────
export interface RadioGroupProps extends Omit<RACRadioGroupProps, 'className' | 'children'> {
  label: string;
  hideLabel?: boolean;
  description?: ReactNode;
  children: ReactNode;
  /** `cards`: radio cards (profile choice); `list`: plain rows. */
  variant?: 'list' | 'cards';
  className?: string;
}

export const RadioGroup = ({
  label,
  hideLabel,
  description,
  children,
  variant = 'list',
  className,
  ...rest
}: RadioGroupProps) => (
  <RACRadioGroup {...rest} className={cx('flex flex-col gap-1.5', className)}>
    <Label className={cx(labelClass, hideLabel && 'sr-only')}>{label}</Label>
    {description && (
      <Text slot="description" className={descriptionClass}>
        {description}
      </Text>
    )}
    <div
      className={cx(
        'flex flex-col',
        variant === 'cards' && 'overflow-hidden rounded-lg border border-line bg-surface',
      )}
    >
      {children}
    </div>
    <FieldErrorText />
  </RACRadioGroup>
);

export const Radio = ({
  value,
  children,
  description,
  isDisabled,
}: {
  value: string;
  children: ReactNode;
  description?: ReactNode;
  isDisabled?: boolean;
}) => (
  <RACRadio
    value={value}
    isDisabled={isDisabled}
    className="group flex min-h-11 items-start gap-3 py-2.5 outline-none data-[disabled]:opacity-50 [.rounded-lg>&]:border-b [.rounded-lg>&]:border-line [.rounded-lg>&]:px-4 [.rounded-lg>&]:py-3.5 [.rounded-lg>&:last-child]:border-b-0 [.rounded-lg>&]:data-[selected]:bg-flare-wash"
  >
    {({ isSelected }) => (
      <>
        <span
          aria-hidden="true"
          className={cx(
            'grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] bg-surface',
            'group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus',
            isSelected ? 'border-ink' : 'border-line-strong',
          )}
        >
          {isSelected && <span className="size-3 rounded-full bg-ink" />}
        </span>
        <span className="flex min-w-0 flex-col pt-px">
          <span className="type-body text-ink">{children}</span>
          {description && <span className={descriptionClass}>{description}</span>}
        </span>
      </>
    )}
  </RACRadio>
);

// ─────────── Segmented control ───────────
export interface SegmentedControlProps<K extends string> {
  label: string;
  options: Array<{ id: K; label: ReactNode; ariaLabel?: string }>;
  value: K;
  onChange: (v: K) => void;
  className?: string;
  size?: 'md' | 'sm';
  isDisabled?: boolean;
}

/** Single-select ToggleButtonGroup: sunken track, selected thumb = surface + hairline. */
export const SegmentedControl = <K extends string>({
  label,
  options,
  value,
  onChange,
  className,
  size = 'md',
  isDisabled,
}: SegmentedControlProps<K>) => (
  <ToggleButtonGroup
    aria-label={label}
    selectionMode="single"
    disallowEmptySelection
    isDisabled={isDisabled}
    selectedKeys={[value]}
    onSelectionChange={(keys) => {
      const k = [...keys][0];
      if (k !== undefined) onChange(k as K);
    }}
    className={cx(
      'inline-flex rounded-md border border-line bg-sunken p-0.5',
      size === 'md' ? 'h-11 pointer-fine:h-10' : 'h-9',
      className,
    )}
  >
    {options.map((o) => (
      <ToggleButton
        key={o.id}
        id={o.id}
        aria-label={o.ariaLabel}
        className={cx(
          'relative flex min-w-11 flex-1 items-center justify-center rounded-[6px] px-3 type-label text-ink-2 outline-none whitespace-nowrap',
          'data-[selected]:text-ink data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus',
        )}
      >
        {({ isSelected }) => (
          <>
            {isSelected && (
              <span
                className="absolute inset-0 rounded-[6px] border border-line-strong bg-surface"
                aria-hidden="true"
              />
            )}
            <span className="relative">{o.label}</span>
          </>
        )}
      </ToggleButton>
    ))}
  </ToggleButtonGroup>
);

// ─────────── Select ───────────
export interface SelectOption {
  id: string;
  label: string;
  description?: string;
  /** Leading adornment (LetterTile, StatusDot). */
  leading?: ReactNode;
  isDisabled?: boolean;
}

export interface SelectProps extends Omit<RACSelectProps<SelectOption>, 'className' | 'children' | 'items'> {
  label: string;
  hideLabel?: boolean;
  description?: ReactNode;
  options: SelectOption[];
  className?: string;
}

const optionClass =
  'group flex min-h-11 cursor-default items-center gap-3 rounded-md px-3 py-2 outline-none text-ink data-[focused]:bg-sunken data-[selected]:bg-flare-wash data-[disabled]:opacity-45';

const Options = ({ options }: { options: SelectOption[] }) => (
  <ListBox items={options} className="flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto p-1 outline-none">
    {(o) => (
      <ListBoxItem id={o.id} textValue={o.label} isDisabled={o.isDisabled} className={optionClass}>
        {({ isSelected }) => (
          <>
            {o.leading}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="type-body">{o.label}</span>
              {o.description && <span className="type-meta text-ink-2">{o.description}</span>}
            </span>
            {isSelected && <Check size={18} weight="bold" aria-hidden="true" />}
          </>
        )}
      </ListBoxItem>
    )}
  </ListBox>
);

/** RAC Select. Popover on desktop; bottom sheet on compact (DESIGN §9.3). */
export const Select = ({ label, hideLabel, description, options, className, ...rest }: SelectProps) => {
  const expanded = useExpanded();
  return (
    <RACSelect {...rest} className={cx('flex flex-col gap-1.5', className)}>
      <Label className={cx(labelClass, hideLabel && 'sr-only')}>{label}</Label>
      <RACButton className="flex h-12 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-left text-ink outline-none data-[hovered]:border-ink-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus data-[pressed]:bg-sunken">
        <SelectValue<SelectOption> className="flex min-w-0 flex-1 items-center gap-2 truncate type-body data-[placeholder]:text-ink-3">
          {({ selectedItem, defaultChildren }) =>
            selectedItem ? (
              <>
                {selectedItem.leading}
                <span className="truncate">{selectedItem.label}</span>
              </>
            ) : (
              defaultChildren
            )
          }
        </SelectValue>
        <CaretDown size={16} aria-hidden="true" className="text-ink-2" />
      </RACButton>
      {description && (
        <Text slot="description" className={descriptionClass}>
          {description}
        </Text>
      )}
      <FieldErrorText />
      {expanded ? (
        <Popover className="min-w-[--trigger-width] w-[var(--trigger-width)] rounded-lg border border-line bg-surface shadow-pop outline-none">
          <Options options={options} />
        </Popover>
      ) : (
        <>
          {/* Never opens: lets RAC build the collection while the sheet is closed (Modal renders nothing in
              RAC's hidden collection pass), so the trigger shows the selected value on compact. */}
          <Popover isOpen={false} className="hidden">
            <Options options={options} />
          </Popover>
          <SelectSheet label={label} options={options} />
        </>
      )}
    </RACSelect>
  );
};

/**
 * Compact Select list as a bottom sheet. Open state comes from the Select explicitly: without it a
 * ModalOverlay nested inside another modal (a Select in a Sheet) picks up the outer overlay's state
 * and renders open.
 */
const SelectSheet = ({ label, options }: { label: string; options: SelectOption[] }) => {
  const state = useContext(SelectStateContext);
  return (
    <ModalOverlay
      isDismissable
      isOpen={!!state?.isOpen}
      onOpenChange={(open) => !open && state?.close()}
      className="fixed inset-0 z-[60] flex items-end bg-scrim"
    >
      <Modal className="w-full rounded-t-[20px] bg-surface pb-[var(--bh-safe-bottom)] shadow-sheet outline-none">
        <Dialog aria-label={label} className="outline-none">
          <div className="mx-auto mt-2 mb-1 h-1 w-9 rounded-full bg-line-strong" aria-hidden="true" />
          <p className="px-4 pt-2 pb-1 type-title-3 text-ink">{label}</p>
          <Options options={options} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};

// ─────────── Tabs ───────────
export interface TabsProps extends Omit<RACTabsProps, 'className' | 'children'> {
  label: string;
  tabs: Array<{ id: string; label: ReactNode; content?: ReactNode; href?: string }>;
  /**
   * `true` (default): each tab renders its own `content`. `false`: tabs drive routes (`href`) and the
   * shared `children` render inside the selected panel (keeps aria-controls valid).
   */
  panels?: boolean;
  children?: ReactNode;
  className?: string;
}

/** RAC Tabs with a scrollable list; selected tab = ink + 2px flare bar. Switching is instant. */
export const Tabs = ({ label, tabs, panels = true, children, className, ...rest }: TabsProps) => (
  <RACTabs {...rest} className={cx('flex flex-col', className)}>
    <RACTabList
      aria-label={label}
      className="-mx-1 flex overflow-x-auto border-b border-line px-1 [scrollbar-width:none]"
    >
      {tabs.map((t) => (
        <RACTab
          key={t.id}
          id={t.id}
          href={t.href}
          className="relative flex min-h-11 shrink-0 cursor-default items-center px-3 type-label text-ink-2 outline-none data-[hovered]:text-ink data-[selected]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
        >
          {({ isSelected }) => (
            <>
              {t.label}
              {isSelected && (
                <span aria-hidden="true" className="absolute inset-x-3 -bottom-px h-0.5 bg-flare" />
              )}
            </>
          )}
        </RACTab>
      ))}
    </RACTabList>
    {tabs.map((t) => (
      <RACTabPanel
        key={t.id}
        id={t.id}
        className="pt-4 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
      >
        {panels ? t.content : children}
      </RACTabPanel>
    ))}
  </RACTabs>
);

export type { Key };
