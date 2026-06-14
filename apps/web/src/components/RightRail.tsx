import { useMemo, type ReactNode } from 'react';
import { useApp } from '../store/AppContext.js';
import { Avatar, Btn, ProfileLink, personView } from './common.js';
import { Icon, Verified } from './Icon.js';

export function RightRail(): ReactNode {
  const { state, engine, setView, toast, viewProfile, openPalette } = useApp();

  const suggestions = useMemo(() => {
    return Object.keys(state.profiles)
      .filter((pk) => pk !== state.pubkey && !state.follows.includes(pk))
      .slice(0, 4)
      .map((pk) => personView(pk, state.profiles[pk]));
  }, [state.profiles, state.pubkey, state.follows]);

  return (
    <aside style={{ width: 316, flexShrink: 0, borderLeft: '1px solid var(--border)', height: '100vh', overflowY: 'auto', padding: '20px 18px 60px' }}>
      <div
        data-testid="rail-search"
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 13, marginBottom: 18, cursor: 'pointer' }}
        onClick={openPalette}
      >
        <Icon name="search" size={17} stroke="var(--text-3)" />
        <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-3)' }}>Search people & posts</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', background: 'var(--surface-3)', padding: '3px 7px', borderRadius: 6, fontFamily: "'JetBrains Mono',monospace" }}>⌘K</span>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, padding: 6, marginBottom: 16, boxShadow: 'var(--shadow)' }}>
        <h3 style={{ margin: 0, padding: '14px 14px 10px', fontFamily: "'Space Grotesk',sans-serif", fontSize: 15.5, fontWeight: 700 }}>Curate your feed</h3>
        {suggestions.length === 0 ? (
          <p style={{ padding: '0 14px 14px', margin: 0, fontSize: 13, color: 'var(--text-3)' }}>Discover people in Explore to grow your feed.</p>
        ) : (
          suggestions.map((s) => (
            <div key={s.pubkey} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 12px' }}>
              <ProfileLink onActivate={() => viewProfile(s.pubkey)} label={`View ${s.name}'s profile`}>
                <Avatar pubkey={s.pubkey} profile={s.profile} name={s.name} size={40} />
              </ProfileLink>
              <ProfileLink onActivate={() => viewProfile(s.pubkey)} label={`View ${s.name}'s profile`} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  {s.verified ? <Verified size={13} /> : null}
                </div>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.handle}</span>
              </ProfileLink>
              <Btn
                onClick={() => {
                  void engine.follow(s.pubkey);
                  toast(`Following ${s.name}`, 'check');
                }}
                style={{ padding: '8px 16px', borderRadius: 999, fontWeight: 700, fontSize: 13, cursor: 'pointer', background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }}
                activeStyle={{ transform: 'scale(.95)' }}
              >
                Follow
              </Btn>
            </div>
          ))
        )}
      </div>

      <div style={{ background: 'linear-gradient(150deg,var(--accent-soft),var(--surface))', border: '1px solid var(--border)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Icon name="shield" size={18} stroke="var(--accent)" />
          <h3 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700 }}>Org security</h3>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>
          Your identity is self-custodied and all direct messages are end-to-end encrypted with NIP-44.
        </p>
        <Btn
          onClick={() => setView('security')}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 13px', border: '1px solid var(--border)', borderRadius: 11, background: 'var(--surface)', color: 'var(--text)', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
          hoverStyle={{ background: 'var(--surface-2)' }}
        >
          Review keys & audit log
          <Icon name="chevron-right" size={15} stroke="var(--text-3)" strokeWidth={2.2} />
        </Btn>
      </div>
    </aside>
  );
}
