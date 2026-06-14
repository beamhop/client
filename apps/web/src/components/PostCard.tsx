import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { NostrEvent } from '@beamhop/core';
import { useApp } from '../store/AppContext.js';
import { routeToHash } from '../lib/router.js';
import { Avatar, Btn, ProfileLink, personView } from './common.js';
import { Icon, Verified } from './Icon.js';
import { formatCount, timeAgo } from '../lib/ui.js';
import { renderTokens } from '../lib/content.js';
import { parseImeta, parseContent, contentWarning } from '../lib/media.js';
import { PostMedia } from './PostMedia.js';
import { ConfirmDialog } from './ConfirmDialog.js';

function actionStyle(active: boolean, color: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 10px',
    borderRadius: 10,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    color: active ? color : 'var(--text-3)',
  };
}

export interface PostCardProps {
  note: NostrEvent;
  repostedBy?: string | undefined;
  showActions?: boolean;
  focused?: boolean;
  /** When true (default), clicking the post body opens its thread. */
  openable?: boolean;
}

export function PostCard({ note, repostedBy, showActions = true, focused = false, openable = true }: PostCardProps): ReactNode {
  const app = useApp();
  const { state, engine, startReply, toast, viewProfile, openNote } = app;
  const author = personView(note.pubkey, state.profiles[note.pubkey]);
  const counts = state.engagement[note.id] ?? { likes: 0, reposts: 0, replies: 0 };
  const liked = state.liked.includes(note.id);
  const reposted = state.reposted.includes(note.id);
  const bookmarked = state.bookmarked.includes(note.id);
  const reposterName = repostedBy ? personView(repostedBy, state.profiles[repostedBy]).name : null;
  const isMine = note.pubkey === state.pubkey;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Parse content once into an inline token flow + ordered media blocks (NIP-92).
  const parsed = useMemo(() => parseContent(note.content, parseImeta(note.tags)), [note.content, note.tags]);
  const sensitive = useMemo(() => contentWarning(note.tags), [note.tags]);

  // A deleted note vanishes from every surface (feed, profile, search, thread).
  if (state.deleted.includes(note.id)) return null;

  const onDelete = () => {
    setConfirmingDelete(false);
    void engine
      .deletePost(note)
      .then(() => toast('Post deleted', 'check'))
      .catch((err) => toast(err instanceof Error ? err.message : 'Failed to delete', 'warn'));
  };

  const onRepost = () => {
    void engine.repost(note);
    if (!reposted) toast('Reposted to your followers', 'repost');
  };
  const onBookmark = () => {
    void engine.toggleBookmark(note).then((isOn) => toast(isOn ? 'Saved to bookmarks' : 'Removed from bookmarks', isOn ? 'check' : 'info'));
  };
  const onShare = () => {
    // A shareable web link that re-opens this post via hash routing on load.
    const { origin, pathname } = window.location;
    const link = `${origin}${pathname}${routeToHash({ name: 'note', id: note.id })}`;
    try {
      void navigator.clipboard?.writeText(link);
    } catch {
      // ignore clipboard failures
    }
    toast('Post link copied to clipboard', 'copy');
  };

  return (
    <article
      data-testid="post"
      data-note-id={note.id}
      data-focused={focused ? 'true' : undefined}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 18,
        padding: 18,
        boxShadow: focused ? '0 0 0 3px var(--accent-soft), var(--shadow)' : 'var(--shadow)',
        marginBottom: 14,
        scrollMarginTop: 80,
        transition: 'border-color .15s, box-shadow .15s',
      }}
    >
      {reposterName ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--text-3)',
            marginBottom: 11,
            textTransform: 'uppercase',
            letterSpacing: '.04em',
          }}
        >
          <Icon name="repost" size={13} stroke="var(--text-3)" />
          Reposted by {reposterName}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 13 }}>
        <ProfileLink onActivate={() => viewProfile(note.pubkey)} label={`View ${author.name}'s profile`} testId="post-avatar">
          <Avatar pubkey={author.pubkey} profile={author.profile} name={author.name} size={46} />
        </ProfileLink>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <ProfileLink
              onActivate={() => viewProfile(note.pubkey)}
              label={`View ${author.name}'s profile`}
              testId="post-author"
              style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}
            >
              {author.name}
            </ProfileLink>
            {author.verified ? <Verified size={15} /> : null}
            <span style={{ fontSize: 13.5, color: 'var(--text-3)', fontFamily: "'JetBrains Mono',monospace" }}>
              {author.handle}
            </span>
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>· {timeAgo(note.created_at)}</span>
          </div>
          {parsed.tokens.length > 0 ? (
            <p
              data-testid="post-content"
              onClick={
                openable
                  ? (e) => {
                      // Let embedded URL links handle their own clicks.
                      if ((e.target as HTMLElement).closest('a')) return;
                      openNote(note.id);
                    }
                  : undefined
              }
              style={{
                margin: '7px 0 0',
                fontSize: 15.5,
                lineHeight: 1.55,
                color: 'var(--text)',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                cursor: openable ? 'pointer' : 'default',
              }}
            >
              {renderTokens(parsed.tokens, (pk) => state.profiles[pk])}
            </p>
          ) : null}

          {parsed.media.length > 0 ? <PostMedia media={parsed.media} sensitive={sensitive} /> : null}

          {showActions ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 12, marginLeft: -6 }}>
              <Btn
                onClick={() => startReply(note)}
                data-testid="action-reply"
                style={actionStyle(false, 'var(--accent)')}
                hoverStyle={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                <Icon name="reply" size={17} />
                <span>{formatCount(counts.replies)}</span>
              </Btn>
              <Btn
                onClick={onRepost}
                data-testid="action-repost"
                style={actionStyle(reposted, 'var(--success)')}
                hoverStyle={{ background: 'var(--success-soft)', color: 'var(--success)' }}
              >
                <Icon name="repost" size={17} />
                <span>{formatCount(counts.reposts)}</span>
              </Btn>
              <Btn
                onClick={() => void engine.like(note)}
                data-testid="action-like"
                style={actionStyle(liked, 'var(--danger)')}
                hoverStyle={{ background: 'rgba(239,67,101,.1)', color: 'var(--danger)' }}
              >
                <Icon name="heart" size={17} fill={liked ? 'var(--danger)' : 'none'} />
                <span>{formatCount(counts.likes)}</span>
              </Btn>
              <div style={{ flex: 1 }} />
              <Btn
                onClick={onBookmark}
                data-testid="action-bookmark"
                style={actionStyle(bookmarked, 'var(--accent)')}
                hoverStyle={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                <Icon name="bookmark" size={17} fill={bookmarked ? 'var(--accent)' : 'none'} />
              </Btn>
              <Btn
                onClick={onShare}
                data-testid="action-share"
                style={actionStyle(false, 'var(--accent)')}
                hoverStyle={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                <Icon name="share" size={17} />
              </Btn>
              {isMine ? (
                <Btn
                  onClick={() => setConfirmingDelete(true)}
                  data-testid="action-delete"
                  aria-label="Delete post"
                  style={actionStyle(false, 'var(--danger)')}
                  hoverStyle={{ background: 'rgba(239,67,101,.1)', color: 'var(--danger)' }}
                >
                  <Icon name="trash" size={17} />
                </Btn>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {confirmingDelete ? (
        <ConfirmDialog
          title="Delete post?"
          message="This asks your relays to remove the post. Most clients will hide it, but deletion across the network can't be guaranteed."
          confirmLabel="Delete"
          danger
          onConfirm={onDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </article>
  );
}
