import { useState, type ReactNode } from "react";
import { useStore } from "../state/store.tsx";
import {
  createLocalIdentity,
  importSecret,
  connectNip07,
  hasNip07,
  npubOf,
  nsecOf,
  type Identity,
} from "../nostr/keys.ts";
import { Logo, KeyIcon, ShieldIcon, CopyIcon } from "./icons.tsx";
import { PrimaryButton, GhostButton, glass } from "./primitives.tsx";

/** First-run gate: generate a key, import an nsec, or connect a NIP-07 signer. */
export const Onboarding = (): ReactNode => {
  const { setIdentity, toast } = useStore();
  const [mode, setMode] = useState<"choose" | "import" | "created">("choose");
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<Identity | null>(null);
  const [error, setError] = useState("");

  const generate = (): void => {
    const id = createLocalIdentity();
    setCreated(id);
    setMode("created");
  };

  const finishCreated = (): void => {
    if (created) {
      setIdentity(created);
      toast("Welcome to Verity", "check");
    }
  };

  const doImport = (): void => {
    try {
      const id = importSecret(secret);
      setIdentity(id);
      toast("Key imported", "check");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid key");
    }
  };

  const connectSigner = async (): Promise<void> => {
    try {
      const id = await connectNip07();
      setIdentity(id);
      toast("Signer connected · NIP-07", "check");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect signer");
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg-base)",
        color: "var(--text)",
        fontFamily: "'Hanken Grotesk',sans-serif",
      }}
    >
      <div style={{ ...glass, width: "100%", maxWidth: 460, padding: 32 }} className="verity-slideup">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <Logo size={40} />
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-.02em" }}>
            Verity
          </span>
        </div>
        <p style={{ color: "var(--text-2)", fontSize: 15, lineHeight: 1.6, margin: "0 0 24px" }}>
          A Nostr client where identity is signed and clear — with first-class{" "}
          <strong style={{ color: "var(--text)" }}>Documentations</strong>.
        </p>

        {mode === "choose" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <PrimaryButton onClick={generate} style={{ padding: "14px" }}>
              <KeyIcon size={18} /> Create a new identity
            </PrimaryButton>
            <GhostButton onClick={() => setMode("import")} style={{ padding: "13px" }}>
              Import an existing nsec
            </GhostButton>
            {hasNip07() && (
              <GhostButton onClick={() => void connectSigner()} style={{ padding: "13px" }}>
                <ShieldIcon size={17} /> Connect signer extension (NIP-07)
              </GhostButton>
            )}
            {error && <p style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>{error}</p>}
          </div>
        )}

        {mode === "import" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <textarea
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setError("");
              }}
              placeholder="nsec1… or 64-char hex secret"
              rows={3}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid var(--glass-border)",
                background: "var(--glass-2)",
                color: "var(--text)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 13,
                resize: "none",
              }}
            />
            {error && <p style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>{error}</p>}
            <div style={{ display: "flex", gap: 10 }}>
              <GhostButton onClick={() => setMode("choose")} style={{ flex: 1 }}>
                Back
              </GhostButton>
              <PrimaryButton onClick={doImport} disabled={!secret.trim()} style={{ flex: 1 }}>
                Import
              </PrimaryButton>
            </div>
          </div>
        )}

        {mode === "created" && created && created.kind === "local" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <KeyField label="Public key (npub)" value={npubOf(created.pubkey)} toast={toast} />
            <KeyField label="Secret key (nsec) — back this up now" value={nsecOf(created.secretKey)} toast={toast} danger />
            <p style={{ color: "var(--text-3)", fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>
              Your secret key is stored only in this browser. Copy it somewhere safe — it is the only way
              to recover this identity.
            </p>
            <PrimaryButton onClick={finishCreated} style={{ padding: "13px" }}>
              I've saved it — enter Verity
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
};

const KeyField = ({
  label,
  value,
  toast,
  danger,
}: {
  label: string;
  value: string;
  toast: (t: string, tone?: "copy") => void;
  danger?: boolean;
}): ReactNode => (
  <div>
    <div style={{ fontSize: 12, fontWeight: 700, color: danger ? "var(--danger)" : "var(--text-3)", marginBottom: 6 }}>
      {label}
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--glass-border)",
        background: "var(--glass-2)",
      }}
    >
      <span
        style={{
          flex: 1,
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 12,
          color: "var(--text-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          toast("Copied to clipboard", "copy");
        }}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "flex" }}
      >
        <CopyIcon size={16} />
      </button>
    </div>
  </div>
);
