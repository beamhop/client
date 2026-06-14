import { useEffect, useState, type ReactNode } from 'react';
import type { NostrEvent } from '@beamhop/core';
import { useApp } from '../store/AppContext.js';
import { Btn } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { PostCard } from '../components/PostCard.js';

export function NoteDetail(): ReactNode {
  const { engine, noteTarget, setView } = useApp();
  const [root, setRoot] = useState<NostrEvent | null>(null);
  const [replies, setReplies] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!noteTarget) return;
    let cancelled = false;
    setLoading(true);
    setRoot(null);
    setReplies([]);
    void engine.fetchThread(noteTarget).then((thread) => {
      if (cancelled) return;
      setRoot(thread.root);
      setReplies(thread.replies);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [noteTarget, engine]);

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else setView('home');
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '18px 18px 120px' }}>
      <Btn
        onClick={goBack}
        data-testid="note-back"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginBottom: 14,
          padding: '7px 12px',
          border: '1px solid var(--border)',
          borderRadius: 999,
          background: 'var(--surface)',
          color: 'var(--text-2)',
          fontWeight: 600,
          fontSize: 13.5,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
        hoverStyle={{ background: 'var(--surface-2)' }}
      >
        <Icon name="chevron-left" size={18} strokeWidth={2.2} />
        Back
      </Btn>

      {loading ? (
        <div data-testid="note-loading" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-3)' }}>
          <div
            style={{
              width: 26,
              height: 26,
              margin: '0 auto 14px',
              border: '3px solid var(--border-2)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          Loading thread…
        </div>
      ) : root ? (
        <>
          <PostCard note={root} openable={false} focused />
          {replies.length > 0 ? (
            <h3 style={{ margin: '8px 0 12px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700 }}>
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </h3>
          ) : null}
          {replies.map((r) => (
            <PostCard key={r.id} note={r} />
          ))}
        </>
      ) : (
        <p data-testid="note-missing" style={{ color: 'var(--text-3)', fontSize: 14, textAlign: 'center', padding: '40px 0' }}>
          This post could not be found on your relays.
        </p>
      )}
    </div>
  );
}
