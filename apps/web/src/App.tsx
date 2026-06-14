import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_RELAYS, encodeNsec } from '@beamhop/core';
import { VerityEngine } from './engine/VerityEngine.js';
import { AppProvider } from './store/AppContext.js';
import { Shell } from './Shell.js';
import { Login } from './views/Login.js';
import {
  restoreSession,
  clearSession,
  createNewIdentity,
  loadRelays,
  type Session,
} from './lib/session.js';
import { Logo } from './components/Icon.js';

function Splash(): ReactNode {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--bg)' }}>
      <Logo size={48} />
      <div style={{ width: 24, height: 24, border: '3px solid var(--border-2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
    </div>
  );
}

export function App(): ReactNode {
  const [session, setSession] = useState<Session | null>(null);
  const [engine, setEngine] = useState<VerityEngine | null>(null);
  const [booting, setBooting] = useState(true);
  const engineRef = useRef<VerityEngine | null>(null);

  // Restore any persisted session on first load.
  useEffect(() => {
    setSession(restoreSession());
    setBooting(false);
  }, []);

  // Build (and tear down) the engine whenever the session changes.
  useEffect(() => {
    if (!session) {
      setEngine(null);
      return;
    }
    let cancelled = false;
    const relays = loadRelays() ?? [...DEFAULT_RELAYS];
    void VerityEngine.create(session, relays).then((eng) => {
      if (cancelled) {
        eng.destroy();
        return;
      }
      engineRef.current = eng;
      setEngine(eng);
      void eng.start();
    });
    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [session]);

  const onLogout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  const onRotate = useCallback(async () => {
    const next = createNewIdentity();
    setSession(next);
    await Promise.resolve();
  }, []);

  if (booting) return <Splash />;
  if (!session) return <Login onSession={setSession} />;
  if (!engine) return <Splash />;

  const nsec = session.keyPair ? encodeNsec(session.keyPair.secretKey) : null;

  return (
    <AppProvider engine={engine} nsec={nsec} onLogout={onLogout} onRotate={onRotate}>
      <Shell />
    </AppProvider>
  );
}
