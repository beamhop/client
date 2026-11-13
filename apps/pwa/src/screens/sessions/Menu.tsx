/** Small overflow menu (RAC MenuTrigger + Popover + Menu) used by session rows, messages and the header. */
import { DotsThree } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';
import { cx } from '../../lib/cx.ts';
import { IconButton } from '../../ui/Button.tsx';

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'stop';
  isDisabled?: boolean;
  onAction: () => void;
  /** Draw a separator before this item. */
  divider?: boolean;
}

export const OverflowMenu = ({
  label,
  actions,
  trigger,
  className,
  placement = 'bottom end',
}: {
  label: string;
  actions: MenuAction[];
  trigger?: ReactNode;
  className?: string;
  placement?: 'bottom end' | 'top end' | 'bottom start';
}) => (
  <MenuTrigger>
    {trigger ?? (
      <IconButton label={label} icon={<DotsThree size={22} weight="bold" />} className={className} />
    )}
    <Popover
      placement={placement}
      offset={4}
      className="z-[70] min-w-56 rounded-lg border border-line bg-surface p-1 shadow-pop outline-none"
    >
      <Menu
        aria-label={label}
        className="outline-none"
        onAction={(k) => actions.find((a) => a.id === k)?.onAction()}
        disabledKeys={actions.filter((a) => a.isDisabled).map((a) => a.id)}
      >
        {actions.flatMap((a) => {
          const item = (
            <MenuItem
              key={a.id}
              id={a.id}
              textValue={a.label}
              className={cx(
                'flex min-h-11 cursor-default items-center gap-3 rounded-md px-3 type-label outline-none data-[focused]:bg-sunken data-[disabled]:opacity-45',
                a.tone === 'stop' ? 'text-stop-text' : 'text-ink',
              )}
            >
              {a.icon && (
                <span aria-hidden="true" className="shrink-0 text-current">
                  {a.icon}
                </span>
              )}
              {a.label}
            </MenuItem>
          );
          return a.divider
            ? [<Separator key={`${a.id}-sep`} className="my-1 border-t border-line" />, item]
            : [item];
        })}
      </Menu>
    </Popover>
  </MenuTrigger>
);
