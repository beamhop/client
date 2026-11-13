/**
 * First-run onboarding — SCREENS §11, JOURNEYS §1, PLAN §9A. Route `/setup/$step` (bare chrome),
 * step ∈ doctor · harnesses · identity · phone · agent · hello · next (summary).
 * Every step is a URL (reload/back work); progress is resumable (`progress.ts`); every failing state has
 * a fix, an alternative or a skip (0 dead ends).
 *
 * Research used: JOURNEYS §1 references; wizard vs checklist and "make each step skippable, show
 * progress" (https://www.saasui.design/blog/saas-onboarding-checklist-ux-patterns ,
 * https://evilmartians.com/chronicles/easy-and-epiphany-4-ways-to-stop-misguided-dev-tools-users-onboarding);
 * linked-device QR phishing → confirm the safety phrase on the trusted side (https://attack.mitre.org/techniques/T1676).
 */
import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { isStep, resumeAt, useSetupProgress } from './progress.ts';
import { StepDoctor, StepHarnesses } from './StepChecks.tsx';
import { useGoStep } from './StepFrame.tsx';
import { StepHello, StepNext } from './StepHello.tsx';
import { StepAgent, StepIdentity, StepPhone } from './StepSetup.tsx';

export { SETUP_STEPS } from './progress.ts';

export const OnboardingScreen = () => {
  const { step } = useParams({ strict: false }) as { step: string };
  const [progress] = useSetupProgress();
  const go = useGoStep();
  const known = isStep(step) || step === 'next';

  // Unknown step (old link, typo): resume where the user stopped.
  useEffect(() => {
    if (!known) go(resumeAt(progress));
  }, [known, go, progress]);

  switch (step) {
    case 'doctor':
      return <StepDoctor />;
    case 'harnesses':
      return <StepHarnesses />;
    case 'identity':
      return <StepIdentity />;
    case 'phone':
      return <StepPhone />;
    case 'agent':
      return <StepAgent />;
    case 'hello':
      return <StepHello />;
    case 'next':
      return <StepNext />;
    default:
      return null;
  }
};
