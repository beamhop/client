/**
 * TODO(channels builder): Channel wizard — SCREENS §5 "Wizard step", JOURNEYS §4 (Telegram/Slack/Discord).
 * Route: /channels/add/$provider/$step (step = 1..6; tab bar hidden on compact). Desktop: 720px pane,
 * vertical Stepper. Uses SecretField (format check), channel.validate → channel.add → channel.pair,
 * deep links, focus moves to the step heading on change (Stepper announces "Step 5 of 6: Pair").
 */
import { useParams } from '@tanstack/react-router';
import { PROVIDER_NAMES } from '../../api/index.ts';
import { useExpanded } from '../../lib/media.ts';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { Stepper } from '../../ui/Stepper.tsx';

export const WIZARD_STEPS = ['Create', 'Credentials', 'Validate', 'Connect', 'Pair', 'Join'];

export const ChannelWizardScreen = () => {
  const { provider, step } = useParams({ strict: false }) as { provider: string; step: string };
  const i = Math.min(WIZARD_STEPS.length - 1, Math.max(0, Number(step) - 1 || 0));
  const name = PROVIDER_NAMES[provider] ?? provider;
  const expanded = useExpanded();
  return (
    <Screen
      title={`Add ${name}`}
      back={{ href: '/channels/add', label: 'Add a channel' }}
      pane="detail"
      maxWidth="form"
      crumbs={[{ label: 'Channels', href: '/channels' }, { label: 'Add', href: '/channels/add' }, { label: name }]}
      titleAside={<span className="type-meta text-ink-2">{i + 1} / {WIZARD_STEPS.length}</span>}
    >
      <div className="flex flex-col gap-6">
        <Stepper steps={WIZARD_STEPS} current={i} orientation={expanded ? 'horizontal' : 'horizontal'} showLabels={expanded} />
        <ScreenStub
          spec={`JOURNEYS §4 ${name} · step ${String(i + 1).padStart(2, '0')} ${WIZARD_STEPS[i]}`}
          owner="src/screens/channels/"
          outline={['Create: deep link to the provider + copyable script', 'Credentials: SecretField with live format check', 'Validate / Connect resolve in place', 'Pair: deep link + code (Doto) · Join: chats, roles, triggers']}
          cli={`beamhop channel add ${provider}`}
        />
      </div>
    </Screen>
  );
};
