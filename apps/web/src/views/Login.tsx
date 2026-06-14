import { useState, type ReactNode } from 'react';
import { detectNip07 } from '@verity/core';
import { Logo, Icon } from '../components/Icon.js';
import { Btn } from '../components/common.js';
import { createNewIdentity, importNsec, connectNip07, type Session } from '../lib/session.js';

export interface LoginProps {
  onSession: (session: Session) => void;
}

export function Login({ onSession }: LoginProps): ReactNode {
  const [nsec, setNsec] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasNip07 = !!detectNip07();

  const handleCreate = () => {
    setBusy(true);
    onSession(createNewIdentity());
  };
  const handleImport = () => {
    setError(null);
    try {
      const session = importNsec(nsec);
      onSession(session);
    } catch {
      setError('That does not look like a valid nsec key.');
    }
  };
  const handleNip07 = async () => {
    setError(null);
    setBusy(true);
    try {
      onSession(await connectNip07());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to a NIP-07 signer.');
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'var(--bg)' }}>
      <div
        data-testid="login"
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 24,
          padding: 32,
          boxShadow: 'var(--shadow-lg)',
          animation: 'scaleIn .3s cubic-bezier(.2,.9,.3,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <Logo size={40} />
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: '-.02em' }}>Verity</span>
        </div>
        <p style={{ margin: '0 0 24px', color: 'var(--text-2)', fontSize: 14.5, lineHeight: 1.5 }}>
          Verifiable identity for teams, built on Nostr. Your keys, your messages, end-to-end encrypted.
        </p>

        <Btn
          onClick={handleCreate}
          data-testid="create-identity"
          disabled={busy}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 14, border: 'none', borderRadius: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}
          hoverStyle={{ filter: 'brightness(1.07)' }}
          activeStyle={{ transform: 'scale(.98)' }}
        >
          <Icon name="plus" size={18} strokeWidth={2.4} />
          Create a new identity
        </Btn>

        {hasNip07 ? (
          <Btn
            onClick={() => void handleNip07()}
            data-testid="connect-nip07"
            disabled={busy}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 13, border: '1px solid var(--border-2)', borderRadius: 14, background: 'var(--surface)', color: 'var(--text)', fontWeight: 700, fontSize: 14.5, cursor: 'pointer', marginBottom: 18 }}
            hoverStyle={{ background: 'var(--surface-2)' }}
          >
            <Icon name="key" size={17} />
            Connect browser signer (NIP-07)
          </Btn>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 16px' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>or import an existing key</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <input
          data-testid="nsec-input"
          value={nsec}
          onChange={(e) => setNsec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleImport();
          }}
          placeholder="nsec1…"
          style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2)', padding: '12px 14px', outline: 'none', fontSize: 14, color: 'var(--text)', fontFamily: "'JetBrains Mono',monospace", marginBottom: 10 }}
        />
        {error ? <p data-testid="login-error" style={{ margin: '0 0 10px', color: 'var(--danger)', fontSize: 13 }}>{error}</p> : null}
        <Btn
          onClick={handleImport}
          data-testid="import-nsec"
          disabled={busy || nsec.trim().length === 0}
          style={{ width: '100%', padding: 12, border: '1px solid var(--border-2)', borderRadius: 12, background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 14, cursor: nsec.trim() ? 'pointer' : 'default' }}
          hoverStyle={{ background: 'var(--surface-2)' }}
        >
          Import key
        </Btn>
      </div>
    </div>
  );
}
