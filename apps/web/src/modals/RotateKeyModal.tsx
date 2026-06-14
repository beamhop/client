import { useState, type ReactNode } from 'react';
import { useApp } from '../store/AppContext.js';
import { Modal } from '../components/Modal.js';
import { Btn } from '../components/common.js';
import { Icon } from '../components/Icon.js';

/**
 * In Nostr a public key *is* the identity, so there is no in-place key rotation.
 * The honest analog is generating a fresh identity and switching to it — we make
 * that explicit and require the user to confirm they've backed up the old key.
 */
export function RotateKeyModal(): ReactNode {
  const { closeRotate, onRotate, toast } = useApp();
  const [rotating, setRotating] = useState(false);

  const confirm = async () => {
    setRotating(true);
    try {
      await onRotate();
      toast('New signing identity generated and logged', 'check');
      closeRotate();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Rotation failed', 'warn');
      setRotating(false);
    }
  };

  return (
    <Modal title="Rotate signing key" onClose={closeRotate} testId="rotate-modal" maxWidth={480}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 12, padding: 14, borderRadius: 12, background: 'var(--accent-soft)' }}>
          <Icon name="rotate" size={20} stroke="var(--accent)" />
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)' }}>
            On Nostr your public key is your identity. Rotating generates a brand-new keypair and switches beamhop to
            it — your previous identity will no longer sign from this device.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: 14, borderRadius: 12, border: '1px solid var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)' }}>
          <Icon name="shield" size={18} stroke="var(--warn)" />
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>
            Make sure you've backed up your current <strong style={{ color: 'var(--text)' }}>nsec</strong> from Keys &amp; Security first. This action is logged to your audit trail.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--border)' }}>
        <div style={{ flex: 1 }} />
        <Btn onClick={closeRotate} style={{ padding: '9px 18px', borderRadius: 999, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
          Cancel
        </Btn>
        <Btn
          onClick={() => void confirm()}
          data-testid="confirm-rotate"
          disabled={rotating}
          style={{ padding: '9px 22px', borderRadius: 999, border: 'none', background: 'var(--danger)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
          activeStyle={{ transform: 'scale(.96)' }}
        >
          {rotating ? 'Rotating…' : 'Rotate & switch'}
        </Btn>
      </div>
    </Modal>
  );
}
