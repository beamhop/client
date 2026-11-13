/**
 * Code-based TanStack Router tree — every route from SCREENS §0.1.
 * Screen components are lazy-loaded from `src/screens/<name>/` (one directory per owner).
 * Builders normally never edit this file; if you need a new route, add it here and in README.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { Root } from './Root.tsx';
import { NotFound } from './screens/NotFound.tsx';
import { RouteError, RoutePending } from './shell/RouteStates.tsx';

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });

const lazy = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T & string) =>
  lazyRouteComponent(load as () => Promise<Record<string, never>>, name as never);

// ── Operate
const home = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazy(() => import('./screens/home/HomeScreen.tsx'), 'HomeScreen'),
});

const inbox = createRoute({
  getParentRoute: () => rootRoute,
  path: 'inbox',
  staticData: { hideInboxRail: true },
  component: lazy(() => import('./screens/inbox/InboxScreen.tsx'), 'InboxScreen'),
});
const inboxIndex = createRoute({ getParentRoute: () => inbox, path: '/' });
const inboxItem = createRoute({
  getParentRoute: () => inbox,
  path: '$approvalId',
  component: lazy(() => import('./screens/inbox/ApprovalDetail.tsx'), 'ApprovalDetail'),
});

const sessions = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sessions',
  component: lazy(() => import('./screens/sessions/SessionsScreen.tsx'), 'SessionsScreen'),
});
const sessionsIndex = createRoute({ getParentRoute: () => sessions, path: '/' });
const session = createRoute({
  getParentRoute: () => sessions,
  path: '$sessionId',
  staticData: { hideTabBar: true },
  component: lazy(() => import('./screens/sessions/SessionScreen.tsx'), 'SessionScreen'),
});

// ── Configure
const agents = createRoute({
  getParentRoute: () => rootRoute,
  path: 'agents',
  component: lazy(() => import('./screens/agents/AgentsScreen.tsx'), 'AgentsScreen'),
});
const agentsIndex = createRoute({ getParentRoute: () => agents, path: '/' });
const agentNew = createRoute({
  getParentRoute: () => agents,
  path: 'new',
  component: lazy(() => import('./screens/agents/NewAgentScreen.tsx'), 'NewAgentScreen'),
});
const agent = createRoute({
  getParentRoute: () => agents,
  path: '$name',
  component: lazy(() => import('./screens/agents/AgentDetailScreen.tsx'), 'AgentDetailScreen'),
});
const agentSection = createRoute({
  getParentRoute: () => agents,
  path: '$name/$section',
  component: lazy(() => import('./screens/agents/AgentDetailScreen.tsx'), 'AgentDetailScreen'),
});

const channels = createRoute({
  getParentRoute: () => rootRoute,
  path: 'channels',
  component: lazy(() => import('./screens/channels/ChannelsScreen.tsx'), 'ChannelsScreen'),
});
const channelsIndex = createRoute({ getParentRoute: () => channels, path: '/' });
const channelAdd = createRoute({
  getParentRoute: () => channels,
  path: 'add',
  component: lazy(() => import('./screens/channels/AddChannelScreen.tsx'), 'AddChannelScreen'),
});
const channelWizard = createRoute({
  getParentRoute: () => channels,
  path: 'add/$provider/$step',
  staticData: { hideTabBar: true },
  component: lazy(() => import('./screens/channels/ChannelWizardScreen.tsx'), 'ChannelWizardScreen'),
});
const channel = createRoute({
  getParentRoute: () => channels,
  path: '$id',
  component: lazy(() => import('./screens/channels/ChannelDetailScreen.tsx'), 'ChannelDetailScreen'),
});

const harnesses = createRoute({
  getParentRoute: () => rootRoute,
  path: 'harnesses',
  component: lazy(() => import('./screens/harnesses/HarnessesScreen.tsx'), 'HarnessesScreen'),
});

const policy = createRoute({
  getParentRoute: () => rootRoute,
  path: 'policy',
  component: lazy(() => import('./screens/policy/PolicyScreen.tsx'), 'PolicyScreen'),
});
const policyIndex = createRoute({ getParentRoute: () => policy, path: '/' });
const policyProfile = createRoute({
  getParentRoute: () => policy,
  path: '$profile',
  component: lazy(() => import('./screens/policy/PolicyProfileScreen.tsx'), 'PolicyProfileScreen'),
});

// ── Run
const deploy = createRoute({
  getParentRoute: () => rootRoute,
  path: 'deploy',
  component: lazy(() => import('./screens/deploy/DeployScreen.tsx'), 'DeployScreen'),
});
const deployIndex = createRoute({ getParentRoute: () => deploy, path: '/' });
const deployNew = createRoute({
  getParentRoute: () => deploy,
  path: 'new',
  component: lazy(() => import('./screens/deploy/NewDeployScreen.tsx'), 'NewDeployScreen'),
});
const deployment = createRoute({
  getParentRoute: () => deploy,
  path: '$deploymentId',
  component: lazy(() => import('./screens/deploy/DeploymentScreen.tsx'), 'DeploymentScreen'),
});

export type AuditTab = 'usage' | 'security' | 'log';
const audit = createRoute({
  getParentRoute: () => rootRoute,
  path: 'audit',
  validateSearch: (s: Record<string, unknown>): { tab: AuditTab } => ({
    tab: s.tab === 'security' || s.tab === 'log' ? s.tab : 'usage',
  }),
  component: lazy(() => import('./screens/audit/AuditScreen.tsx'), 'AuditScreen'),
});

const settings = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: lazy(() => import('./screens/settings/SettingsScreen.tsx'), 'SettingsScreen'),
});
const settingsIndex = createRoute({ getParentRoute: () => settings, path: '/' });
const settingsSection = createRoute({
  getParentRoute: () => settings,
  path: '$section',
  component: lazy(() => import('./screens/settings/SettingsSectionScreen.tsx'), 'SettingsSectionScreen'),
});

// ── Flows
const setupIndex = createRoute({
  getParentRoute: () => rootRoute,
  path: 'setup',
  beforeLoad: () => {
    throw redirect({ to: '/setup/$step', params: { step: 'doctor' } });
  },
});
const setup = createRoute({
  getParentRoute: () => rootRoute,
  path: 'setup/$step',
  staticData: { chrome: 'bare' },
  component: lazy(() => import('./screens/onboarding/OnboardingScreen.tsx'), 'OnboardingScreen'),
});
const pair = createRoute({
  getParentRoute: () => rootRoute,
  path: 'pair',
  staticData: { chrome: 'bare' },
  component: lazy(() => import('./screens/pair/PairScreen.tsx'), 'PairScreen'),
});
const panic = createRoute({
  getParentRoute: () => rootRoute,
  path: 'panic',
  component: lazy(() => import('./screens/panic/PanicScreen.tsx'), 'PanicScreen'),
});
const more = createRoute({
  getParentRoute: () => rootRoute,
  path: 'more',
  component: lazy(() => import('./screens/more/MoreScreen.tsx'), 'MoreScreen'),
});
const kitchen = createRoute({
  getParentRoute: () => rootRoute,
  path: '_kitchen',
  component: lazy(() => import('./screens/kitchen/KitchenScreen.tsx'), 'KitchenScreen'),
});

const routeTree = rootRoute.addChildren([
  home,
  inbox.addChildren([inboxIndex, inboxItem]),
  sessions.addChildren([sessionsIndex, session]),
  agents.addChildren([agentsIndex, agentNew, agentSection, agent]),
  channels.addChildren([channelsIndex, channelAdd, channelWizard, channel]),
  harnesses,
  policy.addChildren([policyIndex, policyProfile]),
  deploy.addChildren([deployIndex, deployNew, deployment]),
  audit,
  settings.addChildren([settingsIndex, settingsSection]),
  setupIndex,
  setup,
  pair,
  panic,
  more,
  kitchen,
]);

export const createAppRouter = () =>
  createRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 300,
    defaultPendingMinMs: 400,
    defaultErrorComponent: RouteError,
    scrollRestoration: true,
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
