import { useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../store/AppContext.js';
import { Btn } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { auditToCsv, type AuditEntry, type AuditType } from '../lib/audit.js';
import { timeAgo } from '../lib/ui.js';

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }): ReactNode {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 18,
        padding: 18,
        boxShadow: 'var(--shadow)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Toggle({ on, onClick, testId }: { on: boolean; onClick: () => void; testId: string }): ReactNode {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-pressed={on}
      style={{
        width: 42,
        height: 25,
        borderRadius: 999,
        background: on ? 'var(--accent)' : 'var(--border-2)',
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        border: 'none',
        padding: 0,
        transition: 'background .2s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: on ? 20 : 3,
          width: 19,
          height: 19,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left .2s cubic-bezier(.3,.8,.3,1)',
          boxShadow: '0 1px 3px rgba(0,0,0,.3)',
        }}
      />
    </button>
  );
}

const AUDIT_COLORS: Record<AuditType, string> = {
  key: 'var(--accent)',
  backup: 'var(--accent)',
  dm: '#8b5cf6',
  profile: '#0ea5e9',
  device: '#10b981',
  verify: '#10b981',
  post: '#f59e0b',
};

const COMPLIANCE = [
  { label: 'End-to-end encrypted DMs', detail: 'NIP-17 · NIP-44 · server never sees plaintext' },
  { label: 'Audit retention', detail: 'Local activity log · CSV export ready' },
  { label: 'Decentralized identity', detail: 'Self-custodied secp256k1 keypair' },
  { label: 'NIP-07 signer support', detail: 'Hardware/extension signing available' },
];

export function Security(): ReactNode {
  const { state, engine, nsec, toast, openRotate, onLogout, openRelays } = useApp();
  const [revealed, setRevealed] = useState(false);
  const npub = state.npub;
  const signerLabel = state.signerKind === 'nip07' ? 'NIP-07 browser extension' : 'Local in-app key';
  const signerStatus = state.signerKind === 'nip07' ? 'Connected · NIP-07' : 'Stored on this device';

  const copyNpub = () => {
    try {
      void navigator.clipboard?.writeText(npub);
    } catch {
      // ignore
    }
    toast('Public key copied to clipboard', 'copy');
  };
  const reveal = () => {
    if (!revealed) engine.logAudit('key', 'Signing key accessed', 'Private key revealed in-app');
    setRevealed((r) => !r);
  };
  const copyNsec = () => {
    if (!nsec) {
      toast('Private key is held by your NIP-07 signer', 'warn');
      return;
    }
    if (!revealed) {
      toast('Reveal the key before copying', 'warn');
      return;
    }
    try {
      void navigator.clipboard?.writeText(nsec);
    } catch {
      // ignore
    }
    engine.logAudit('key', 'Private key copied', 'Copied to clipboard');
    toast('Private key copied to clipboard', 'copy');
  };
  const exportAudit = () => {
    const csv = auditToCsv(state.audit);
    try {
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'verity-audit-log.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore download failures (e.g. in restricted contexts)
    }
    toast('Audit log exported · CSV ready for compliance', 'check');
  };

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '18px 18px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Keys */}
      <Card>
        <h3 style={{ margin: '0 0 14px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, fontWeight: 700 }}>Your keys</h3>

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>Public key (npub)</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
          <code data-testid="npub-value" style={{ flex: 1, fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: 'var(--text)', wordBreak: 'break-all', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 10 }}>
            {npub}
          </code>
          <Btn onClick={copyNpub} data-testid="copy-npub-sec" style={iconBtn} hoverStyle={{ background: 'var(--surface-2)' }}>
            <Icon name="copy" size={16} />
          </Btn>
        </div>

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', display: 'block', marginTop: 16 }}>Private key (nsec)</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
          <code
            data-testid="nsec-value"
            style={{
              flex: 1,
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12.5,
              color: 'var(--text)',
              wordBreak: 'break-all',
              background: 'var(--surface-2)',
              padding: '10px 12px',
              borderRadius: 10,
              filter: revealed ? 'none' : 'blur(7px)',
              userSelect: revealed ? 'text' : 'none',
              transition: 'filter .35s',
            }}
          >
            {nsec ?? 'Held securely by your NIP-07 signer'}
          </code>
          <Btn onClick={reveal} data-testid="reveal-key" style={iconBtn} hoverStyle={{ background: 'var(--surface-2)' }} title={revealed ? 'Hide' : 'Reveal'}>
            <Icon name={revealed ? 'check' : 'shield'} size={16} />
          </Btn>
          <Btn onClick={copyNsec} data-testid="copy-nsec" style={iconBtn} hoverStyle={{ background: 'var(--surface-2)' }} title="Copy">
            <Icon name="copy" size={16} />
          </Btn>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-3)' }}>
          Never share your nsec. Anyone with it can post and read DMs as you.
        </p>
      </Card>

      {/* Signer */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="key" size={20} stroke="var(--accent)" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }} data-testid="signer-label">{signerLabel}</div>
            <div style={{ fontSize: 12.5, color: 'var(--success)' }}>{signerStatus}</div>
          </div>
          <Btn onClick={openRotate} data-testid="open-rotate" style={pillBtn} hoverStyle={{ background: 'var(--surface-2)' }} activeStyle={{ transform: 'scale(.97)' }}>
            <Icon name="rotate" size={15} />
            Rotate key
          </Btn>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14, marginTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ flex: 1, fontSize: 13, color: 'var(--text-3)' }}>Sign out of Verity on this device. Your key stays valid — back it up first.</div>
          <Btn
            onClick={onLogout}
            data-testid="logout"
            style={{ ...pillBtn, borderColor: 'var(--danger)', color: 'var(--danger)' }}
            hoverStyle={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
          >
            <Icon name="logout" size={15} stroke="var(--danger)" />
            Sign out
          </Btn>
        </div>
      </Card>

      {/* Relays */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="globe" size={20} stroke="var(--accent)" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Relays</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }} data-testid="relay-count">{state.relays.length} connected</div>
          </div>
          <Btn onClick={openRelays} data-testid="open-relays" style={pillBtn} hoverStyle={{ background: 'var(--surface-2)' }} activeStyle={{ transform: 'scale(.97)' }}>
            <Icon name="globe" size={15} />
            Manage relays
          </Btn>
        </div>
      </Card>

      {/* Governance toggles */}
      <Card>
        <h3 style={{ margin: '0 0 6px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, fontWeight: 700 }}>Key governance</h3>
        <ToggleRow
          title="Require hardware signer"
          detail="Only sign events through a connected NIP-07 hardware/extension signer."
          on={state.settings.hardware}
          onClick={() => {
            const next = engine.toggleSetting('hardware');
            toast(`Hardware signer ${next ? 'required for signing' : 'set to optional'}`, 'info');
          }}
          testId="toggle-hardware"
        />
        <ToggleRow
          title="Delegated signing (NIP-26)"
          detail="Allow a delegated key to publish on behalf of this identity."
          on={state.settings.delegation}
          onClick={() => {
            const next = engine.toggleSetting('delegation');
            toast(`Delegated signing ${next ? 'enabled' : 'disabled'}`, 'info');
          }}
          testId="toggle-delegation"
        />
      </Card>

      {/* Audit log */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, fontWeight: 700 }}>Audit trail</h3>
          <Btn onClick={exportAudit} data-testid="export-audit" style={pillBtn} hoverStyle={{ background: 'var(--surface-2)' }}>
            <Icon name="download" size={15} />
            Export CSV
          </Btn>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {state.audit.length === 0 ? (
            <p style={{ color: 'var(--text-3)', fontSize: 13.5, margin: 0 }}>Activity you take in Verity will be logged here.</p>
          ) : (
            state.audit.slice(0, 20).map((a: AuditEntry) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }} data-testid="audit-entry">
                <span style={{ width: 34, height: 34, minWidth: 34, borderRadius: 10, background: AUDIT_COLORS[a.type], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="check" size={15} stroke="#fff" strokeWidth={2.6} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>{a.event}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{a.detail}</div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{timeAgo(Math.floor(a.at / 1000))}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Compliance */}
      <Card>
        <h3 style={{ margin: '0 0 12px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, fontWeight: 700 }}>Compliance posture</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {COMPLIANCE.map((c) => (
            <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="check" size={13} stroke="#fff" strokeWidth={3} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{c.label}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function ToggleRow({ title, detail, on, onClick, testId }: { title: string; detail: string; on: boolean; onClick: () => void; testId: string }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{detail}</div>
      </div>
      <Toggle on={on} onClick={onClick} testId={testId} />
    </div>
  );
}

const iconBtn: CSSProperties = {
  display: 'flex',
  padding: 10,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface)',
  color: 'var(--text-2)',
  cursor: 'pointer',
};

const pillBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 14px',
  border: '1px solid var(--border-2)',
  borderRadius: 999,
  background: 'var(--surface)',
  color: 'var(--text)',
  fontWeight: 700,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
