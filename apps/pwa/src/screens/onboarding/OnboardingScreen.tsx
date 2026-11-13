/**
 * TODO(onboarding builder): First-run onboarding — SCREENS §11, JOURNEYS §1, PLAN §9A.
 * Owns: src/screens/onboarding/**. Route: /setup/$step, step ∈ doctor|harnesses|identity|phone|agent|hello
 * (no app chrome: staticData.chrome = 'bare'; /setup redirects to /setup/doctor).
 * Build: stepper rail (top on compact, vertical 280px rail on desktop), each step per JOURNEYS §1,
 * sticky `Continue · <next step>` + Back, CLI strip. Uses 100svh. Data: 'system.doctor', 'harness.scan',
 * 'identity.get', 'device.pairStart' (QrCode), 'agent.presets', 'agent.create'.
 */
import { useParams } from '@tanstack/react-router';
import { useExpanded } from '../../lib/media.ts';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { Wordmark } from '../../shell/Wordmark.tsx';
import { LinkButton } from '../../ui/Button.tsx';
import { Stepper } from '../../ui/Stepper.tsx';

export const SETUP_STEPS = ['doctor', 'harnesses', 'identity', 'phone', 'agent', 'hello'] as const;
const LABEL: Record<string, string> = { doctor: 'Doctor', harnesses: 'Harnesses', identity: 'Identity', phone: 'Phone', agent: 'Agent', hello: 'Hello' };

export const OnboardingScreen = () => {
  const { step } = useParams({ strict: false }) as { step: string };
  const expanded = useExpanded();
  const i = Math.max(0, SETUP_STEPS.indexOf(step as (typeof SETUP_STEPS)[number]));
  const next = SETUP_STEPS[i + 1];
  const body = (
    <div className="flex flex-col gap-4">
      <p className="type-micro text-ink-2">
        {String(i + 1).padStart(2, '0')} · {LABEL[SETUP_STEPS[i]!]}
      </p>
      <h1 className="type-title-1 text-ink">{i === 0 ? 'Check this computer' : LABEL[SETUP_STEPS[i]!]}</h1>
      <ScreenStub
        spec={`JOURNEYS §1.0${i + 1}`}
        owner="src/screens/onboarding/"
        outline={['Doctor rows resolve live with fixes', 'Harness scan · Identity key · Pair phone (QR + safety phrase)', 'First agent with exposure summary', 'Hello round-trip over 3 relays']}
        calls={i === 0 ? [{ method: 'system.doctor' }] : [{ method: 'harness.list' }]}
        cli="npx beamhop"
      />
      {next && (
        <LinkButton href={`/setup/${next}`} variant="primary" size="lg" className="mt-2 self-start">
          Continue · {LABEL[next]}
        </LinkButton>
      )}
    </div>
  );
  if (expanded) {
    return (
      <div className="grid min-h-svh grid-cols-[280px_1fr]">
        <aside className="border-r border-line px-6 py-6">
          <Wordmark />
          <Stepper className="mt-10" orientation="vertical" steps={SETUP_STEPS.map((s) => LABEL[s]!)} current={i} />
        </aside>
        <div className="max-w-[640px] px-10 py-16" id="bh-main-content">
          {body}
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-svh px-gutter pt-[calc(var(--bh-safe-top)+16px)] pb-10" id="bh-main-content">
      <div className="mb-6 flex items-center justify-between">
        <Wordmark />
        <span className="type-meta text-ink-2">
          {i + 1} of {SETUP_STEPS.length}
        </span>
      </div>
      <Stepper steps={SETUP_STEPS.map((s) => LABEL[s]!)} current={i} className="mb-6" />
      {body}
    </div>
  );
};
