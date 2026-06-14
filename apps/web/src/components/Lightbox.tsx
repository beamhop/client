import { useEffect, type ReactNode } from 'react';
import { Btn } from './common.js';
import { Icon } from './Icon.js';

export interface LightboxImage {
  readonly url: string;
  readonly alt?: string | undefined;
}

/** Fullscreen image viewer with keyboard + on-screen gallery navigation. */
export function Lightbox({
  images,
  index,
  onClose,
  onNavigate,
}: {
  images: readonly LightboxImage[];
  index: number;
  onClose: () => void;
  onNavigate: (i: number) => void;
}): ReactNode {
  const count = images.length;
  const current = images[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (count > 1 && e.key === 'ArrowRight') onNavigate((index + 1) % count);
      else if (count > 1 && e.key === 'ArrowLeft') onNavigate((index - 1 + count) % count);
    };
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [index, count, onClose, onNavigate]);

  if (!current) return null;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      data-testid="lightbox"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(8,8,16,.92)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn .15s',
      }}
    >
      <Btn
        onClick={onClose}
        aria-label="Close"
        data-testid="lightbox-close"
        style={{ ...cornerBtn, top: 16, right: 16 }}
        hoverStyle={{ background: 'rgba(255,255,255,.18)' }}
      >
        <Icon name="x" size={22} stroke="#fff" />
      </Btn>

      {count > 1 ? (
        <>
          <Btn
            onClick={(e) => {
              e.stopPropagation();
              onNavigate((index - 1 + count) % count);
            }}
            aria-label="Previous image"
            style={{ ...cornerBtn, left: 16, top: '50%', transform: 'translateY(-50%)' }}
            hoverStyle={{ background: 'rgba(255,255,255,.18)' }}
          >
            <Icon name="chevron-left" size={26} stroke="#fff" />
          </Btn>
          <Btn
            onClick={(e) => {
              e.stopPropagation();
              onNavigate((index + 1) % count);
            }}
            aria-label="Next image"
            style={{ ...cornerBtn, right: 16, top: '50%', transform: 'translateY(-50%)' }}
            hoverStyle={{ background: 'rgba(255,255,255,.18)' }}
          >
            <Icon name="chevron-right" size={26} stroke="#fff" />
          </Btn>
        </>
      ) : null}

      <img
        src={current.url}
        alt={current.alt ?? ''}
        referrerPolicy="no-referrer"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 10, boxShadow: '0 20px 60px -20px rgba(0,0,0,.7)' }}
      />

      <div
        style={{
          position: 'fixed',
          bottom: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          color: 'rgba(255,255,255,.85)',
          fontSize: 13,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {count > 1 ? <span data-testid="lightbox-counter">{index + 1} / {count}</span> : null}
        <a
          href={current.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'rgba(255,255,255,.85)' }}
        >
          <Icon name="link" size={14} stroke="currentColor" /> Open original
        </a>
      </div>
    </div>
  );
}

const cornerBtn = {
  position: 'fixed',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 42,
  height: 42,
  border: 'none',
  borderRadius: 999,
  background: 'rgba(255,255,255,.1)',
  cursor: 'pointer',
  zIndex: 1,
} as const;
