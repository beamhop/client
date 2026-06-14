import type { ReactNode } from 'react';
import { useApp } from './store/AppContext.js';
import { Sidebar } from './components/Sidebar.js';
import { Header } from './components/Header.js';
import { RightRail } from './components/RightRail.js';
import { MobileNav } from './components/MobileNav.js';
import { Toasts } from './components/Toasts.js';
import { Home } from './views/Home.js';
import { Explore } from './views/Explore.js';
import { Messages } from './views/Messages.js';
import { Profile } from './views/Profile.js';
import { NoteDetail } from './views/NoteDetail.js';
import { Security } from './views/Security.js';
import { ComposeModal } from './modals/ComposeModal.js';
import { EditProfileModal } from './modals/EditProfileModal.js';
import { RotateKeyModal } from './modals/RotateKeyModal.js';
import { RelaysModal } from './modals/RelaysModal.js';
import { CommandPalette } from './components/CommandPalette.js';
import { useGlobalKeyboard } from './hooks/useKeyboard.js';

function CurrentView(): ReactNode {
  const { view } = useApp();
  switch (view) {
    case 'home':
      return <Home />;
    case 'explore':
      return <Explore />;
    case 'messages':
      return <Messages />;
    case 'profile':
      return <Profile />;
    case 'note':
      return <NoteDetail />;
    case 'security':
      return <Security />;
    default:
      return null;
  }
}

export function Shell(): ReactNode {
  const { theme, isMobile, view, showCompose, showEdit, showRotate, showRelays, showPalette } = useApp();
  useGlobalKeyboard();
  const showRightRail = !isMobile && (view === 'home' || view === 'explore');

  return (
    <div
      data-theme={theme}
      data-testid="app-shell"
      style={{
        background: 'var(--bg)',
        color: 'var(--text)',
        minHeight: '100vh',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Hanken Grotesk',sans-serif",
        transition: 'background .3s, color .3s',
      }}
    >
      <div style={{ flex: 1, display: 'flex', width: '100%', maxWidth: 1340, margin: '0 auto', minHeight: 0 }}>
        {!isMobile ? <Sidebar /> : null}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
          <Header />
          <div style={{ flex: 1, overflowY: view === 'messages' ? 'hidden' : 'auto', minHeight: 0 }}>
            <CurrentView />
          </div>
        </main>
        {showRightRail ? <RightRail /> : null}
      </div>

      {isMobile ? <MobileNav /> : null}
      {showCompose ? <ComposeModal /> : null}
      {showEdit ? <EditProfileModal /> : null}
      {showRotate ? <RotateKeyModal /> : null}
      {showRelays ? <RelaysModal /> : null}
      {showPalette ? <CommandPalette /> : null}
      <Toasts />
    </div>
  );
}
