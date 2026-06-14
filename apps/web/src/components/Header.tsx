import type { ReactNode } from 'react';
import { useApp, type View } from '../store/AppContext.js';
import { Icon, Logo } from './Icon.js';
import { Btn } from './common.js';

const TITLES: Record<View, [string, string]> = {
  home: ['Home', 'Your workspace feed'],
  explore: ['Explore', 'Discover people and curate your feed'],
  messages: ['Messages', 'End-to-end encrypted'],
  profile: ['Profile', 'Manage how you appear'],
  note: ['Thread', 'A post and its replies'],
  security: ['Keys & Security', 'Identity, signing keys and audit trail'],
};

export function Header(): ReactNode {
  const { view, isMobile, theme, toggleTheme } = useApp();
  const [title, subtitle] = TITLES[view];
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '16px 22px',
        borderBottom: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--surface) 80%, transparent)',
        backdropFilter: 'blur(12px)',
        position: 'sticky',
        top: 0,
        zIndex: 5,
      }}
    >
      {isMobile ? <Logo size={26} /> : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1
          data-testid="view-title"
          style={{
            margin: 0,
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-.02em',
            lineHeight: 1.1,
          }}
        >
          {title}
        </h1>
        <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-3)' }}>{subtitle}</p>
      </div>
      {isMobile ? (
        <Btn
          onClick={toggleTheme}
          style={{
            display: 'flex',
            padding: 9,
            border: '1px solid var(--border)',
            borderRadius: 11,
            background: 'var(--surface)',
            color: 'var(--text-2)',
            cursor: 'pointer',
          }}
          hoverStyle={{ background: 'var(--surface-2)' }}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
        </Btn>
      ) : null}
    </header>
  );
}
