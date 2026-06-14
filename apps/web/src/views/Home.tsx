import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../store/AppContext.js';
import { Avatar, Btn, personView } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { PostCard } from '../components/PostCard.js';
import { useComposer } from '../hooks/useComposer.js';

function postBtnStyle(enabled: boolean): CSSProperties {
  return {
    padding: '9px 22px',
    borderRadius: 999,
    border: 'none',
    background: enabled ? 'var(--accent)' : 'var(--surface-3)',
    color: enabled ? '#fff' : 'var(--text-3)',
    fontWeight: 700,
    fontSize: 14,
    fontFamily: 'inherit',
    cursor: enabled ? 'pointer' : 'default',
  };
}

function InlineComposer(): ReactNode {
  const { state } = useApp();
  const me = personView(state.pubkey, state.profiles[state.pubkey]);
  const composer = useComposer();
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 18,
        padding: 16,
        boxShadow: 'var(--shadow)',
        marginBottom: 18,
      }}
    >
      <div style={{ display: 'flex', gap: 13 }}>
        <Avatar pubkey={me.pubkey} profile={me.profile} name={me.name} size={42} />
        <textarea
          data-testid="composer-input"
          value={composer.text}
          onChange={(e) => composer.setText(e.target.value)}
          placeholder="Share something with your workspace…"
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            resize: 'none',
            outline: 'none',
            fontSize: 17,
            lineHeight: 1.5,
            color: 'var(--text)',
            minHeight: 52,
            paddingTop: 8,
          }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            borderRadius: 9,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <Icon name="globe" size={13} stroke="currentColor" strokeWidth={2.4} />
          Workspace · {state.relays.length} relays
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{composer.charCount}</span>
        <Btn
          onClick={() => void composer.submit()}
          disabled={!composer.canPost || composer.submitting}
          data-testid="composer-post"
          style={postBtnStyle(composer.canPost && !composer.submitting)}
          activeStyle={{ transform: 'scale(.96)' }}
        >
          Post
        </Btn>
      </div>
    </div>
  );
}

export function Home(): ReactNode {
  const { state, engine, startReply, viewProfile, toast, showCompose, showEdit, showRotate, showRelays, showPalette } = useApp();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const feedRef = useRef(state.feed);
  feedRef.current = state.feed;
  const gPendingRef = useRef(0);
  const blocked = showCompose || showEdit || showRotate || showRelays || showPalette;

  // Derive the focused index from the focused note id so feed prepends don't
  // silently shift the highlight onto a different post.
  const focused = focusedId ? state.feed.findIndex((it) => it.note.id === focusedId) : -1;

  useEffect(() => {
    const isEditable = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const setFocusedIndex = (updater: (i: number) => number) => {
      const feed = feedRef.current;
      const current = focusedId ? feed.findIndex((it) => it.note.id === focusedId) : -1;
      const next = updater(current);
      const item = feed[next];
      if (item) setFocusedId(item.note.id);
    };
    const handler = (e: KeyboardEvent) => {
      if (blocked || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const feed = feedRef.current;
      const key = e.key.toLowerCase();
      // Don't act on the second key of a `g …` navigation leader sequence.
      const now = Date.now();
      if (key === 'g') {
        gPendingRef.current = now;
        return;
      }
      if (gPendingRef.current && now - gPendingRef.current < 900) {
        gPendingRef.current = 0;
        return;
      }
      const current = focusedId ? feed.findIndex((it) => it.note.id === focusedId) : -1;
      if (key === 'j') {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(feed.length - 1, i + 1));
      } else if (key === 'k') {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (current >= 0 && feed[current]) {
        const note = feed[current].note;
        if (key === 'l') {
          e.preventDefault();
          void engine.like(note);
        } else if (key === 'r') {
          e.preventDefault();
          startReply(note);
        } else if (key === 'b') {
          e.preventDefault();
          void engine.toggleBookmark(note).then((on) => toast(on ? 'Saved to bookmarks' : 'Removed from bookmarks', on ? 'check' : 'info'));
        } else if (key === 'enter') {
          e.preventDefault();
          viewProfile(note.pubkey);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [blocked, focusedId, engine, startReply, viewProfile, toast]);

  useEffect(() => {
    if (focused < 0) return;
    const el = document.querySelectorAll('[data-testid="post"]')[focused];
    el?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '18px 18px 120px' }}>
      <InlineComposer />
      {state.feed.length === 0 ? (
        <EmptyOrLoading loading={state.loadingFeed} />
      ) : (
        state.feed.map((item, i) => (
          <PostCard key={`${item.note.id}-${item.repostedBy ?? ''}`} note={item.note} repostedBy={item.repostedBy} focused={i === focused} />
        ))
      )}
    </div>
  );
}

function EmptyOrLoading({ loading }: { loading: boolean }): ReactNode {
  return (
    <div
      data-testid="feed-status"
      style={{
        textAlign: 'center',
        padding: '60px 20px',
        color: 'var(--text-3)',
        fontSize: 14.5,
      }}
    >
      {loading ? (
        <>
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
          Loading your feed…
        </>
      ) : (
        'No posts yet. Follow people in Explore, or write the first note.'
      )}
    </div>
  );
}
