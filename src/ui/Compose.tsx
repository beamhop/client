import { useState, type ReactNode } from "react";
import { useStore } from "../state/store.tsx";
import { buildNote } from "../nostr/events.ts";
import type { Note } from "../nostr/types.ts";
import { displayName, initials } from "../lib/format.ts";
import { Modal, Avatar, PrimaryButton } from "./primitives.tsx";
import { CloseIcon, ImageIcon } from "./icons.tsx";

export const Compose = ({ onClose, replyTo }: { onClose: () => void; replyTo?: Note }): ReactNode => {
  const { state, publish, toast, writeRelayUrls, navigate } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const me = state.me;
  const pubkey = state.identity?.pubkey ?? "";
  const name = me ? displayName({ name: me.name, displayName: me.displayName, pubkey }) : "You";

  const post = async (): Promise<void> => {
    const content = text.trim();
    if (!content) return;
    setBusy(true);
    try {
      await publish(buildNote(content, replyTo));
      toast(`Published to ${writeRelayUrls.length} relays`, "check");
      setText("");
      onClose();
      navigate("home");
    } catch {
      toast("Could not publish — check your relays", "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={560}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 16 }}>New post</span>
        <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "flex" }}>
          <CloseIcon size={20} />
        </button>
      </div>
      <div style={{ display: "flex", gap: 12, padding: 18 }}>
        <Avatar pubkey={pubkey} size={44} name={name} picture={me?.picture} />
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's happening on the network?"
          rows={5}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            resize: "none",
            background: "transparent",
            color: "var(--text)",
            fontSize: 17,
            lineHeight: 1.6,
            fontFamily: "inherit",
          }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderTop: "1px solid var(--hairline)" }}>
        <button
          type="button"
          onClick={() => toast("Paste an image URL into your post to embed it", "info")}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", display: "flex" }}
        >
          <ImageIcon size={20} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12.5, color: text.length > 280 ? "var(--warn)" : "var(--text-3)", fontFamily: "'JetBrains Mono',monospace" }}>
            {text.length}
          </span>
          <PrimaryButton onClick={() => void post()} disabled={!text.trim() || busy}>
            {busy ? "Publishing…" : "Post"}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
};

export const meInitials = (name: string): string => initials(name);
