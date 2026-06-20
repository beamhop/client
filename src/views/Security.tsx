import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useStore } from "../state/store.tsx";
import { npubOf, nsecOf, hasNip07 } from "../nostr/keys.ts";
import { normalizeRelayUrl, DEFAULT_RELAYS } from "../nostr/relays.ts";
import type { RelayInfo } from "../nostr/types.ts";
import { Card, PrimaryButton, GhostButton, Modal } from "../ui/primitives.tsx";
import {
  KeyIcon,
  ShieldIcon,
  EyeIcon,
  EyeOffIcon,
  CopyIcon,
  CheckIcon,
  CloseIcon,
  PlusIcon,
} from "../ui/icons.tsx";

const mono = "'JetBrains Mono',monospace";

const sectionLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontFamily: "'Space Grotesk',sans-serif",
  fontSize: 15,
  fontWeight: 700,
  color: "var(--text)",
};

const keyBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "11px 14px",
  borderRadius: 10,
  background: "var(--glass-2)",
  border: "1px solid var(--hairline)",
};

const monoText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: mono,
  fontSize: 12.5,
  color: "var(--text-2)",
  wordBreak: "break-all",
  lineHeight: 1.5,
};

const iconButton: CSSProperties = {
  display: "flex",
  padding: 8,
  border: "none",
  borderRadius: 10,
  background: "transparent",
  color: "var(--text-3)",
  cursor: "pointer",
  flexShrink: 0,
};

const keyActionButton: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  padding: 10,
  border: "1px solid var(--glass-border)",
  borderRadius: 9,
  background: "var(--glass)",
  color: "var(--text)",
  fontWeight: 700,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
};

const toggleButton = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  padding: "10px 14px",
  border: `1px solid ${active ? "var(--accent)" : "var(--glass-border)"}`,
  borderRadius: 9,
  background: active ? "var(--accent-soft)" : "var(--glass)",
  color: active ? "var(--accent)" : "var(--text-3)",
  fontWeight: 700,
  fontSize: 12.5,
  fontFamily: "inherit",
  cursor: "pointer",
});

export const SecurityView = (): ReactNode => {
  const { state, setRelays, toast, signOut } = useStore();
  const { identity, relays } = state;

  const [revealed, setRevealed] = useState(false);
  const [draftRelay, setDraftRelay] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const npub = useMemo(() => (identity ? npubOf(identity.pubkey) : ""), [identity]);
  const nsec = useMemo(
    () => (identity?.kind === "local" ? nsecOf(identity.secretKey) : ""),
    [identity],
  );

  // Views only render with an identity present (guaranteed by the app shell),
  // but guard anyway to keep the types honest and avoid non-null assertions.
  if (!identity) return null;

  const signerConnected = hasNip07();
  const isNip07 = identity.kind === "nip07";

  const copy = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value);
    toast(label, "copy");
  };

  const copyNsec = (): void => {
    if (!revealed) {
      toast("Reveal the key before copying", "warn");
      return;
    }
    copy(nsec, "Secret key copied");
  };

  const masked = `nsec1${"•".repeat(54)}`;

  const updateRelay = (url: string, patch: Partial<RelayInfo>): void => {
    setRelays(relays.map((r) => (r.url === url ? { ...r, ...patch } : r)));
  };

  const removeRelay = (url: string): void => {
    setRelays(relays.filter((r) => r.url !== url));
    toast("Relay removed", "info");
  };

  const addRelay = (): void => {
    const url = normalizeRelayUrl(draftRelay);
    if (url === "" || url === "wss://") {
      toast("Enter a relay URL", "warn");
      return;
    }
    if (relays.some((r) => r.url === url)) {
      toast("Relay already added", "warn");
      return;
    }
    setRelays([...relays, { url, read: true, write: true, status: "disconnected" }]);
    setDraftRelay("");
    toast("Relay added", "check");
  };

  const resetRelays = (): void => {
    setRelays(DEFAULT_RELAYS.map((r) => ({ ...r })));
    toast("Relays reset to defaults", "check");
  };

  const posture: { label: string; detail: string; ok: boolean }[] = [
    {
      label: "Local-first relays configured",
      detail: `${relays.length} relay${relays.length === 1 ? "" : "s"} active`,
      ok: relays.length > 0,
    },
    {
      label: isNip07 ? "Signer connected" : "Local key in this browser",
      detail: isNip07
        ? "Key never leaves your NIP-07 extension"
        : "Back up your nsec to recover this identity",
      ok: isNip07,
    },
    {
      label: "Key backed up",
      detail: isNip07 ? "Managed by your signer" : "Reveal and copy your nsec offline",
      ok: isNip07,
    },
  ];

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "18px 18px 120px" }}>
      {/* hero */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          padding: 20,
          borderRadius: 16,
          border: "1px solid var(--glass-border)",
          background: "linear-gradient(135deg, var(--accent-soft), var(--glass))",
          boxShadow: "var(--glass-shadow)",
          marginBottom: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              width: 52,
              height: 52,
              minWidth: 52,
              borderRadius: 12,
              background: "linear-gradient(135deg,var(--accent),var(--accent-2))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
            }}
          >
            <ShieldIcon size={26} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ ...sectionTitle, fontSize: 17 }}>Keys &amp; security</h3>
            <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--text-2)" }}>
              {isNip07
                ? "Signed by your NIP-07 extension — Verity never holds your key."
                : "Your identity is held locally in this browser. Keep your secret key safe."}
            </p>
          </div>
        </div>
      </div>

      {/* public key */}
      <Card style={{ padding: 18, marginBottom: 14 }}>
        <div style={sectionLabel}>
          <span style={{ color: "var(--accent)", display: "flex" }}>
            <KeyIcon size={17} />
          </span>
          <h3 style={sectionTitle}>Public key</h3>
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Safe to share</span>
        </div>
        <div style={keyBox}>
          <span style={monoText}>{npub}</span>
          <button
            type="button"
            onClick={() => copy(npub, "Public key copied")}
            style={iconButton}
            aria-label="Copy public key"
          >
            <CopyIcon size={16} />
          </button>
        </div>
        <p
          style={{
            margin: "8px 2px 0",
            fontSize: 11.5,
            color: "var(--text-3)",
            fontFamily: mono,
            wordBreak: "break-all",
            lineHeight: 1.5,
          }}
        >
          {identity.pubkey}
        </p>
      </Card>

      {/* secret key / signer-managed */}
      {identity.kind === "local" ? (
        <Card
          style={{
            padding: 18,
            marginBottom: 14,
            border: "1px solid color-mix(in srgb, var(--danger) 30%, var(--glass-border))",
          }}
        >
          <div style={sectionLabel}>
            <span style={{ color: "var(--danger)", display: "flex" }}>
              <KeyIcon size={17} />
            </span>
            <h3 style={sectionTitle}>Secret key</h3>
            <span style={{ fontSize: 11.5, color: "var(--danger)", fontWeight: 700 }}>
              Never share
            </span>
          </div>
          <p style={{ margin: "0 0 11px", fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
            This key <strong style={{ color: "var(--text)" }}>controls your identity</strong>. Anyone
            who sees it can post as you and read your messages. Never paste it into a site and only
            reveal it to back it up offline.
          </p>
          <div style={{ ...keyBox, marginBottom: 11 }}>
            <span
              style={{
                ...monoText,
                color: revealed ? "var(--danger)" : "var(--text-3)",
                userSelect: revealed ? "text" : "none",
              }}
            >
              {revealed ? nsec : masked}
            </span>
          </div>
          <div style={{ display: "flex", gap: 9 }}>
            <button type="button" onClick={() => setRevealed((v) => !v)} style={keyActionButton}>
              {revealed ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button type="button" onClick={copyNsec} style={keyActionButton}>
              <CopyIcon size={15} />
              Copy
            </button>
          </div>
        </Card>
      ) : (
        <Card style={{ padding: 18, marginBottom: 14 }}>
          <div style={sectionLabel}>
            <span style={{ color: "var(--accent)", display: "flex" }}>
              <ShieldIcon size={17} />
            </span>
            <h3 style={sectionTitle}>Secret key</h3>
            <span style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 700 }}>
              Signer-managed
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
            Your secret key lives inside your NIP-07 browser extension and is never exposed to
            Verity. Every event is signed by the extension, so there is nothing to reveal here.
          </p>
        </Card>
      )}

      {/* signer status */}
      <Card style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: isNip07 ? "var(--success)" : "var(--warn)",
              boxShadow: `0 0 0 4px ${isNip07 ? "var(--success)" : "var(--warn)"}22`,
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "var(--text-2)",
              textTransform: "uppercase",
              letterSpacing: ".04em",
            }}
          >
            Signer
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          {isNip07 ? "Connected · NIP-07" : "Local key in this browser"}
        </p>
        <p
          style={{
            margin: "3px 0 0",
            fontSize: 12.5,
            color: isNip07 ? "var(--success)" : "var(--text-3)",
          }}
        >
          {isNip07
            ? "Active identity is signed by your extension."
            : signerConnected
              ? "A NIP-07 extension is available but this identity uses a local key."
              : "No NIP-07 extension detected in this browser."}
        </p>
      </Card>

      {/* relays */}
      <Card style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ ...sectionLabel, justifyContent: "space-between" }}>
          <h3 style={sectionTitle}>Relays</h3>
          <GhostButton onClick={resetRelays} style={{ padding: "7px 12px", fontSize: 12.5 }}>
            Reset to defaults
          </GhostButton>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {relays.map((relay) => (
            <div
              key={relay.url}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 12px",
                borderRadius: 10,
                background: "var(--glass-2)",
                border: "1px solid var(--hairline)",
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: mono,
                  fontSize: 12.5,
                  color: "var(--text-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {relay.url}
              </span>
              <button
                type="button"
                onClick={() => updateRelay(relay.url, { read: !relay.read })}
                style={toggleButton(relay.read)}
              >
                Read
              </button>
              <button
                type="button"
                onClick={() => updateRelay(relay.url, { write: !relay.write })}
                style={toggleButton(relay.write)}
              >
                Write
              </button>
              <button
                type="button"
                onClick={() => removeRelay(relay.url)}
                style={{ ...iconButton, color: "var(--danger)" }}
                aria-label={`Remove ${relay.url}`}
              >
                <CloseIcon size={16} />
              </button>
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            addRelay();
          }}
          style={{ display: "flex", gap: 9, marginTop: 12 }}
        >
          <input
            value={draftRelay}
            onChange={(e) => setDraftRelay(e.target.value)}
            placeholder="wss://relay.example.com"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "10px 13px",
              borderRadius: 9,
              border: "1px solid var(--glass-border)",
              background: "var(--glass-2)",
              color: "var(--text)",
              fontFamily: mono,
              fontSize: 12.5,
              outline: "none",
            }}
          />
          <PrimaryButton type="submit" style={{ padding: "10px 16px" }}>
            <PlusIcon size={16} />
            Add
          </PrimaryButton>
        </form>
      </Card>

      {/* security posture */}
      <h3 style={{ ...sectionTitle, margin: "0 0 12px" }}>Security posture</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginBottom: 22 }}>
        {posture.map((item) => (
          <Card
            key={item.label}
            style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: 14 }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                minWidth: 24,
                borderRadius: 8,
                background: item.ok ? "var(--success)22" : "var(--warn)22",
                color: item.ok ? "var(--success)" : "var(--warn)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {item.ok ? <CheckIcon size={13} stroke={3} /> : <CloseIcon size={13} />}
            </span>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>
                {item.label}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-2)" }}>
                {item.detail}
              </p>
            </div>
          </Card>
        ))}
      </div>

      {/* sign out */}
      <button
        type="button"
        onClick={() => setConfirmSignOut(true)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 13,
          borderRadius: 12,
          border: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
          background: "var(--danger)14",
          color: "var(--danger)",
          fontWeight: 700,
          fontSize: 14,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        Sign out
      </button>

      {confirmSignOut && (
        <Modal onClose={() => setConfirmSignOut(false)} width={420}>
          <div style={{ padding: 22 }}>
            <h3 style={{ ...sectionTitle, fontSize: 17, marginBottom: 8 }}>Sign out?</h3>
            <p
              style={{
                margin: "0 0 18px",
                fontSize: 13.5,
                color: "var(--text-2)",
                lineHeight: 1.55,
              }}
            >
              {identity.kind === "local"
                ? "This removes your secret key from this browser. If you haven't backed up your nsec, you will lose access to this identity permanently."
                : "This disconnects your NIP-07 signer from Verity on this device."}
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <GhostButton onClick={() => setConfirmSignOut(false)}>Cancel</GhostButton>
              <PrimaryButton
                onClick={() => {
                  setConfirmSignOut(false);
                  signOut();
                }}
                style={{ background: "var(--danger)", border: "1px solid var(--danger)" }}
              >
                Sign out
              </PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
