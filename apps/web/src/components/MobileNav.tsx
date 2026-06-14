import type { CSSProperties, ReactNode } from 'react';
import { useApp, type View } from '../store/AppContext.js';
import { Icon, type IconName } from './Icon.js';
import { Btn } from './common.js';

function tabStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 14px',
    border: 'none',
    background: 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-3)',
    cursor: 'pointer',
  };
}

const TABS: ReadonlyArray<{ view: View; icon: IconName }> = [
  { view: 'home', icon: 'home' },
  { view: 'explore', icon: 'search' },
  { view: 'messages', icon: 'messages' },
  { view: 'profile', icon: 'user' },
];

export function MobileNav(): ReactNode {
  const { view, setView, viewProfile, openCompose } = useApp();
  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '8px 6px calc(8px + env(safe-area-inset-bottom))',
        background: 'color-mix(in srgb, var(--surface) 85%, transparent)',
        backdropFilter: 'blur(14px)',
        borderTop: '1px solid var(--border)',
        zIndex: 20,
      }}
    >
      <Btn onClick={() => setView('home')} style={tabStyle(view === 'home')} data-testid="tab-home">
        <Icon name="home" size={24} />
      </Btn>
      <Btn onClick={() => setView('explore')} style={tabStyle(view === 'explore')} data-testid="tab-explore">
        <Icon name="search" size={24} />
      </Btn>
      <Btn
        onClick={openCompose}
        data-testid="tab-compose"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 52,
          height: 52,
          marginTop: -18,
          border: 'none',
          borderRadius: 17,
          background: 'var(--accent)',
          color: '#fff',
          cursor: 'pointer',
          boxShadow: '0 8px 20px -6px rgba(79,70,229,.6)',
        }}
        activeStyle={{ transform: 'scale(.92)' }}
      >
        <Icon name="plus" size={24} strokeWidth={2.4} />
      </Btn>
      <Btn onClick={() => setView('messages')} style={tabStyle(view === 'messages')} data-testid="tab-messages">
        <Icon name="messages" size={24} />
      </Btn>
      <Btn onClick={() => viewProfile(null)} style={tabStyle(view === 'profile')} data-testid="tab-profile">
        <Icon name="user" size={24} />
      </Btn>
    </nav>
  );
}
