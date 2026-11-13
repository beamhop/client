/**
 * More (compact only, SCREENS §0.1): search, Channels, Harnesses, Policy, Deploy, Audit, Settings and
 * Stop everything. On expanded the sidebar replaces it.
 */
import { CaretRight, MagnifyingGlass, Stop } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { Button as RACButton } from 'react-aria-components';
import { type MessageKey, t } from '../../i18n/index.ts';
import { MORE_ITEMS } from '../../shell/nav.ts';
import { openOverlay } from '../../shell/overlays.ts';
import { usePanicSheet, usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';

const HINT: Record<string, MessageKey> = {
  '/channels': 'more.hint.channels',
  '/harnesses': 'more.hint.harnesses',
  '/policy': 'more.hint.policy',
  '/deploy': 'more.hint.deploy',
  '/audit': 'more.hint.audit',
  '/settings': 'more.hint.settings',
};

export const MoreScreen = () => {
  const { open } = usePanicSheet();
  const { panic } = usePanicState();
  return (
    <Screen title={t('nav.more')} slug={t('more.slug')} showPanic={false}>
      <div className="flex flex-col gap-6">
        <RACButton
          onPress={() => openOverlay('palette')}
          className="flex h-12 w-full items-center gap-3 rounded-md border border-line-strong bg-surface px-3 text-left text-ink-2 outline-none data-[pressed]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
        >
          <MagnifyingGlass size={20} aria-hidden="true" />
          <span className="type-body">{t('more.search')}</span>
        </RACButton>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {MORE_ITEMS.map((item) => {
            const Icon = item.icon;
            const hint = HINT[item.to];
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex min-h-14 items-center gap-4 px-4 py-2.5 outline-none hover:bg-sunken"
                >
                  <Icon size={22} aria-hidden="true" className="text-ink-2" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="type-title-3 text-ink">{item.label}</span>
                    {hint && <span className="truncate type-meta text-ink-2">{t(hint)}</span>}
                  </span>
                  <CaretRight size={16} aria-hidden="true" className="text-ink-3" />
                </Link>
              </li>
            );
          })}
        </ul>
        {!panic && (
          <section aria-labelledby="more-stop" className="flex flex-col gap-2">
            <h2 id="more-stop" className="type-micro text-ink-2">
              {t('more.killSwitch')}
            </h2>
            <Button
              variant="destructive"
              size="lg"
              fullWidth
              icon={<Stop size={20} weight="fill" aria-hidden="true" />}
              onPress={open}
            >
              {t('panic.button')}
            </Button>
            <p className="type-body-sm text-ink-2">{t('more.killSwitch.note')}</p>
          </section>
        )}
      </div>
    </Screen>
  );
};
