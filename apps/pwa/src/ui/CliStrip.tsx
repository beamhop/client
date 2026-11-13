/**
 * CliStrip (DESIGN §2 Always, §9.2): the CLI equivalent of a configuration screen, collapsed by default,
 * open/closed state remembered per user. CopyButton is shared by code blocks and copy fields.
 */
import { CaretRight, Check, Copy, TerminalWindow } from '@phosphor-icons/react';
import { useState } from 'react';
import { Disclosure, DisclosurePanel, Heading, Button as RACButton } from 'react-aria-components';
import { cx } from '../lib/cx.ts';
import { announce } from '../lib/live.ts';

const KEY = 'bh.cli.open';
const readOpen = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export const CopyButton = ({
  value,
  label = 'Copy',
  className,
  compact,
}: {
  value: string;
  label?: string;
  className?: string;
  compact?: boolean;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <RACButton
      aria-label={compact ? (copied ? 'Copied' : label) : undefined}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          /* clipboard blocked; still confirm so the user can select manually */
        }
        setCopied(true);
        announce('Copied to clipboard.');
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cx(
        'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 type-label text-ink-2 data-[hovered]:bg-[color-mix(in_oklch,var(--bh-sunken),var(--bh-ink)_6%)] data-[hovered]:text-ink',
        className,
      )}
    >
      {copied ? (
        <Check size={16} weight="bold" aria-hidden="true" className="text-go-text" />
      ) : (
        <Copy size={16} aria-hidden="true" />
      )}
      {!compact && <span>{copied ? 'Copied' : label}</span>}
    </RACButton>
  );
};

export const CliStrip = ({
  command,
  className,
  title = 'CLI',
}: {
  command: string;
  className?: string;
  title?: string;
}) => {
  const [open, setOpen] = useState(readOpen);
  return (
    <Disclosure
      isExpanded={open}
      onExpandedChange={(v) => {
        setOpen(v);
        try {
          localStorage.setItem(KEY, v ? '1' : '0');
        } catch {
          /* ignore */
        }
      }}
      className={cx('rounded-md border border-line', className)}
    >
      <Heading level={3} className="m-0">
        <RACButton
          slot="trigger"
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-ink-2 outline-none data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          <TerminalWindow size={16} aria-hidden="true" />
          <span className="type-micro">{title}</span>
          {!open && <span className="min-w-0 flex-1 truncate type-meta text-ink-3">{command}</span>}
          <CaretRight size={14} aria-hidden="true" className={cx('ml-auto shrink-0', open && 'rotate-90')} />
        </RACButton>
      </Heading>
      <DisclosurePanel>
        <div className="flex items-start gap-2 rounded-b-md border-t border-line bg-sunken py-1 pr-1 pl-3">
          <code className="min-w-0 flex-1 overflow-x-auto py-2.5 type-code whitespace-pre text-ink">
            <span aria-hidden="true" className="text-ink-3 select-none">
              ${' '}
            </span>
            {command}
          </code>
          <CopyButton value={command} label="Copy command" compact />
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
};
