import type { CSSProperties, ReactNode } from 'react';
import { useApp, type View } from '../store/AppContext.js';
import { Icon, Verified, type IconName } from './Icon.js';
import { BeamhopLogoAnimated } from './BeamhopLogoAnimated.js';
import { Avatar, Btn, personView } from './common.js';

function navStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 13,
    padding: '11px 14px',
    borderRadius: 12,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-2)',
    fontWeight: active ? 700 : 600,
    fontSize: 15,
    fontFamily: 'inherit',
    width: '100%',
    textAlign: 'left',
  };
}

const NAV: ReadonlyArray<{ view: View; icon: IconName; label: string }> = [
  { view: 'home', icon: 'home', label: 'Home' },
  { view: 'explore', icon: 'search', label: 'Explore' },
  { view: 'messages', icon: 'messages', label: 'Messages' },
  { view: 'profile', icon: 'user', label: 'Profile' },
  { view: 'security', icon: 'shield', label: 'Keys & Security' },
];

export function Sidebar(): ReactNode {
  const app = useApp();
  const { state, view, setView, viewProfile, theme, toggleTheme, openCompose, toast } = app;
  const me = personView(state.pubkey, state.profiles[state.pubkey]);
  const dmUnread = state.conversations.reduce((a, c) => a + c.unread, 0);

  return (
    <aside
      style={{
        width: 262,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 16px',
        gap: 6,
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      <div style={{ padding: '6px 6px 16px' }}>
        <BeamhopLogoAnimated />
      </div>

      <Btn
        onClick={() => toast('Workspace switching is a demo stub', 'info')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 10px',
          margin: '0 0 6px',
          border: '1px solid var(--border)',
          borderRadius: 12,
          background: 'var(--surface)',
          cursor: 'pointer',
          width: '100%',
        }}
        hoverStyle={{ borderColor: 'var(--border-2)', background: 'var(--surface-2)' }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--grad)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 700,
            fontSize: 13,
            fontFamily: "'Space Grotesk',sans-serif",
          }}
        >
          A
        </span>
        <span style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>Aperture</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>Workspace · Nostr</span>
        </span>
        <Icon name="chevron-down" size={15} stroke="var(--text-3)" strokeWidth={2.2} />
      </Btn>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {NAV.map((item) => {
          const active = view === item.view;
          return (
            <Btn
              key={item.view}
              onClick={() => (item.view === 'profile' ? viewProfile(null) : setView(item.view))}
              data-testid={`nav-${item.view}`}
              style={navStyle(active)}
              hoverStyle={active ? {} : { background: 'var(--surface-2)' }}
            >
              <Icon name={item.icon} size={21} />
              <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
              {item.view === 'messages' && dmUnread > 0 ? (
                <span
                  data-testid="dm-unread-badge"
                  style={{
                    background: 'var(--accent)',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 700,
                    minWidth: 18,
                    height: 18,
                    padding: '0 5px',
                    borderRadius: 9,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {dmUnread}
                </span>
              ) : null}
            </Btn>
          );
        })}
      </nav>

      <Btn
        onClick={openCompose}
        data-testid="new-post"
        style={{
          marginTop: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          padding: 13,
          border: 'none',
          borderRadius: 14,
          background: 'var(--accent)',
          color: '#fff',
          fontWeight: 700,
          fontSize: 15,
          fontFamily: 'inherit',
          cursor: 'pointer',
          boxShadow: '0 6px 16px -8px rgba(79,70,229,.6)',
        }}
        hoverStyle={{ filter: 'brightness(1.07)', boxShadow: '0 8px 20px -6px rgba(79,70,229,.5)' }}
        activeStyle={{ transform: 'scale(.97)' }}
      >
        <Icon name="plus" size={19} strokeWidth={2.4} />
        New post
      </Btn>

      <div style={{ flex: 1 }} />

      <Btn
        onClick={toggleTheme}
        data-testid="theme-toggle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '11px 14px',
          border: 'none',
          borderRadius: 12,
          background: 'transparent',
          color: 'var(--text-2)',
          fontWeight: 600,
          fontSize: 14,
          fontFamily: 'inherit',
          cursor: 'pointer',
          width: '100%',
        }}
        hoverStyle={{ background: 'var(--surface-2)' }}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
        <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
      </Btn>

      <Btn
        onClick={() => viewProfile(null)}
        data-testid="me-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '9px 10px',
          border: '1px solid var(--border)',
          borderRadius: 14,
          background: 'var(--surface)',
          cursor: 'pointer',
          width: '100%',
          marginTop: 4,
        }}
        hoverStyle={{ background: 'var(--surface-2)' }}
      >
        <Avatar pubkey={me.pubkey} profile={me.profile} name={me.name} size={42} />
        <span style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>
            {me.name.split(' ')[0]}
            {me.verified ? <Verified size={13} /> : null}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: 11.5,
              color: 'var(--text-3)',
              fontFamily: "'JetBrains Mono',monospace",
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {me.handle}
          </span>
        </span>
      </Btn>
    </aside>
  );
}
