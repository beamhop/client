import { useEffect, useState, type ReactNode } from "react";
import { useStore, useProfile } from "../state/store.tsx";
import { Kind } from "../nostr/types.ts";
import { decodeNote } from "../nostr/events.ts";
import { displayName, initials, avatarStyle } from "../lib/format.ts";
import { shortNpub } from "../nostr/keys.ts";
import { followStyle, avatarWrap } from "./styles.ts";
import { VerifiedSeal } from "./icons.tsx";

/** Right rail: ⌘K search trigger, "Curate your feed" suggestions, "Org security" card. */
export const RightRail = ({ onOpenPalette }: { onOpenPalette: () => void }): ReactNode => {
  const { client, readRelayUrls, state, navigate } = useStore();
  const [suggested, setSuggested] = useState<string[]>([]);

  // Suggestions: distinct recent authors the user does not yet follow.
  useEffect(() => {
    if (readRelayUrls.length === 0) return;
    let cancelled = false;
    void (async () => {
      const events = await client.list(readRelayUrls, { kinds: [Kind.Note], limit: 60 });
      if (cancelled) return;
      const me = state.identity?.pubkey;
      const seen = new Set<string>();
      const picks: string[] = [];
      for (const ev of events) {
        const { pubkey } = decodeNote(ev);
        if (pubkey === me || state.contacts.includes(pubkey) || seen.has(pubkey)) continue;
        seen.add(pubkey);
        picks.push(pubkey);
        if (picks.length >= 4) break;
      }
      setSuggested(picks);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, readRelayUrls, state.identity?.pubkey]);

  const nip05Domain = state.me?.nip05?.split("@")[1];

  return (
    <aside
      data-testid="right-rail"
      style={{ width: 300, flexShrink: 0, borderLeft: "1px solid var(--hairline)", height: "var(--app-h)", overflowY: "auto", padding: "20px 18px 60px" }}
    >
      <div
        data-testid="right-search"
        onClick={onOpenPalette}
        style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 14px", background: "var(--glass)", border: "1px solid var(--glass-border)", borderRadius: 10, marginBottom: 18, cursor: "pointer" }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
        <span style={{ fontSize: 13.5, color: "var(--text-3)", flex: 1 }}>Search people & posts</span>
        <span style={{ fontSize: 11, color: "var(--text-3)", background: "var(--glass-2)", padding: "3px 7px", borderRadius: 6, fontFamily: "'JetBrains Mono',monospace" }}>⌘K</span>
      </div>

      <div data-testid="curate-card" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", borderRadius: 12, padding: 6, marginBottom: 16, boxShadow: "var(--glass-shadow)" }}>
        <h3 style={{ margin: 0, padding: "14px 14px 10px", fontFamily: "'Space Grotesk',sans-serif", fontSize: 15.5, fontWeight: 700 }}>Curate your feed</h3>
        {suggested.length === 0 ? (
          <div style={{ padding: "4px 14px 14px", fontSize: 12.5, color: "var(--text-3)" }}>Looking for people to follow…</div>
        ) : (
          suggested.map((pk) => <Suggestion key={pk} pubkey={pk} />)
        )}
      </div>

      <div data-testid="org-security" style={{ position: "relative", overflow: "hidden", background: "linear-gradient(150deg,var(--accent-soft),var(--glass))", border: "1px solid var(--glass-border)", borderRadius: 12, padding: 18, boxShadow: "var(--glass-shadow)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-3.5 8-9.5V5l-8-3-8 3v7.5C4 18.5 12 22 12 22z" /><path d="m9 12 2 2 4-4" /></svg>
          <h3 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700 }}>Org security</h3>
        </div>
        <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--text-2)" }}>
          {nip05Domain ? (
            <>
              Your identity is verified on{" "}
              <strong style={{ color: "var(--text)", fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5 }}>{nip05Domain}</strong> and all messages are end-to-end encrypted.
            </>
          ) : (
            <>Your keys live in this browser and all direct messages are end-to-end encrypted.</>
          )}
        </p>
        <button
          data-testid="review-keys-button"
          onClick={() => navigate("security")}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "10px 13px", border: "1px solid var(--glass-border)", borderRadius: 9, background: "var(--glass)", color: "var(--text)", fontWeight: 600, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
        >
          Review keys & audit log
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.2" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </aside>
  );
};

const Suggestion = ({ pubkey }: { pubkey: string }): ReactNode => {
  const { state, toggleFollow, navigate } = useStore();
  const profile = useProfile(pubkey);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey });
  const following = state.contacts.includes(pubkey);
  const open = () => navigate("profile", { pubkey });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 12px" }}>
      <span style={avatarWrap(40, true)} onClick={open}>
        <span style={avatarStyle(pubkey, 40, profile?.picture)}>{!profile?.picture && initials(name)}</span>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span onClick={open} style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}>{name}</span>
          {profile?.nip05 && <VerifiedSeal size={13} />}
        </div>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile?.nip05 ?? shortNpub(pubkey)}</span>
      </div>
      <button data-testid="follow-button" onClick={() => void toggleFollow(pubkey)} style={followStyle(following)}>
        {following ? "Following" : "Follow"}
      </button>
    </div>
  );
};
