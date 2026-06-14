import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Conversation } from '../engine/types.js';
import { useApp } from '../store/AppContext.js';
import { navigateTo } from '../lib/router.js';
import { Avatar, Btn, ProfileLink, personView } from '../components/common.js';
import { Icon, Verified } from '../components/Icon.js';
import { clockTime } from '../lib/ui.js';

function ConversationRow({ conv, active }: { conv: Conversation; active: boolean }): ReactNode {
  const { state, selectConversation } = useApp();
  const person = personView(conv.peer, state.profiles[conv.peer]);
  const last = conv.messages[conv.messages.length - 1];
  const preview = last ? `${last.from === state.pubkey ? 'You: ' : ''}${last.content}` : 'No messages yet';
  return (
    <Btn
      onClick={() => selectConversation(conv.peer)}
      data-testid="conversation-row"
      data-peer={conv.peer}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 14,
        cursor: 'pointer',
        background: active ? 'var(--accent-soft)' : 'transparent',
        width: '100%',
      }}
      hoverStyle={active ? {} : { background: 'var(--surface-2)' }}
    >
      <Avatar pubkey={person.pubkey} profile={person.profile} name={person.name} size={46} />
      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {person.name}
          </span>
          {person.verified ? <Verified size={13} /> : null}
        </div>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preview}
        </span>
      </div>
      {conv.unread > 0 ? (
        <span
          style={{
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {conv.unread}
        </span>
      ) : null}
    </Btn>
  );
}

function Thread({ conv }: { conv: Conversation }): ReactNode {
  const { state, isMobile, setMobileThreadOpen, dmText, setDmText, engine, toast, viewProfile } = useApp();
  const person = personView(conv.peer, state.profiles[conv.peer]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conv.messages.length]);

  // Keep the open conversation marked as read as new messages arrive.
  useEffect(() => {
    engine.markConversationRead(conv.peer);
  }, [engine, conv.peer, conv.messages.length]);

  const send = () => {
    const text = dmText.trim();
    if (!text) return;
    setDmText('');
    void engine.sendDirectMessage(conv.peer, text).catch((err) => {
      toast(err instanceof Error ? err.message : 'Failed to send', 'warn');
    });
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        {isMobile ? (
          <Btn onClick={() => setMobileThreadOpen(false)} style={{ display: 'flex', padding: 6, border: 'none', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer' }}>
            <Icon name="chevron-left" size={22} strokeWidth={2.2} />
          </Btn>
        ) : null}
        <ProfileLink onActivate={() => viewProfile(conv.peer)} label={`View ${person.name}'s profile`}>
          <Avatar pubkey={person.pubkey} profile={person.profile} name={person.name} size={40} />
        </ProfileLink>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <ProfileLink onActivate={() => viewProfile(conv.peer)} label={`View ${person.name}'s profile`} style={{ fontWeight: 700, fontSize: 15 }}>{person.name}</ProfileLink>
            {person.verified ? <Verified size={14} /> : null}
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--success)' }}>
            <Icon name="lock" size={12} strokeWidth={2.4} />
            Encrypted · NIP-44
          </span>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            alignSelf: 'center',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 11.5,
            color: 'var(--text-3)',
            background: 'var(--surface-2)',
            padding: '6px 12px',
            borderRadius: 999,
            marginBottom: 6,
            textAlign: 'center',
          }}
        >
          <Icon name="lock" size={12} />
          Messages are end-to-end encrypted. Only you and {person.name} can read them.
        </div>
        {conv.messages.map((m) => {
          const fromMe = m.from === state.pubkey;
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: fromMe ? 'flex-end' : 'flex-start' }} data-testid="dm-message">
              {/* Cap width on the wrapper (a flex item of the full-width row) so the
                  74% resolves against the thread, not the bubble's own shrink width. */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: fromMe ? 'flex-end' : 'flex-start', maxWidth: '74%', minWidth: 40 }}>
                <div
                  style={{
                    maxWidth: '100%',
                    padding: '10px 14px',
                    borderRadius: fromMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: fromMe ? 'var(--accent)' : 'var(--surface-2)',
                    color: fromMe ? '#fff' : 'var(--text)',
                    fontSize: 14.5,
                    lineHeight: 1.45,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {m.content}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 4,
                    fontSize: 10.5,
                    color: 'var(--text-3)',
                    justifyContent: fromMe ? 'flex-end' : 'flex-start',
                  }}
                >
                  {m.legacy ? (
                    <span
                      data-testid="dm-insecure"
                      title="Encrypted with an older, less secure method"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--warn)', fontWeight: 600 }}
                    >
                      <Icon name="alert" size={11} stroke="currentColor" />
                      Less secure
                    </span>
                  ) : null}
                  <span>{clockTime(m.createdAt)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <input
          data-testid="dm-input"
          value={dmText}
          onChange={(e) => setDmText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Write an encrypted message…"
          style={{
            flex: 1,
            border: '1px solid var(--border)',
            borderRadius: 13,
            background: 'var(--surface-2)',
            padding: '12px 15px',
            outline: 'none',
            fontSize: 14.5,
            color: 'var(--text)',
          }}
        />
        <Btn
          onClick={send}
          data-testid="dm-send"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            border: 'none',
            borderRadius: 13,
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          hoverStyle={{ filter: 'brightness(1.08)' }}
          activeStyle={{ transform: 'scale(.94)' }}
        >
          <Icon name="send" size={20} />
        </Btn>
      </div>
    </div>
  );
}

export function Messages(): ReactNode {
  const { state, isMobile, mobileThreadOpen, activeConvId } = useApp();

  // Default to the first conversation on desktop. Use a replace navigation so
  // this auto-selection doesn't trap the back button on `#/messages`.
  useEffect(() => {
    if (!activeConvId && state.conversations.length > 0 && !isMobile) {
      const first = state.conversations[0];
      if (first) navigateTo({ name: 'messages', peer: first.peer }, true);
    }
  }, [activeConvId, state.conversations, isMobile]);

  const activeConv: Conversation | null = useMemo(() => {
    if (!activeConvId) return null;
    const existing = state.conversations.find((c) => c.peer === activeConvId);
    return existing ?? { peer: activeConvId, messages: [], lastAt: 0, unread: 0 };
  }, [activeConvId, state.conversations]);

  const showList = !isMobile || !mobileThreadOpen;
  const showThread = !isMobile || mobileThreadOpen;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {showList ? (
        <div style={{ width: isMobile ? '100%' : 320, flexShrink: 0, borderRight: isMobile ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
            {state.conversations.length === 0 ? (
              <p style={{ color: 'var(--text-3)', fontSize: 14, padding: 12 }}>
                No conversations yet. Open Explore, pick someone, and tap the message icon to start an encrypted chat.
              </p>
            ) : (
              state.conversations.map((c) => <ConversationRow key={c.peer} conv={c} active={c.peer === activeConvId} />)
            )}
          </div>
        </div>
      ) : null}
      {showThread && activeConv ? <Thread conv={activeConv} /> : null}
      {showThread && !activeConv ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 14 }}>
          Select a conversation
        </div>
      ) : null}
    </div>
  );
}
