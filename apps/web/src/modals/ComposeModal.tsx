import { type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../store/AppContext.js';
import { Modal } from '../components/Modal.js';
import { Avatar, Btn, personView } from '../components/common.js';
import { Icon } from '../components/Icon.js';
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

export function ComposeModal(): ReactNode {
  const { state, closeCompose, replyTarget } = useApp();
  const composer = useComposer();
  const me = personView(state.pubkey, state.profiles[state.pubkey]);
  const replyAuthor = replyTarget ? personView(replyTarget.pubkey, state.profiles[replyTarget.pubkey]) : null;

  return (
    <Modal title={composer.isReply ? 'Reply' : 'New post'} onClose={closeCompose} testId="compose-modal">
      <div style={{ padding: 20 }}>
        {replyTarget && replyAuthor ? (
          <div style={{ marginBottom: 14, padding: 12, borderRadius: 12, background: 'var(--surface-2)', fontSize: 14, color: 'var(--text-2)' }}>
            <span style={{ fontWeight: 700, color: 'var(--text)' }}>{replyAuthor.name}</span>{' '}
            <span style={{ color: 'var(--text-3)' }}>{replyTarget.content.slice(0, 120)}</span>
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 13 }}>
          <Avatar pubkey={me.pubkey} profile={me.profile} name={me.name} size={42} />
          <textarea
            data-testid="compose-input"
            autoFocus
            value={composer.text}
            onChange={(e) => composer.setText(e.target.value)}
            placeholder={composer.isReply ? 'Write your reply…' : 'Share something with your workspace…'}
            style={{ flex: 1, border: 'none', background: 'transparent', resize: 'none', outline: 'none', fontSize: 19, lineHeight: 1.5, color: 'var(--text)', minHeight: 130 }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--border)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
          <Icon name="globe" size={13} strokeWidth={2.4} />
          Everyone in Aperture
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{composer.charCount}</span>
        <Btn
          onClick={() => void composer.submit()}
          data-testid="compose-submit"
          disabled={!composer.canPost || composer.submitting}
          style={postBtnStyle(composer.canPost && !composer.submitting)}
          activeStyle={{ transform: 'scale(.96)' }}
        >
          {composer.isReply ? 'Reply' : 'Post'}
        </Btn>
      </div>
    </Modal>
  );
}
