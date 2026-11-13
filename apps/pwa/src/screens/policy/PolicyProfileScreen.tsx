/**
 * /policy/$profile — one route, three kinds of detail (route kept as in SCREENS §0.1):
 *   strict | workspace | custom → profile explainer;  roles → roles matrix;  anything else → agent editor.
 * Profile names and `roles` are reserved; agents are slugs so collisions are unlikely and the agent
 * editor stays reachable from Agents → Sandbox & roles.
 */
import { useParams } from '@tanstack/react-router';
import { AgentPolicyScreen } from './AgentPolicy.tsx';
import { isProfile } from './model.ts';
import { ProfileScreen } from './ProfileInfo.tsx';
import { RolesScreen } from './Roles.tsx';

export const PolicyProfileScreen = () => {
  const { profile } = useParams({ strict: false }) as { profile: string };
  if (profile === 'roles') return <RolesScreen />;
  if (isProfile(profile)) return <ProfileScreen profile={profile} />;
  return <AgentPolicyScreen name={profile} />;
};
