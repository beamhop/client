/**
 * Settings → About (SCREENS §10): who the daemon thinks you are (`system.whoami`: principal, role,
 * linked person, how the request reached it) next to how this app talks to it, plus the daemon's
 * version. "Am I the owner here, and over what?" is answered by the daemon, never guessed locally.
 */
import type { WhoamiView } from '@beamhop/core';
import { Crown, HardDrives, Plugs, UserCircle } from '@phosphor-icons/react';
import { type ConnectionKind, useApi, useConnection } from '../../api/index.ts';
import { MetaLine } from '../../ui/Meta.tsx';
import { ErrorState, Skeleton } from '../../ui/States.tsx';
import { Group, List, Row } from './kit.tsx';

/** How the request reached the daemon, in words (daemon `via` + this app's transport). */
export const connectionWords = (
  w: Pick<WhoamiView, 'via' | 'device'>,
  kind: ConnectionKind,
): { title: string; detail: string } => {
  if (w.via === 'local')
    return kind === 'local'
      ? { title: 'Local WebSocket', detail: 'this computer, with the daemon’s API token' }
      : kind === 'mock'
        ? { title: 'Demo daemon', detail: 'nothing leaves this browser' }
        : { title: 'Local', detail: 'this computer' };
  if (w.via === 'device')
    return {
      title: 'Paired device over Nostr',
      detail: w.device ? `${w.device.name} · end-to-end encrypted` : 'end-to-end encrypted',
    };
  return { title: 'Nostr', detail: 'signed with your own key' };
};

export const AboutSection = () => {
  const whoami = useApi('system.whoami');
  const status = useApi('system.status');
  const conn = useConnection();
  const w = whoami.data;
  if (whoami.isError)
    return (
      <ErrorState
        title="Couldn't ask the daemon who you are."
        details={whoami.error}
        onRetry={() => void whoami.refetch()}
      >
        {whoami.error.message}
      </ErrorState>
    );
  if (!w) return <Skeleton variant="list" count={3} label="Loading" />;
  const via = connectionWords(w, conn.kind);
  return (
    <div className="flex flex-col gap-8">
      <Group
        title="You, as the daemon sees you"
        id="about-you"
        note="Every approval, grant and change you make is logged under this name."
      >
        <List>
          <Row
            leading={
              w.role === 'owner' ? (
                <Crown size={22} aria-hidden="true" />
              ) : (
                <UserCircle size={22} aria-hidden="true" />
              )
            }
            title={w.displayName ?? w.person ?? w.principal}
            slug={
              <MetaLine
                items={[
                  { value: w.principal, truncate: 30 },
                  w.role,
                  w.person ? `linked to ${w.person}` : undefined,
                ]}
              />
            }
          />
          <Row
            leading={<Plugs size={22} aria-hidden="true" />}
            title={via.title}
            slug={<MetaLine items={[via.detail, conn.status === 'open' ? 'connected' : conn.status]} />}
          />
        </List>
      </Group>
      <Group title="Daemon" id="about-daemon">
        {status.data ? (
          <List>
            <Row
              leading={<HardDrives size={22} aria-hidden="true" />}
              title={`beamhopd ${status.data.version}`}
              slug={
                <MetaLine items={[status.data.home, `up ${Math.round(status.data.uptimeSec / 60)} min`]} />
              }
            />
          </List>
        ) : (
          <Skeleton variant="list" count={1} />
        )}
      </Group>
    </div>
  );
};
