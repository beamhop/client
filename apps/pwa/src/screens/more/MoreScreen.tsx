/**
 * More (compact only, SCREENS §0.1): Channels, Harnesses, Policy, Deploy, Audit, Settings + Stop everything.
 * Implemented by the foundation. On expanded the sidebar replaces it.
 */
import { CaretRight, Stop } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { MORE_ITEMS } from '../../shell/nav.ts';
import { usePanicSheet, usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';

const HINT: Record<string, string> = {
  '/channels': 'Nostr, Telegram, Slack, Discord',
  '/harnesses': 'Claude Code, Codex, Gemini CLI…',
  '/policy': 'Sandbox profiles, findings, learning mode',
  '/deploy': 'Cloud agents and costs',
  '/audit': 'Usage, security events, log',
  '/settings': 'Devices, identity, appearance',
};

export const MoreScreen = () => {
  const { open } = usePanicSheet();
  const { panic } = usePanicState();
  return (
    <Screen title="More" showPanic={false}>
      <div className="flex flex-col gap-6">
        {!panic && (
          <Button variant="destructive" size="lg" fullWidth icon={<Stop size={20} weight="fill" aria-hidden="true" />} onPress={open}>
            Stop everything
          </Button>
        )}
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {MORE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <Link to={item.to} className="flex min-h-14 items-center gap-4 px-4 py-2.5 outline-none hover:bg-sunken">
                  <Icon size={22} aria-hidden="true" className="text-ink-2" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="type-title-3 text-ink">{item.label}</span>
                    <span className="truncate type-meta text-ink-2">{HINT[item.to]}</span>
                  </span>
                  <CaretRight size={16} aria-hidden="true" className="text-ink-3" />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Screen>
  );
};
