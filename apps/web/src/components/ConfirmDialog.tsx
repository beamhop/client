import { useEffect, type ReactNode } from 'react';
import { Btn } from './common.js';

/** A small centered confirmation modal for destructive or irreversible actions. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="confirm-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(10,10,25,.5)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
        animation: 'fadeIn .15s',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 18,
          boxShadow: 'var(--shadow-lg)',
          padding: 22,
          animation: 'scaleIn .18s cubic-bezier(.2,.9,.3,1)',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 18, fontWeight: 700 }}>{title}</h3>
        <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, color: 'var(--text-2)' }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Btn
            onClick={onCancel}
            data-testid="confirm-cancel"
            style={{ padding: '9px 16px', borderRadius: 999, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 13.5, fontFamily: 'inherit', cursor: 'pointer' }}
            hoverStyle={{ background: 'var(--surface-2)' }}
          >
            {cancelLabel}
          </Btn>
          <Btn
            onClick={onConfirm}
            data-testid="confirm-accept"
            style={{
              padding: '9px 16px',
              borderRadius: 999,
              border: 'none',
              background: danger ? 'var(--danger)' : 'var(--accent)',
              color: '#fff',
              fontWeight: 700,
              fontSize: 13.5,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
            activeStyle={{ transform: 'scale(.96)' }}
          >
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
