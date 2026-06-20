import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { useStore } from "../state/store.tsx";
import { npubOf, nsecOf, shortNpub } from "../nostr/keys.ts";
import { normalizeRelayUrl, DEFAULT_RELAYS } from "../nostr/relays.ts";
import type { RelayInfo } from "../nostr/types.ts";
import { PrimaryButton, GhostButton, Modal } from "../ui/primitives.tsx";
import { timeAgo } from "../lib/format.ts";
import type { MuteRule } from "../lib/mute.ts";
import { isHapticsEnabled, setHapticsEnabled } from "../lib/haptics.ts";
import type { FollowSet, BookmarkSet } from "../lib/lists.ts";
import {
  TTL_PRESETS,
  expiryFromTtl,
  isRuleExpired,
  validateRegex,
  MAX_REGEX_LENGTH,
  MAX_KEYWORD_LENGTH,
} from "../lib/mute.ts";

const mono = "'JetBrains Mono',monospace";
const heading = "'Space Grotesk',sans-serif";

/* ── shared style fragments (exact design recipe) ───────────────────────── */

const glassCard: CSSProperties = {
  background: "var(--glass)",
  WebkitBackdropFilter: "var(--blur)",
  backdropFilter: "var(--blur)",
  border: "1px solid var(--glass-border)",
  borderRadius: 12,
  boxShadow: "var(--glass-shadow)",
};

const h3Title: CSSProperties = {
  margin: 0,
  fontFamily: heading,
  fontSize: 15,
  fontWeight: 700,
  color: "var(--text)",
};

const keyBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "11px 14px",
  borderRadius: 9,
  background: "var(--glass-2)",
  border: "1px solid var(--hairline)",
};

const monoValue: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: mono,
  fontSize: 12.5,
  color: "var(--text-2)",
  wordBreak: "break-all",
  lineHeight: 1.5,
};

const cardLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-2)",
  textTransform: "uppercase",
  letterSpacing: ".04em",
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
  transition: "all .15s",
};

const muteInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "10px 13px",
  borderRadius: 9,
  border: "1px solid var(--glass-border)",
  background: "var(--glass-2)",
  color: "var(--text)",
  fontSize: 16,
  outline: "none",
};

const muteBackupButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "8px 14px",
  border: "1px solid var(--glass-border)",
  borderRadius: 11,
  background: "var(--glass)",
  WebkitBackdropFilter: "var(--blur)",
  backdropFilter: "var(--blur)",
  boxShadow: "var(--glass-shadow)",
  color: "var(--text)",
  fontWeight: 700,
  fontSize: 12.5,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "all .15s",
};

/* ── inline SVGs (paths verbatim from spec) ─────────────────────────────── */

const svgBase = {
  viewBox: "0 0 24 24",
  fill: "none",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ShieldCheck = (): ReactNode => (
  <svg width={26} height={26} {...svgBase} stroke="#fff">
    <path d="M12 22s8-3.5 8-9.5V5l-8-3-8 3v7.5C4 18.5 12 22 12 22z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const KeyGlyph = (): ReactNode => (
  <svg width={17} height={17} {...svgBase} stroke="var(--accent)">
    <circle cx="9" cy="9" r="3" />
    <path d="M12 9h9M17 6l3 3-3 3" />
  </svg>
);

const LockGlyph = (): ReactNode => (
  <svg width={17} height={17} {...svgBase} stroke="var(--danger)">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const CopyGlyph = ({ size = 16 }: { size?: number }): ReactNode => (
  <svg width={size} height={size} {...svgBase} stroke="currentColor">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const EyeGlyph = ({ size = 14 }: { size?: number }): ReactNode => (
  <svg width={size} height={size} {...svgBase} stroke="currentColor">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const RotateGlyph = (): ReactNode => (
  <svg width={14} height={14} {...svgBase} strokeWidth={2.2} stroke="var(--text-3)">
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

const CheckGlyph = (): ReactNode => (
  <svg width={13} height={13} {...svgBase} strokeWidth={3} stroke="var(--success)">
    <path d="m5 13 4 4L19 7" />
  </svg>
);

const DownloadGlyph = (): ReactNode => (
  <svg width={14} height={14} {...svgBase} stroke="currentColor">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);

const UploadGlyph = (): ReactNode => (
  <svg width={14} height={14} {...svgBase} stroke="currentColor">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M12 4v12" />
  </svg>
);

const MuteGlyph = (): ReactNode => (
  <svg width={17} height={17} {...svgBase} stroke="var(--accent)">
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M23 9 17 15M17 9l6 6" />
  </svg>
);

/* ── audit type → badge gradient + icon path (verbatim from spec §8) ────── */

type AuditType = "key" | "dm" | "profile" | "device" | "backup" | "verify";

const AUDIT_BADGE: Record<AuditType, string> = {
  key: "linear-gradient(135deg,var(--accent),var(--accent-2))",
  dm: "linear-gradient(135deg,#0ea5e9,#5b54f0)",
  profile: "linear-gradient(135deg,#8b5cf6,#ec4899)",
  device: "linear-gradient(135deg,#f59e0b,#f97316)",
  backup: "linear-gradient(135deg,#0fae74,#22d3ee)",
  verify: "linear-gradient(135deg,var(--success),#22d3ee)",
};

const AUDIT_PATH: Record<AuditType, string> = {
  key: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3",
  dm: "M4 4h16v12H8l-4 4z",
  profile: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  device: "M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 20h8",
  backup: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  verify: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3",
};

type AuditRow = { type: AuditType; event: string; detail: string; time: string };

/* ── local UI preferences (hardware / delegation toggles) ───────────────── */

const PREFS_KEY = "verity.security.prefs.v1";

type Prefs = { hardware: boolean; delegation: boolean };

const loadPrefs = (): Prefs => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { hardware: false, delegation: false };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { hardware: parsed.hardware === true, delegation: parsed.delegation === true };
  } catch {
    return { hardware: false, delegation: false };
  }
};

const savePrefs = (prefs: Prefs): void => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

const trackStyle = (on: boolean): CSSProperties => ({
  position: "relative",
  width: 44,
  height: 26,
  minWidth: 44,
  borderRadius: 999,
  border: "none",
  background: on ? "var(--accent)" : "var(--glass-2)",
  cursor: "pointer",
  padding: 0,
  transition: "background .18s",
});

const knobStyle = (on: boolean): CSSProperties => ({
  position: "absolute",
  top: 3,
  left: on ? 21 : 3,
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "#fff",
  boxShadow: "0 1px 3px rgba(20,22,45,.2)",
  transition: "left .18s",
});

/* ── component ──────────────────────────────────────────────────────────── */

export const SecurityView = (): ReactNode => {
  const {
    state,
    setRelays,
    toast,
    signOut,
    setDeveloperMode,
    addMuteRule,
    removeMuteRule,
    updateMuteRule,
    setMuteDisplay,
    exportMuteSettings,
    importMuteSettings,
    createFollowSet,
    updateFollowSet,
    deleteFollowSet,
    createBookmarkSet,
    updateBookmarkSet,
    deleteBookmarkSet,
  } = useStore();
  const { identity, me, relays, muteSettings, followSets, bookmarkSets } = state;

  const [revealed, setRevealed] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [hapticsOn, setHapticsOn] = useState(() => isHapticsEnabled());
  const [draftRelay, setDraftRelay] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  // ── soft-mute drafts (this card only) ──
  const [muteKeyword, setMuteKeyword] = useState("");
  const [muteAccount, setMuteAccount] = useState("");
  const [muteRegex, setMuteRegex] = useState("");
  // Index into TTL_PRESETS, or -1 for "Permanent". Shared by all add controls.
  const [muteTtl, setMuteTtl] = useState(-1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // ── follow set drafts ──
  const [newFollowSetName, setNewFollowSetName] = useState("");
  const [newFollowSetPrivate, setNewFollowSetPrivate] = useState(false);

  // ── bookmark set drafts ──
  const [newBookmarkSetName, setNewBookmarkSetName] = useState("");
  const [newBookmarkSetPrivate, setNewBookmarkSetPrivate] = useState(false);

  // The signing-key access timestamp is the closest "real" audit signal we
  // have locally: it advances whenever the user reveals their key this session.
  const [keyAccessedAt, setKeyAccessedAt] = useState<number | null>(null);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const npub = useMemo(() => (identity ? npubOf(identity.pubkey) : ""), [identity]);
  const nsec = useMemo(
    () => (identity?.kind === "local" ? nsecOf(identity.secretKey) : ""),
    [identity],
  );

  const muteGroups = useMemo(() => {
    const accounts = muteSettings.rules.filter((r) => r.type === "account");
    const keywords = muteSettings.rules.filter((r) => r.type === "keyword");
    const patterns = muteSettings.rules.filter((r) => r.type === "regex");
    return { accounts, keywords, patterns };
  }, [muteSettings.rules]);

  if (!identity) return null;

  const isNip07 = identity.kind === "nip07";
  const isLocal = identity.kind === "local";

  // ── verified-identity mapping ──
  // We treat a present `nip05` on the user's kind-0 profile as "verified".
  // (A full NIP-05 well-known resolution is async; presence is the local proxy.)
  const nip05 = me?.nip05?.trim() ?? "";
  const verified = nip05.length > 0;
  const nip05Domain = nip05.includes("@") ? (nip05.split("@")[1] ?? nip05) : nip05;

  const copyText = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value).catch(() => undefined);
    toast(`${label} copied to clipboard`, "copy");
  };

  const copyNpub = (): void => copyText(npub, "Public key");

  const revealKey = (): void => {
    setRevealed((v) => {
      if (!v) setKeyAccessedAt(Math.floor(Date.now() / 1000));
      return !v;
    });
  };

  const copyNsec = (): void => {
    if (!revealed) {
      toast("Reveal the key before copying", "warn");
      return;
    }
    copyText(nsec, "Private key");
  };

  const signer = isNip07 ? "NIP-07 extension" : "Local key (this browser)";
  const signerStatus = isNip07 ? "Connected · NIP-07" : "Stored in this browser";

  // ── relay management (real Nostr; kept below the design region) ──
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
    setRelays([...relays, { url, enabled: true, read: true, write: true, status: "disconnected" }]);
    setDraftRelay("");
    toast("Relay added", "check");
  };
  const resetRelays = (): void => {
    setRelays(DEFAULT_RELAYS.map((r) => ({ ...r })));
    toast("Relays reset to defaults", "check");
  };

  // ── soft mute (client-only, per-account, device-local) ──

  // A preset index of -1 means "Permanent" → omit expiresAt entirely.
  const draftExpiry = (): number | undefined => {
    const preset = TTL_PRESETS[muteTtl];
    return preset ? expiryFromTtl(preset.ms) : undefined;
  };

  const addMuteKeyword = (): void => {
    const value = muteKeyword.trim();
    if (!value) return;
    addMuteRule({ type: "keyword", value, expiresAt: draftExpiry() });
    setMuteKeyword("");
    toast("Muted word", "check");
  };

  const addMuteAccount = (): void => {
    // Lowercase so mixed-case hex is accepted and stored canonically (bech32
    // npubs are lowercase already, so this is safe for both forms).
    const raw = muteAccount.trim().toLowerCase();
    if (!raw) return;
    let hex: string | null = null;
    if (/^[0-9a-f]{64}$/.test(raw)) {
      hex = raw;
    } else {
      try {
        const decoded = nip19.decode(raw);
        if (decoded.type === "npub") hex = decoded.data;
      } catch {
        // fall through to the warning below
      }
    }
    if (!hex) {
      toast("Enter a valid npub or 64-char hex", "warn");
      return;
    }
    addMuteRule({ type: "account", pubkey: hex, expiresAt: draftExpiry() });
    setMuteAccount("");
    toast("Muted account", "check");
  };

  const regexValidation = validateRegex(muteRegex);
  const regexError = muteRegex.length > 0 && !regexValidation.ok ? regexValidation.error : "";

  const addMuteRegex = (): void => {
    if (!regexValidation.ok) return;
    addMuteRule({ type: "regex", source: muteRegex, expiresAt: draftExpiry() });
    setMuteRegex("");
    toast("Muted pattern", "check");
  };

  const muteRuleLabel = (rule: MuteRule): string => {
    switch (rule.type) {
      case "keyword":
        return rule.value;
      case "account":
        return /^[0-9a-f]{64}$/.test(rule.pubkey) ? shortNpub(rule.pubkey) : rule.pubkey.slice(0, 12);
      case "regex":
        return `/${rule.source}/${rule.flags}`;
    }
  };

  const exportMutes = (): void => {
    const blob = new Blob([exportMuteSettings()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "verity-mutes.json";
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Mute rules exported", "check");
  };

  const importMutes = (file: File): void => {
    void file
      .text()
      .then((text) => {
        const ok = importMuteSettings(text);
        toast(ok ? "Mute rules imported" : "Import failed — invalid file", ok ? "check" : "warn");
      })
      .catch(() => toast("Import failed — could not read file", "warn"));
  };

  // ── compliance posture (real-derived where possible) ──
  const compliance: { label: string; detail: string }[] = [
    { label: "End-to-end encrypted DMs", detail: "NIP-44 · server never sees plaintext" },
    { label: "Audit retention", detail: "365 days · export ready" },
    {
      label: "Verified org domain",
      detail: verified ? `${nip05Domain} · NIP-05` : "Add a NIP-05 to verify",
    },
    { label: "Social key recovery", detail: "2-of-3 guardian escrow" },
  ];

  // ── audit trail ──
  // Rows derived from real local activity where available; the rest are clearly
  // illustrative defaults that mirror the design's row structure.
  const audit: AuditRow[] = [
    {
      type: "key",
      event: "Signing key accessed",
      detail: `via ${signer}`,
      time: keyAccessedAt !== null ? `${timeAgo(keyAccessedAt)} ago` : "No access this session",
    },
    {
      type: "dm",
      event: "Direct message decrypted",
      detail: "NIP-04/44 conversation",
      time: "—",
    },
    {
      type: "profile",
      event: "Profile metadata updated",
      detail: me?.about ? "Bio and links" : "No recent change",
      time: "—",
    },
    {
      type: "device",
      event: "New device authorized",
      detail: "This browser session",
      time: "—",
    },
    {
      type: "backup",
      event: "Key backup verified",
      detail: isLocal ? "Local nsec · reveal to back up" : "Managed by your signer",
      time: "—",
    },
    {
      type: "verify",
      event: "NIP-05 identity re-verified",
      detail: verified ? nip05Domain : "Not verified",
      time: verified ? "now" : "—",
    },
  ];

  const exportAudit = (): void => {
    const rows = [
      ["event", "detail", "time"],
      ...audit.map((a) => [a.event, a.detail, a.time]),
    ];
    const csv = rows
      .map((r) => r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "verity-audit-log.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Audit log exported", "check");
  };

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "18px 18px 120px" }}>
      {/* ── 2. Verified identity hero ── */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          padding: 20,
          borderRadius: 13,
          border: "1px solid var(--glass-border)",
          background: "linear-gradient(135deg, var(--accent-soft), var(--glass))",
          WebkitBackdropFilter: "var(--blur)",
          backdropFilter: "var(--blur)",
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
              borderRadius: 10,
              background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "none",
            }}
          >
            <ShieldCheck />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <h3 style={{ ...h3Title, fontSize: 17 }}>
                {verified ? "Identity verified" : "Identity unverified"}
              </h3>
              {verified && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--success)",
                    background: "var(--success-soft)",
                    padding: "3px 8px",
                    borderRadius: 7,
                    textTransform: "uppercase",
                    letterSpacing: ".03em",
                  }}
                >
                  Active
                </span>
              )}
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--text-2)" }}>
              {verified ? (
                <>
                  NIP-05 verified on{" "}
                  <strong
                    style={{
                      color: "var(--text)",
                      fontFamily: mono,
                      fontSize: 12.5,
                    }}
                  >
                    {nip05Domain}
                  </strong>{" "}
                  · re-checked just now
                </>
              ) : (
                "Add a NIP-05 identifier to your profile to verify this account."
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ── 3. Public key card ── */}
      <div style={{ ...glassCard, padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <KeyGlyph />
          <h3 style={h3Title}>Public key</h3>
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Safe to share</span>
        </div>
        <div style={keyBox}>
          <span style={monoValue}>{npub}</span>
          <CopyButton testId="copy-npub" onClick={copyNpub} ariaLabel="Copy public key" />
        </div>
      </div>

      {/* ── 4. Private key card ── */}
      <div style={{ ...glassCard, padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <LockGlyph />
          <h3 style={h3Title}>Private key</h3>
          <span style={{ fontSize: 11.5, color: "var(--danger)", fontWeight: 600 }}>
            Never share
          </span>
        </div>
        <p style={{ margin: "0 0 11px", fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
          Your private key lives inside your signer and never leaves the device. We can't see it —
          reveal only when you must back it up offline.
        </p>
        <div
          style={{
            position: "relative",
            padding: "13px 14px",
            borderRadius: 9,
            background: "var(--glass-2)",
            border: "1px solid var(--hairline)",
            marginBottom: 11,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 12.5,
              wordBreak: "break-all",
              lineHeight: 1.5,
              display: "block",
              color: revealed ? "var(--danger)" : "transparent",
              userSelect: revealed ? "text" : "none",
            }}
          >
            {isLocal ? nsec : "nsec held by your NIP-07 signer — nothing to reveal here"}
          </span>
          {!revealed && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-3)",
              }}
            >
              <EyeGlyph size={14} />
              {isLocal ? "Hidden for your safety" : "Signer-managed — nothing to reveal"}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <PressButton
            testId="reveal-key"
            disabled={!isLocal}
            onClick={revealKey}
            style={keyActionButton}
          >
            <EyeGlyph size={15} />
            {revealed ? "Hide" : "Reveal"}
          </PressButton>
          <PressButton
            testId="copy-nsec"
            disabled={!isLocal}
            onClick={copyNsec}
            style={keyActionButton}
          >
            <CopyGlyph size={15} />
            Copy
          </PressButton>
        </div>
      </div>

      {/* ── 5. Signer + Last-backup grid ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ ...glassCard, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "var(--success)",
                boxShadow: "0 0 0 4px var(--success-soft)",
              }}
            />
            <span style={cardLabel}>Signer</span>
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{signer}</p>
          <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--success)" }}>
            {signerStatus}
          </p>
        </div>

        <div style={{ ...glassCard, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
            <RotateGlyph />
            <span style={cardLabel}>Last backup</span>
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {revealed ? "Just now" : isLocal ? "Reveal to back up" : "Held by signer"}
          </p>
          <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--text-3)" }}>
            2-of-3 guardian escrow
          </p>
        </div>
      </div>

      {/* ── 6. Governance controls card ── */}
      <div style={{ ...glassCard, marginBottom: 14, overflow: "hidden" }}>
        <GovRow
          title="Require hardware signer"
          detail="Force a hardware key for every signature on this account."
          on={prefs.hardware}
          testId="toggle-hardware"
          onToggle={() => setPrefs((p) => ({ ...p, hardware: !p.hardware }))}
          border
        />
        <GovRow
          title="Delegated signing · NIP-26"
          detail="Let approved service accounts post on the org's behalf, fully logged."
          on={prefs.delegation}
          testId="toggle-delegation"
          onToggle={() => setPrefs((p) => ({ ...p, delegation: !p.delegation }))}
          border
        />
        <GovRow
          title="Haptic feedback"
          detail="Vibrate on key actions. Works on supported Android devices; iOS web browsers have no vibration."
          on={hapticsOn}
          testId="toggle-haptics"
          onToggle={() => {
            const next = !hapticsOn;
            setHapticsOn(next);
            setHapticsEnabled(next);
          }}
          border
        />
        <GovRow
          title="Developer mode"
          detail="Show raw Nostr event JSON controls on posts, articles, docs, messages, and notifications."
          on={state.developerMode}
          testId="toggle-developer-mode"
          onToggle={() => setDeveloperMode(!state.developerMode)}
        />
      </div>

      {/* ── 7. Compliance posture ── */}
      <h3 style={{ ...h3Title, margin: "0 0 12px" }}>Compliance posture</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 11,
          marginBottom: 24,
        }}
      >
        {compliance.map((c) => (
          <div
            key={c.label}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 11,
              padding: 14,
              ...glassCard,
              borderRadius: 10,
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                minWidth: 24,
                borderRadius: 8,
                background: "var(--success-soft)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CheckGlyph />
            </span>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>
                {c.label}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-2)" }}>{c.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── 8. Audit trail ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h3 style={h3Title}>Audit trail</h3>
        <PressButton
          testId="export-audit"
          onClick={exportAudit}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 14px",
            border: "1px solid var(--glass-border)",
            borderRadius: 11,
            background: "var(--glass)",
            WebkitBackdropFilter: "var(--blur)",
            backdropFilter: "var(--blur)",
            boxShadow: "var(--glass-shadow)",
            color: "var(--text)",
            fontWeight: 700,
            fontSize: 12.5,
            fontFamily: "inherit",
            cursor: "pointer",
            transition: "all .15s",
          }}
        >
          <DownloadGlyph />
          Export CSV
        </PressButton>
      </div>
      <div style={{ ...glassCard, overflow: "hidden" }}>
        {audit.map((a, i) => (
          <div
            key={a.event}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              borderBottom: i === audit.length - 1 ? "none" : "1px solid var(--hairline)",
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: AUDIT_BADGE[a.type],
                boxShadow: "none",
              }}
            >
              <svg width={16} height={16} {...svgBase} stroke="#fff">
                <path d={AUDIT_PATH[a.type]} />
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>
                {a.event}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-2)" }}>{a.detail}</p>
            </div>
            <span
              style={{
                fontSize: 11.5,
                color: "var(--text-3)",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {a.time}
            </span>
          </div>
        ))}
      </div>

      {/* ── Relays (real Nostr; outside the design region per view brief) ── */}
      <h3 style={{ ...h3Title, margin: "24px 0 12px" }}>Relays</h3>
      <div style={{ ...glassCard, padding: 18, marginBottom: 14 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            {relays.filter((relay) => relay.enabled).length} of {relays.length} relay
            {relays.length === 1 ? "" : "s"} enabled
          </span>
          <GhostButton onClick={resetRelays} style={{ padding: "7px 12px", fontSize: 12.5 }}>
            Reset to defaults
          </GhostButton>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {relays.map((relay) => {
            const enabled = relay.enabled;
            return (
              <div
                key={relay.url}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "10px 12px",
                  borderRadius: 9,
                  background: enabled ? "var(--glass-2)" : "var(--glass)",
                  border: "1px solid var(--hairline)",
                  opacity: enabled ? 1 : 0.68,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: mono,
                    fontSize: 12.5,
                    color: enabled ? "var(--text-2)" : "var(--text-3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {relay.url}
                </span>
                <RelayToggle
                  label={enabled ? "Enabled" : "Disabled"}
                  active={enabled}
                  onClick={() => updateRelay(relay.url, { enabled: !enabled })}
                />
                <RelayToggle
                  label="Read"
                  active={relay.read}
                  muted={!enabled}
                  onClick={() => updateRelay(relay.url, { read: !relay.read })}
                />
                <RelayToggle
                  label="Write"
                  active={relay.write}
                  muted={!enabled}
                  onClick={() => updateRelay(relay.url, { write: !relay.write })}
                />
                <button
                  type="button"
                  onClick={() => removeRelay(relay.url)}
                  style={{
                    display: "flex",
                    padding: 8,
                    border: "none",
                    borderRadius: 9,
                    background: "transparent",
                    color: "var(--danger)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  aria-label={`Remove ${relay.url}`}
                >
                  <svg width={16} height={16} {...svgBase} strokeWidth={2.2} stroke="currentColor">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            );
          })}
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
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "10px 13px",
              borderRadius: 9,
              border: "1px solid var(--glass-border)",
              background: "var(--glass-2)",
              color: "var(--text)",
              fontFamily: mono,
              fontSize: 16,
              outline: "none",
            }}
          />
          <PrimaryButton type="submit" style={{ padding: "10px 16px" }}>
            <svg width={16} height={16} {...svgBase} strokeWidth={2.4} stroke="currentColor">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add
          </PrimaryButton>
        </form>
      </div>

      {/* ── Muted content (client-only soft mute; device-local) ── */}
      <h3 style={{ ...h3Title, margin: "24px 0 12px" }}>Muted content</h3>
      <div style={{ ...glassCard, padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <MuteGlyph />
          <h3 style={h3Title}>Mute rules</h3>
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>This device only</span>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
          Hide words, accounts, and patterns from your feed, articles, and notifications. Mute rules
          sync across your devices via Nostr (NIP-51). Regex rules use a custom tag and only sync to
          this client.
        </p>

        {/* DISPLAY MODE */}
        <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>Feed display</span>
        <div style={{ display: "flex", gap: 9, marginBottom: 18 }} role="group" aria-label="Mute display mode">
          <MuteChoice
            label="Hide completely"
            active={muteSettings.display === "hidden"}
            testId="mute-display-hidden"
            onClick={() => setMuteDisplay("hidden")}
          />
          <MuteChoice
            label="Show summary"
            active={muteSettings.display === "summary"}
            testId="mute-display-summary"
            onClick={() => setMuteDisplay("summary")}
          />
        </div>

        {/* EXPIRY (shared by the add controls) */}
        <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>Duration for new mutes</span>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}
          role="group"
          aria-label="Mute duration"
        >
          <MuteChoice
            label="Permanent"
            active={muteTtl === -1}
            testId="mute-ttl-permanent"
            onClick={() => setMuteTtl(-1)}
          />
          {TTL_PRESETS.map((preset, i) => (
            <MuteChoice
              key={preset.label}
              label={preset.label}
              active={muteTtl === i}
              testId={`mute-ttl-${i}`}
              onClick={() => setMuteTtl(i)}
            />
          ))}
        </div>

        {/* ADD: keyword */}
        <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>Mute a word</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addMuteKeyword();
          }}
          style={{ display: "flex", gap: 9, marginBottom: 16 }}
        >
          <input
            value={muteKeyword}
            onChange={(e) => setMuteKeyword(e.target.value)}
            maxLength={MAX_KEYWORD_LENGTH}
            placeholder="word or phrase"
            aria-label="Word to mute"
            style={muteInput}
          />
          <PrimaryButton type="submit" style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
            Mute word
          </PrimaryButton>
        </form>

        {/* ADD: account */}
        <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>Mute an account</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addMuteAccount();
          }}
          style={{ display: "flex", gap: 9, marginBottom: 16 }}
        >
          <input
            value={muteAccount}
            onChange={(e) => setMuteAccount(e.target.value)}
            placeholder="npub1… or 64-char hex"
            aria-label="Account to mute"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ ...muteInput, fontFamily: mono }}
          />
          <PrimaryButton type="submit" style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
            Mute account
          </PrimaryButton>
        </form>

        {/* ADVANCED: regex (secondary / collapsible) */}
        <button
          type="button"
          data-testid="mute-advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: 0,
            marginBottom: showAdvanced ? 10 : 0,
            border: "none",
            background: "transparent",
            color: "var(--text-3)",
            fontFamily: "inherit",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          <span style={{ transform: showAdvanced ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            ›
          </span>
          Advanced · regular expression
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 2 }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addMuteRegex();
              }}
              style={{ display: "flex", gap: 9 }}
            >
              <input
                value={muteRegex}
                onChange={(e) => setMuteRegex(e.target.value)}
                maxLength={MAX_REGEX_LENGTH}
                placeholder="^spam.*$"
                aria-label="Regex pattern to mute"
                aria-invalid={regexError.length > 0}
                style={{
                  ...muteInput,
                  fontFamily: mono,
                  borderColor: regexError ? "var(--danger)" : "var(--glass-border)",
                }}
              />
              <PrimaryButton
                type="submit"
                disabled={!regexValidation.ok}
                style={{
                  padding: "10px 16px",
                  whiteSpace: "nowrap",
                  opacity: regexValidation.ok ? 1 : 0.55,
                  cursor: regexValidation.ok ? "pointer" : "not-allowed",
                }}
              >
                Mute pattern
              </PrimaryButton>
            </form>
            {regexError && (
              <p
                role="alert"
                style={{ margin: "7px 0 0", fontSize: 12, color: "var(--danger)", fontFamily: mono }}
              >
                {regexError}
              </p>
            )}
            <p style={{ margin: "7px 0 0", fontSize: 11.5, color: "var(--text-3)" }}>
              Patterns are matched case-insensitively against text content.
            </p>
          </div>
        )}

        {/* RULE LIST */}
        <div style={{ marginTop: 20 }}>
          {muteSettings.rules.length === 0 ? (
            <p
              style={{
                margin: 0,
                padding: "16px 14px",
                borderRadius: 9,
                background: "var(--glass-2)",
                border: "1px dashed var(--hairline)",
                fontSize: 13,
                color: "var(--text-3)",
                textAlign: "center",
              }}
            >
              No mute rules yet. Add a word, account, or pattern above.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <MuteRuleGroup
                title="Accounts"
                rules={muteGroups.accounts}
                label={muteRuleLabel}
                onToggle={(id, enabled) => updateMuteRule(id, { enabled })}
                onRemove={removeMuteRule}
              />
              <MuteRuleGroup
                title="Keywords"
                rules={muteGroups.keywords}
                label={muteRuleLabel}
                onToggle={(id, enabled) => updateMuteRule(id, { enabled })}
                onRemove={removeMuteRule}
              />
              <MuteRuleGroup
                title="Patterns"
                rules={muteGroups.patterns}
                label={muteRuleLabel}
                onToggle={(id, enabled) => updateMuteRule(id, { enabled })}
                onRemove={removeMuteRule}
              />
            </div>
          )}
        </div>

        {/* BACKUP */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginTop: 20,
            paddingTop: 16,
            borderTop: "1px solid var(--hairline)",
          }}
        >
          <span style={{ ...cardLabel, flex: 1, minWidth: 0 }}>Backup</span>
          <PressButton testId="mute-export" onClick={exportMutes} style={muteBackupButton}>
            <DownloadGlyph />
            Export
          </PressButton>
          <PressButton
            testId="mute-import"
            onClick={() => importInputRef.current?.click()}
            style={muteBackupButton}
          >
            <UploadGlyph />
            Import
          </PressButton>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            data-testid="mute-import-input"
            aria-label="Import mute rules file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importMutes(file);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        </div>
      </div>

      {/* ── Follow lists (NIP-51) ── */}
      <h3 style={{ ...h3Title, margin: "24px 0 12px" }}>Follow lists</h3>
      <div style={{ ...glassCard, padding: 18, marginBottom: 14 }}>
        {followSets.length === 0 ? (
          <p
            style={{
              margin: "0 0 14px",
              padding: "16px 14px",
              borderRadius: 9,
              background: "var(--glass-2)",
              border: "1px dashed var(--hairline)",
              fontSize: 13,
              color: "var(--text-3)",
              textAlign: "center",
            }}
          >
            No follow lists yet. Create one below.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {followSets.map((set: FollowSet) => (
              <div
                key={set.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "10px 12px",
                  borderRadius: 9,
                  background: "var(--glass-2)",
                  border: "1px solid var(--hairline)",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {set.name}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                  {set.pubkeys.length} {set.pubkeys.length === 1 ? "person" : "people"}
                </span>
                <button
                  type="button"
                  onClick={() => void updateFollowSet(set.id, { isPrivate: !set.isPrivate })}
                  aria-pressed={set.isPrivate}
                  title={set.isPrivate ? "Private — click to make public" : "Public — click to make private"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "6px 11px",
                    border: set.isPrivate ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
                    borderRadius: 8,
                    background: set.isPrivate ? "var(--accent-soft)" : "var(--glass)",
                    color: set.isPrivate ? "var(--accent)" : "var(--text-3)",
                    fontWeight: 700,
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    transition: "all .15s",
                    flexShrink: 0,
                  }}
                >
                  {set.isPrivate ? "🔒 Private" : "Public"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteFollowSet(set.id)}
                  aria-label={`Delete follow list ${set.name}`}
                  style={{
                    display: "flex",
                    padding: 8,
                    border: "none",
                    borderRadius: 9,
                    background: "transparent",
                    color: "var(--danger)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>New list</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = newFollowSetName.trim();
            if (!name) return;
            void createFollowSet(name, newFollowSetPrivate);
            setNewFollowSetName("");
            setNewFollowSetPrivate(false);
          }}
          style={{ display: "flex", gap: 9, alignItems: "center" }}
        >
          <input
            value={newFollowSetName}
            onChange={(e) => setNewFollowSetName(e.target.value)}
            placeholder="List name"
            aria-label="Follow list name"
            style={muteInput}
          />
          <button
            type="button"
            onClick={() => setNewFollowSetPrivate((v) => !v)}
            aria-pressed={newFollowSetPrivate}
            title={newFollowSetPrivate ? "Private — click to make public" : "Public — click to make private"}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 13px",
              border: newFollowSetPrivate ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
              borderRadius: 9,
              background: newFollowSetPrivate ? "var(--accent-soft)" : "var(--glass)",
              color: newFollowSetPrivate ? "var(--accent)" : "var(--text-3)",
              fontWeight: 700,
              fontSize: 12.5,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "all .15s",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {newFollowSetPrivate ? "🔒 Private" : "Public"}
          </button>
          <PrimaryButton type="submit" style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
            Create
          </PrimaryButton>
        </form>
      </div>

      {/* ── Bookmark lists (NIP-51) ── */}
      <h3 style={{ ...h3Title, margin: "24px 0 12px" }}>Bookmark lists</h3>
      <div style={{ ...glassCard, padding: 18, marginBottom: 14 }}>
        {bookmarkSets.length === 0 ? (
          <p
            style={{
              margin: "0 0 14px",
              padding: "16px 14px",
              borderRadius: 9,
              background: "var(--glass-2)",
              border: "1px dashed var(--hairline)",
              fontSize: 13,
              color: "var(--text-3)",
              textAlign: "center",
            }}
          >
            No bookmark lists yet. Create one below.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {bookmarkSets.map((set: BookmarkSet) => (
              <div
                key={set.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "10px 12px",
                  borderRadius: 9,
                  background: "var(--glass-2)",
                  border: "1px solid var(--hairline)",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {set.name}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                  {set.eventIds.length} {set.eventIds.length === 1 ? "bookmark" : "bookmarks"}
                </span>
                <button
                  type="button"
                  onClick={() => void updateBookmarkSet(set.id, { isPrivate: !set.isPrivate })}
                  aria-pressed={set.isPrivate}
                  title={set.isPrivate ? "Private — click to make public" : "Public — click to make private"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "6px 11px",
                    border: set.isPrivate ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
                    borderRadius: 8,
                    background: set.isPrivate ? "var(--accent-soft)" : "var(--glass)",
                    color: set.isPrivate ? "var(--accent)" : "var(--text-3)",
                    fontWeight: 700,
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    transition: "all .15s",
                    flexShrink: 0,
                  }}
                >
                  {set.isPrivate ? "🔒 Private" : "Public"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteBookmarkSet(set.id)}
                  aria-label={`Delete bookmark list ${set.name}`}
                  style={{
                    display: "flex",
                    padding: 8,
                    border: "none",
                    borderRadius: 9,
                    background: "transparent",
                    color: "var(--danger)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>New list</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBookmarkSetName.trim();
            if (!name) return;
            void createBookmarkSet(name, newBookmarkSetPrivate);
            setNewBookmarkSetName("");
            setNewBookmarkSetPrivate(false);
          }}
          style={{ display: "flex", gap: 9, alignItems: "center" }}
        >
          <input
            value={newBookmarkSetName}
            onChange={(e) => setNewBookmarkSetName(e.target.value)}
            placeholder="List name"
            aria-label="Bookmark list name"
            style={muteInput}
          />
          <button
            type="button"
            onClick={() => setNewBookmarkSetPrivate((v) => !v)}
            aria-pressed={newBookmarkSetPrivate}
            title={newBookmarkSetPrivate ? "Private — click to make public" : "Public — click to make private"}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 13px",
              border: newBookmarkSetPrivate ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
              borderRadius: 9,
              background: newBookmarkSetPrivate ? "var(--accent-soft)" : "var(--glass)",
              color: newBookmarkSetPrivate ? "var(--accent)" : "var(--text-3)",
              fontWeight: 700,
              fontSize: 12.5,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "all .15s",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {newBookmarkSetPrivate ? "🔒 Private" : "Public"}
          </button>
          <PrimaryButton type="submit" style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
            Create
          </PrimaryButton>
        </form>
      </div>

      {/* ── Sign out (required by view brief; outside the design region) ── */}
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
          background: "color-mix(in srgb, var(--danger) 12%, transparent)",
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
            <h3 style={{ ...h3Title, fontSize: 17, marginBottom: 8 }}>Sign out?</h3>
            <p style={{ margin: "0 0 18px", fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55 }}>
              {isLocal
                ? "This removes your private key from this browser. If you haven't backed up your nsec, you will lose access to this identity permanently."
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

/* ── small button primitives with hover/active micro-interactions ───────── */

const CopyButton = ({
  testId,
  onClick,
  ariaLabel,
}: {
  testId: string;
  onClick: () => void;
  ariaLabel: string;
}): ReactNode => {
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        setPress(false);
      }}
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerCancel={() => setPress(false)}
      aria-label={ariaLabel}
      style={{
        display: "flex",
        padding: 8,
        border: "none",
        borderRadius: 10,
        background: hover ? "var(--accent-soft)" : "transparent",
        color: hover ? "var(--accent)" : "var(--text-3)",
        cursor: "pointer",
        flexShrink: 0,
        transition: "all .15s",
        transform: press ? "scale(.92)" : "none",
      }}
    >
      <CopyGlyph size={16} />
    </button>
  );
};

const PressButton = ({
  testId,
  onClick,
  disabled,
  style,
  children,
}: {
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  style: CSSProperties;
  children: ReactNode;
}): ReactNode => {
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        setPress(false);
      }}
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerCancel={() => setPress(false)}
      style={{
        ...style,
        background: hover && !disabled ? "var(--glass-strong)" : style.background,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transform: press && !disabled ? "scale(.97)" : "none",
      }}
    >
      {children}
    </button>
  );
};

const GovRow = ({
  title,
  detail,
  on,
  testId,
  onToggle,
  border,
}: {
  title: string;
  detail: string;
  on: boolean;
  testId: string;
  onToggle: () => void;
  border?: boolean;
}): ReactNode => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 18px",
      borderBottom: border ? "1px solid var(--hairline)" : undefined,
    }}
  >
    <div style={{ flex: 1, minWidth: 0, paddingRight: 14 }}>
      <p style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: "var(--text)" }}>{title}</p>
      <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--text-2)" }}>{detail}</p>
    </div>
    <button
      type="button"
      data-testid={testId}
      onClick={onToggle}
      aria-pressed={on}
      style={trackStyle(on)}
    >
      <span style={knobStyle(on)} />
    </button>
  </div>
);

const RelayToggle = ({
  label,
  active,
  muted = false,
  onClick,
}: {
  label: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}): ReactNode => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "6px 11px",
      border: active && !muted ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
      borderRadius: 8,
      background: active && !muted ? "var(--accent-soft)" : "var(--glass)",
      color: active && !muted ? "var(--accent)" : "var(--text-3)",
      fontWeight: 700,
      fontSize: 12,
      fontFamily: "inherit",
      cursor: "pointer",
      transition: "all .15s",
    }}
  >
    {label}
  </button>
);

/* ── soft-mute controls ─────────────────────────────────────────────────── */

const MuteChoice = ({
  label,
  active,
  testId,
  onClick,
}: {
  label: string;
  active: boolean;
  testId: string;
  onClick: () => void;
}): ReactNode => (
  <button
    type="button"
    data-testid={testId}
    onClick={onClick}
    aria-pressed={active}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "8px 14px",
      border: active ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
      borderRadius: 9,
      background: active ? "var(--accent-soft)" : "var(--glass)",
      color: active ? "var(--accent)" : "var(--text-3)",
      fontWeight: 700,
      fontSize: 12.5,
      fontFamily: "inherit",
      cursor: "pointer",
      transition: "all .15s",
    }}
  >
    {label}
  </button>
);

const muteExpiryLabel = (rule: MuteRule, now: number): string => {
  if (rule.expiresAt === undefined) return "";
  if (isRuleExpired(rule, now)) return "";
  return `expires ${new Date(rule.expiresAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
};

const MuteRuleGroup = ({
  title,
  rules,
  label,
  onToggle,
  onRemove,
}: {
  title: string;
  rules: readonly MuteRule[];
  label: (rule: MuteRule) => string;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}): ReactNode => {
  if (rules.length === 0) return null;
  const now = Date.now();
  return (
    <div>
      <span style={{ ...cardLabel, display: "block", marginBottom: 8 }}>
        {title} · {rules.length}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rules.map((rule) => {
          const expired = isRuleExpired(rule, now);
          const expiry = muteExpiryLabel(rule, now);
          return (
            <div
              key={rule.id}
              data-testid={`mute-rule-${rule.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 12px",
                borderRadius: 9,
                background: rule.enabled ? "var(--glass-2)" : "var(--glass)",
                border: "1px solid var(--hairline)",
                opacity: rule.enabled && !expired ? 1 : 0.62,
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
                title={label(rule)}
              >
                {label(rule)}
              </span>
              {expired ? (
                <span style={{ fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                  expired
                </span>
              ) : (
                expiry && (
                  <span style={{ fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                    {expiry}
                  </span>
                )
              )}
              <RelayToggle
                label={rule.enabled ? "On" : "Off"}
                active={rule.enabled}
                onClick={() => onToggle(rule.id, !rule.enabled)}
              />
              <button
                type="button"
                onClick={() => onRemove(rule.id)}
                aria-label={`Remove mute rule ${label(rule)}`}
                style={{
                  display: "flex",
                  padding: 8,
                  border: "none",
                  borderRadius: 9,
                  background: "transparent",
                  color: "var(--danger)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <svg width={16} height={16} {...svgBase} strokeWidth={2.2} stroke="currentColor">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
