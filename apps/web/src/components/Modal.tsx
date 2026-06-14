import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { Btn } from './common.js';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
  testId?: string;
}

export function Modal({ title, onClose, children, footer, maxWidth = 560, testId }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Move focus into the dialog — prefer a text field over the close button.
    const panel = panelRef.current;
    const focusable =
      panel?.querySelector<HTMLElement>('textarea, input, select') ??
      panel?.querySelector<HTMLElement>('button, [tabindex]');
    focusable?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      onClick={onClose}
      data-testid={testId}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,25,.5)',
        backdropFilter: 'blur(4px)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '60px 18px',
        animation: 'fadeIn .2s',
        overflowY: 'auto',
      }}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: '100%',
          maxWidth,
          background: 'var(--surface)',
          borderRadius: 22,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          animation: 'scaleIn .24s cubic-bezier(.2,.9,.3,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 17 }}>{title}</span>
          <Btn
            onClick={onClose}
            aria-label="close"
            data-testid="modal-close"
            style={{ display: 'flex', padding: 7, border: 'none', borderRadius: 9, background: 'transparent', color: 'var(--text-2)', cursor: 'pointer' }}
            hoverStyle={{ background: 'var(--surface-2)' }}
          >
            <Icon name="x" size={19} strokeWidth={2.2} />
          </Btn>
        </div>
        <div>{children}</div>
        {footer ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--border)' }}>{footer}</div> : null}
      </div>
    </div>
  );
}
