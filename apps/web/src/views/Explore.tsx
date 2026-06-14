import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { normalizePubkey, type NostrEvent } from '@verity/core';
import { useApp } from '../store/AppContext.js';
import type { SearchType } from '../lib/router.js';
import { Avatar, Btn, ProfileLink, personView, type PersonView } from '../components/common.js';
import { Icon, Verified, type IconName } from '../components/Icon.js';
import { PostCard } from '../components/PostCard.js';

const TOPICS = ['nostr', 'bitcoin', 'security', 'design', 'engineering'];

function followStyle(following: boolean): CSSProperties {
  const base: CSSProperties = {
    padding: '8px 18px',
    borderRadius: 999,
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  return following
    ? { ...base, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-2)' }
    : { ...base, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' };
}

function PersonRow({ person }: { person: PersonView }): ReactNode {
  const { engine, state, toast, startConversation, viewProfile } = useApp();
  const following = state.follows.includes(person.pubkey);
  const onFollow = () => {
    if (following) {
      void engine.unfollow(person.pubkey);
      toast(`Unfollowed ${person.name}`, 'info');
    } else {
      void engine.follow(person.pubkey);
      toast(`Following ${person.name}`, 'check');
    }
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '15px 16px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        boxShadow: 'var(--shadow)',
      }}
      data-testid="explore-person"
      data-pubkey={person.pubkey}
    >
      <ProfileLink onActivate={() => viewProfile(person.pubkey)} label={`View ${person.name}'s profile`}>
        <Avatar pubkey={person.pubkey} profile={person.profile} name={person.name} size={46} />
      </ProfileLink>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ProfileLink onActivate={() => viewProfile(person.pubkey)} label={`View ${person.name}'s profile`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{person.name}</span>
          {person.verified ? <Verified size={15} /> : null}
        </ProfileLink>
        <div style={{ marginTop: 2 }}>
          <span style={{ fontSize: 13, color: 'var(--text-3)', fontFamily: "'JetBrains Mono',monospace" }}>{person.handle}</span>
        </div>
        {typeof person.profile?.metadata.about === 'string' ? (
          <span style={{ display: 'block', fontSize: 13, color: 'var(--text-2)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {person.profile.metadata.about}
          </span>
        ) : null}
      </div>
      <Btn onClick={() => startConversation(person.pubkey)} data-testid="message-person" style={{ ...followStyle(true), padding: 8 }} title="Message" aria-label="message">
        <Icon name="messages" size={16} />
      </Btn>
      <Btn onClick={onFollow} data-testid="follow-button" style={followStyle(following)} activeStyle={{ transform: 'scale(.95)' }}>
        {following ? 'Following' : 'Follow'}
      </Btn>
    </div>
  );
}

interface Results {
  people: PersonView[];
  posts: NostrEvent[];
}

export function Explore(): ReactNode {
  const { state, toast, engine, exploreQuery, exploreType, setExploreSearch } = useApp();
  // `query` is the (uncommitted) input text; `exploreQuery`/`exploreType` are the
  // committed search that live in the URL (`#/explore?q=…&type=…`) and drive it.
  const [query, setQuery] = useState(exploreQuery);
  const [extra, setExtra] = useState<string[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  const network = useMemo(() => {
    const set = new Set<string>([...extra, ...state.follows, ...Object.keys(state.profiles)]);
    set.delete(state.pubkey);
    return [...set].map((pk) => personView(pk, state.profiles[pk]));
  }, [extra, state.follows, state.profiles, state.pubkey]);

  // Mirror the committed query into the input on navigation (back/forward, shared link).
  useEffect(() => {
    setQuery(exploreQuery);
  }, [exploreQuery]);

  // Run the search whenever the committed query or its scope changes. The search
  // is scoped to the active type so we only hit relays for what's being shown.
  useEffect(() => {
    const value = exploreQuery.trim();
    const token = ++searchSeq.current; // also invalidates any in-flight search
    if (!value) {
      setResults(null);
      setSearching(false);
      return;
    }

    // npub / hex → add the exact identity to the network list (scope-independent).
    try {
      const pubkey = normalizePubkey(value);
      engine.ensureProfiles([pubkey]);
      setExtra((prev) => (prev.includes(pubkey) ? prev : [pubkey, ...prev]));
      setResults(null);
      toast('Found identity — add them to your feed', 'check');
      return;
    } catch {
      // not a key — fall through to full-text search
    }

    let cancelled = false;
    setSearching(true);
    setResults({ people: [], posts: [] });
    void (async () => {
      try {
        const next: Results =
          exploreType === 'people'
            ? { people: (await engine.searchProfiles(value)).map((p) => personView(p.pubkey, p)), posts: [] }
            : { people: [], posts: await engine.searchNotes(value) };
        // Ignore results from a superseded query/scope (rapid successive searches).
        if (cancelled || token !== searchSeq.current) return;
        setResults(next);
        const empty = exploreType === 'people' ? next.people.length === 0 : next.posts.length === 0;
        if (empty) toast(`No ${exploreType} found`, 'info');
      } catch {
        if (!cancelled && token === searchSeq.current) toast('Search failed — try again', 'warn');
      } finally {
        if (!cancelled && token === searchSeq.current) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exploreQuery, exploreType, engine]);

  const searchActive = results !== null || searching;

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '18px 18px 120px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '13px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: 'var(--shadow)',
          marginBottom: 18,
        }}
      >
        <Icon name="search" size={19} stroke="var(--text-3)" />
        <input
          data-testid="explore-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setExploreSearch(query, exploreType);
          }}
          placeholder="Search posts & people, or paste an npub…"
          style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 15, color: 'var(--text)' }}
        />
        {searchActive ? (
          <Btn onClick={() => setExploreSearch('', exploreType)} aria-label="clear search" data-testid="clear-search" style={{ display: 'flex', padding: 5, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--text-3)', cursor: 'pointer' }} hoverStyle={{ background: 'var(--surface-2)' }}>
            <Icon name="x" size={16} strokeWidth={2.2} />
          </Btn>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-3)', background: 'var(--surface-2)', padding: '4px 8px', borderRadius: 7, fontFamily: "'JetBrains Mono',monospace" }}>⏎</span>
        )}
      </div>

      {searchActive ? (
        <>
          <SearchScopeFilter
            active={exploreType}
            onChange={(type) => setExploreSearch(query.trim() || exploreQuery, type)}
          />
          <SearchResults results={results} searching={searching} type={exploreType} />
        </>
      ) : (
        <>
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ margin: '0 0 12px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700 }}>Curate by topic</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
              {TOPICS.map((t) => (
                <Btn
                  key={t}
                  onClick={() => setExploreSearch(t, 'posts')}
                  data-testid={`topic-${t}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '9px 15px',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 13.5,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}
                  hoverStyle={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                >
                  # {t}
                </Btn>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700 }}>People in your network</h3>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>Following {state.follows.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {network.length === 0 ? (
              <p style={{ color: 'var(--text-3)', fontSize: 14 }}>Search by name, topic, or npub to start building your network.</p>
            ) : (
              network.map((p) => <PersonRow key={p.pubkey} person={p} />)
            )}
          </div>
        </>
      )}
    </div>
  );
}

const SCOPES: ReadonlyArray<{ type: SearchType; label: string; icon: IconName }> = [
  { type: 'posts', label: 'Posts', icon: 'home' },
  { type: 'people', label: 'People', icon: 'user' },
];

/** Segmented control that scopes the search to posts or people. */
function SearchScopeFilter({ active, onChange }: { active: SearchType; onChange: (t: SearchType) => void }): ReactNode {
  return (
    <div
      role="tablist"
      aria-label="Search scope"
      data-testid="search-scope"
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        marginBottom: 18,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}
    >
      {SCOPES.map((scope) => {
        const isActive = scope.type === active;
        return (
          <Btn
            key={scope.type}
            onClick={() => onChange(scope.type)}
            data-testid={`scope-${scope.type}`}
            aria-selected={isActive}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              padding: '9px 14px',
              border: 'none',
              borderRadius: 9,
              background: isActive ? 'var(--surface)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-3)',
              fontWeight: 700,
              fontSize: 13.5,
              fontFamily: 'inherit',
              cursor: 'pointer',
              boxShadow: isActive ? 'var(--shadow)' : 'none',
            }}
            hoverStyle={isActive ? {} : { color: 'var(--text)' }}
          >
            <Icon name={scope.icon} size={16} />
            {scope.label}
          </Btn>
        );
      })}
    </div>
  );
}

function SearchResults({ results, searching, type }: { results: Results | null; searching: boolean; type: SearchType }): ReactNode {
  const items = type === 'people' ? results?.people ?? [] : results?.posts ?? [];

  if (searching && items.length === 0) {
    return (
      <div data-testid="search-loading" style={{ textAlign: 'center', padding: '50px 0', color: 'var(--text-3)' }}>
        <div style={{ width: 24, height: 24, margin: '0 auto 12px', border: '3px solid var(--border-2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
        Searching relays…
      </div>
    );
  }

  return (
    <div data-testid="search-results">
      {items.length === 0 ? (
        <p data-testid="search-empty" style={{ color: 'var(--text-3)', fontSize: 14, textAlign: 'center', padding: '40px 0' }}>
          No {type} found.
        </p>
      ) : type === 'people' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {(items as PersonView[]).map((p) => (
            <PersonRow key={p.pubkey} person={p} />
          ))}
        </div>
      ) : (
        (items as NostrEvent[]).map((n) => <PostCard key={n.id} note={n} />)
      )}
    </div>
  );
}
