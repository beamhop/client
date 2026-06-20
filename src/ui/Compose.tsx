import { useState, type ReactNode } from "react";
import { useStore } from "../state/store.tsx";
import { buildNote } from "../nostr/events.ts";
import type { Note } from "../nostr/types.ts";
import { displayName, initials, avatarStyle } from "../lib/format.ts";

/** Compose modal — faithful to the design (verity-glass.html 1536-1561). */
export const Compose = ({ onClose, replyTo }: { onClose: () => void; replyTo?: Note }): ReactNode => {
  const { state, publish, toast, writeRelayUrls, navigate } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const me = state.me;
  const pubkey = state.identity?.pubkey ?? "";
  const name = me ? displayName({ name: me.name, displayName: me.displayName, pubkey }) : "You";

  const post = async (): Promise<void> => {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await publish(buildNote(content, replyTo));
      toast(`Published to ${writeRelayUrls.length} relays`, "check");
      setText("");
      onClose();
      if (!replyTo) navigate("home");
    } catch {
      toast("Could not publish — check your relays", "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="modal-compose"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(10,10,25,.4)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "60px 18px", animation: "verity-fade .2s" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 560, background: "var(--glass-strong)", border: "1px solid var(--glass-border)", borderRadius: 16, boxShadow: "var(--glass-shadow-lg)", overflow: "hidden", animation: "verity-scale .24s cubic-bezier(.2,.9,.3,1)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--hairline)" }}>
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 17 }}>{replyTo ? "Reply" : "New post"}</span>
          <button data-testid="compose-close" type="button" onClick={onClose} style={{ display: "flex", padding: 7, border: "none", borderRadius: 10, background: "transparent", color: "var(--text-2)", cursor: "pointer" }}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", gap: 13 }}>
            <span style={avatarStyle(pubkey, 44, me?.picture)}>{!me?.picture && initials(name)}</span>
            <textarea
              data-testid="compose-input-modal"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void post();
                }
              }}
              placeholder={replyTo ? "Write your reply…" : "Share something with your workspace…"}
              style={{ flex: 1, border: "none", background: "transparent", resize: "none", outline: "none", fontSize: 19, lineHeight: 1.5, color: "var(--text)", minHeight: 130, fontFamily: "inherit" }}
            />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderTop: "1px solid var(--hairline)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 10, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 12.5, fontWeight: 600 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M2 12h20M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" /></svg>
            Public · {writeRelayUrls.length} relays
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 13, color: text.length > 280 ? "var(--warn)" : "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{text.length}</span>
          <button
            data-testid="post-submit"
            type="button"
            onClick={() => void post()}
            disabled={!text.trim() || busy}
            style={
              !text.trim() || busy
                ? { padding: "9px 18px", border: "1px solid var(--glass-border)", borderRadius: 10, background: "var(--glass-2)", color: "var(--text-3)", fontWeight: 700, fontSize: 14, fontFamily: "inherit", cursor: "default", transition: "transform .12s" }
                : { padding: "9px 18px", border: "1px solid rgba(255,255,255,.3)", borderRadius: 10, background: "var(--accent)", color: "var(--on-accent)", fontWeight: 700, fontSize: 14, fontFamily: "inherit", cursor: "pointer", transition: "transform .12s" }
            }
          >
            {busy ? "Posting…" : replyTo ? "Reply" : "Post"}
          </button>
        </div>
      </div>
    </div>
  );
};
