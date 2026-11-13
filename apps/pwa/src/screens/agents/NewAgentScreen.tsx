/**
 * TODO(agents builder): New agent — SCREENS §4.3 (same form as onboarding step 05, JOURNEYS §1.05).
 * Route: /agents/new. Presets row first, name/harness/folder (PathPicker, RO default)/profile,
 * live exposure summary, primary `Create <name>`. Data: useApi('agent.presets'), useMutationApi('agent.create').
 */
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';

export const NewAgentScreen = () => (
  <Screen
    title="New agent"
    back={{ href: '/agents', label: 'Agents' }}
    pane="detail"
    maxWidth="form"
    crumbs={[{ label: 'Agents', href: '/agents' }, { label: 'New agent' }]}
  >
    <ScreenStub
      spec="SCREENS §4.3 · JOURNEYS §1.05"
      owner="src/screens/agents/"
      outline={[
        'Preset cards: Personal assistant, Code reviewer, Team dev bot, Public Q&A',
        'Name · Harness (ready only) · Folder (read-only default) · Sandbox profile',
        'Live exposure summary',
        'Create reviewer',
      ]}
      calls={[{ method: 'agent.presets' }, { method: 'harness.list' }]}
      cli="beamhop agent create reviewer --preset code-reviewer"
    />
  </Screen>
);
