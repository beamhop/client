import { useState, type CSSProperties, type ReactNode, type MouseEvent } from 'react';
import { encodeNpub, displayName, type Profile } from '@beamhop/core';
import { avatarStyle, initials as toInitials, truncateMiddle } from '../lib/ui.js';

/** A button that applies hover/active style overrides (replaces prototype style-hover). */
export interface BtnProps {
  onClick?: (e: MouseEvent) => void;
  style: CSSProperties;
  hoverStyle?: CSSProperties;
  activeStyle?: CSSProperties;
  title?: string;
  children?: ReactNode;
  type?: 'button' | 'submit';
  disabled?: boolean;
  'data-testid'?: string;
  'aria-label'?: string;
}

export function Btn(props: BtnProps): ReactNode {
  const { onClick, style, hoverStyle, activeStyle, children, title, type = 'button', disabled } = props;
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const merged: CSSProperties = {
    ...style,
    ...(hover && hoverStyle ? hoverStyle : {}),
    ...(active && activeStyle ? activeStyle : {}),
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={merged}
      data-testid={props['data-testid']}
      aria-label={props['aria-label']}
    >
      {children}
    </button>
  );
}

/** A keyboard-accessible inline link that navigates to a profile (or anywhere). */
export function ProfileLink({
  onActivate,
  label,
  children,
  style,
  testId,
}: {
  onActivate: () => void;
  label: string;
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
}): ReactNode {
  return (
    <span
      role="link"
      tabIndex={0}
      aria-label={label}
      data-testid={testId}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </span>
  );
}

export interface AvatarProps {
  pubkey: string;
  profile?: Profile | undefined;
  name: string;
  size: number;
  style?: CSSProperties;
}

export function Avatar({ pubkey, profile, name, size, style }: AvatarProps): ReactNode {
  const base = { ...avatarStyle(pubkey || name, size), ...style };
  const picture = profile?.metadata.picture;
  if (picture && typeof picture === 'string') {
    return (
      <span style={base}>
        <img
          src={picture}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      </span>
    );
  }
  return <span style={base}>{toInitials(name)}</span>;
}

export interface PersonView {
  pubkey: string;
  name: string;
  handle: string;
  npub: string;
  verified: boolean;
  profile: Profile | undefined;
}

/** Derive display fields for a pubkey from its (optional) profile. */
export function personView(pubkey: string, profile: Profile | undefined): PersonView {
  const npub = encodeNpub(pubkey);
  const shortNpub = truncateMiddle(npub, 10, 4);
  const name = displayName(profile, shortNpub);
  const nip05 = typeof profile?.metadata.nip05 === 'string' ? profile.metadata.nip05 : undefined;
  const handle = nip05 ?? `${npub.slice(0, 12)}…`;
  return { pubkey, name, handle, npub, verified: !!nip05, profile };
}
