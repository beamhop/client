import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { FeedItem } from '../engine/types.js';
import { useApp } from '../store/AppContext.js';
import { Avatar, Btn, personView } from '../components/common.js';
import { Icon, Verified } from '../components/Icon.js';
import { PostCard } from '../components/PostCard.js';
import { formatCount, truncateMiddle } from '../lib/ui.js';

type Tab = 'posts' | 'replies' | 'media';

function followStyle(following: boolean): CSSProperties {
  const base: CSSProperties = {
    padding: '9px 18px',
    borderRadius: 999,
    fontWeight: 700,
    fontSize: 13.5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  return following
    ? { ...base, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-2)' }
    : { ...base, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' };
}

export function Profile(): ReactNode {
  const { state, engine, openEdit, toast, profileTarget, startConversation } = useApp();
  const viewed = profileTarget ?? state.pubkey;
  const isMe = viewed === state.pubkey;
  const person = personView(viewed, state.profiles[viewed]);
  const [tab, setTab] = useState<Tab>('posts');
  const [notes, setNotes] = useState<FeedItem[]>([]);
  const [followers, setFollowers] = useState<number | null>(null);
  const [followingCount, setFollowingCount] = useState<number | null>(isMe ? state.follows.length : null);
  const following = state.follows.includes(viewed);

  useEffect(() => {
    setTab('posts');
    setNotes([]);
    setFollowers(null);
    setFollowingCount(isMe ? state.follows.length : null);
    let cancelled = false;
    void engine.fetchUserNotes(viewed, 100).then((n) => {
      if (!cancelled) setNotes(n);
    });
    void engine.fetchFollowerCount(viewed).then((c) => {
      if (!cancelled) setFollowers(c);
    });
    if (!isMe) {
      void engine.client.fetchContacts(viewed).then((c) => {
        if (!cancelled) setFollowingCount(c.follows.length);
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewed, engine]);

  // Keep my own following count live.
  useEffect(() => {
    if (isMe) setFollowingCount(state.follows.length);
  }, [isMe, state.follows.length]);

  // When I follow/unfollow the user I'm viewing, their follower count changes.
  useEffect(() => {
    if (isMe) return;
    let cancelled = false;
    void engine.fetchFollowerCount(viewed).then((c) => {
      if (!cancelled) setFollowers(c);
    });
    return () => {
      cancelled = true;
    };
  }, [following, isMe, viewed, engine]);

  // A repost (repostedBy set) counts as a post, never a reply, regardless of the
  // reposted note's own tags.
  const isReply = (it: FeedItem) => !it.repostedBy && it.note.tags.some((t) => t[0] === 'e');
  const hasMedia = (it: FeedItem) =>
    /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)/i.test(it.note.content);

  const filtered = useMemo(() => {
    const sorted = [...notes].sort((a, b) => b.sortAt - a.sortAt);
    if (tab === 'replies') return sorted.filter(isReply);
    if (tab === 'media') return sorted.filter(hasMedia);
    return sorted.filter((it) => !isReply(it));
  }, [notes, tab]);

  const postCount = notes.filter((it) => !isReply(it)).length;
  const banner = typeof person.profile?.metadata.banner === 'string' ? person.profile.metadata.banner : undefined;
  const about = typeof person.profile?.metadata.about === 'string' ? person.profile.metadata.about : '';
  const website = typeof person.profile?.metadata.website === 'string' ? person.profile.metadata.website : '';

  const copyNpub = () => {
    try {
      void navigator.clipboard?.writeText(person.npub);
    } catch {
      // ignore
    }
    toast(isMe ? 'Your public key copied to clipboard' : 'Public key copied to clipboard', 'copy');
  };

  const onFollow = () => {
    if (following) {
      void engine.unfollow(viewed);
      toast(`Unfollowed ${person.name}`, 'info');
    } else {
      void engine.follow(viewed);
      toast(`Following ${person.name}`, 'check');
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 0 120px' }}>
      <div
        data-testid="profile-banner"
        style={{
          height: 160,
          background: banner ? `url(${banner}) center/cover` : 'linear-gradient(120deg,#6366f1,#a855f7 55%,#ec4899)',
        }}
      />
      <div style={{ padding: '0 22px' }}>
        {/* position+zIndex lifts the avatar above the banner it overlaps */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: -52, position: 'relative', zIndex: 1 }}>
          <span data-testid="profile-avatar" style={{ display: 'inline-flex' }}>
            <Avatar pubkey={viewed} profile={person.profile} name={person.name} size={104} style={{ border: '4px solid var(--surface)', boxShadow: 'var(--shadow)' }} />
          </span>
          {isMe ? (
            <Btn
              onClick={openEdit}
              data-testid="edit-profile"
              style={{ ...followStyle(true), display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}
              hoverStyle={{ background: 'var(--surface-2)' }}
              activeStyle={{ transform: 'scale(.97)' }}
            >
              <Icon name="edit" size={15} />
              Edit profile
            </Btn>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <Btn onClick={() => startConversation(viewed)} data-testid="profile-message" style={{ ...followStyle(true), display: 'flex', alignItems: 'center', gap: 7 }} hoverStyle={{ background: 'var(--surface-2)' }}>
                <Icon name="messages" size={15} />
                Message
              </Btn>
              <Btn onClick={onFollow} data-testid="profile-follow" style={followStyle(following)} activeStyle={{ transform: 'scale(.96)' }}>
                {following ? 'Following' : 'Follow'}
              </Btn>
            </div>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <h2 data-testid="profile-name" style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700, letterSpacing: '-.02em' }}>
              {person.name}
            </h2>
            {person.verified ? <Verified size={20} /> : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 13.5,
                color: person.verified ? 'var(--success)' : 'var(--text-3)',
                fontWeight: 600,
                background: person.verified ? 'var(--success-soft)' : 'var(--surface-2)',
                padding: '3px 9px',
                borderRadius: 7,
              }}
            >
              {person.verified ? <Icon name="check" size={13} strokeWidth={2.4} /> : null}
              {person.handle}
            </span>
          </div>
          {about ? <p data-testid="profile-bio" style={{ margin: '14px 0 0', fontSize: 15, lineHeight: 1.55, color: 'var(--text)' }}>{about}</p> : null}
          {website ? (
            <a href={website} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-block', margin: '8px 0 0', fontSize: 13.5, color: 'var(--accent)' }}>
              {website}
            </a>
          ) : null}
          <div style={{ display: 'flex', gap: 22, marginTop: 16 }}>
            <Stat value={followingCount === null ? '—' : formatCount(followingCount)} label="Following" />
            <Stat value={followers === null ? '—' : formatCount(followers)} label="Followers" />
            <Stat value={formatCount(postCount)} label="Posts" />
          </div>

          <Btn
            onClick={copyNpub}
            data-testid="copy-npub"
            style={{
              marginTop: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '11px 14px',
              border: '1px solid var(--border)',
              borderRadius: 12,
              background: 'var(--surface-2)',
              cursor: 'pointer',
            }}
            hoverStyle={{ borderColor: 'var(--border-2)' }}
          >
            <Icon name="link" size={16} stroke="var(--accent)" />
            <span style={{ flex: 1, textAlign: 'left', fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {truncateMiddle(person.npub, 24, 6)}
            </span>
            <Icon name="copy" size={15} stroke="var(--text-3)" />
          </Btn>
        </div>

        <div style={{ display: 'flex', gap: 24, marginTop: 22, borderBottom: '1px solid var(--border)' }}>
          {(['posts', 'replies', 'media'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              data-testid={`tab-${t}`}
              style={{
                paddingBottom: 11,
                border: 'none',
                background: 'transparent',
                borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab === t ? 'var(--text)' : 'var(--text-3)',
                fontWeight: tab === t ? 700 : 600,
                fontSize: 14,
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filtered.length === 0 ? (
            <p style={{ color: 'var(--text-3)', fontSize: 14, padding: '20px 0' }}>Nothing here yet.</p>
          ) : (
            filtered.map((it) => (
              <PostCard
                key={`${it.repostedBy ? 'r' : 'n'}-${it.note.id}`}
                note={it.note}
                repostedBy={it.repostedBy}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <span style={{ fontSize: 14, color: 'var(--text-2)' }}>
      <strong style={{ color: 'var(--text)', fontSize: 16, fontFamily: "'Space Grotesk',sans-serif" }}>{value}</strong> {label}
    </span>
  );
}
