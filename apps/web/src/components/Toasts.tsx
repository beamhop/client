import type { ReactNode } from 'react';
import { useApp, type ToastKind } from '../store/AppContext.js';

const VISUAL: Record<ToastKind, { bg: string; d: string }> = {
  check: { bg: 'var(--success)', d: 'M5 13l4 4L19 7' },
  copy: { bg: 'var(--accent)', d: 'M9 9h10v10H9zM5 15V5h10' },
  repost: { bg: 'var(--success)', d: 'M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14' },
  warn: { bg: 'var(--warn)', d: 'M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z' },
  info: { bg: 'var(--accent)', d: 'M12 16v-4M12 8h.01' },
};

export function Toasts(): ReactNode {
  const { toasts } = useApp();
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        zIndex: 80,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => {
        const vis = VISUAL[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            data-testid="toast"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '12px 18px',
              background: 'var(--text)',
              color: 'var(--bg)',
              borderRadius: 13,
              boxShadow: 'var(--shadow-lg)',
              fontSize: 14,
              fontWeight: 600,
              animation: 'toastIn .3s cubic-bezier(.2,.9,.3,1)',
              maxWidth: '90vw',
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: vis.bg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <path d={vis.d} />
              </svg>
            </span>
            <span>{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}
