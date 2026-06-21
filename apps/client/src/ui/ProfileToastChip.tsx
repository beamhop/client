import type { ReactNode } from "react";
import { displayName, initials, avatarStyle } from "@beamhop/lib";
import { shortNpub } from "@beamhop/nostr";
import { useProfile, useStore } from "@beamhop/state";

export const ProfileToastChip = ({ pubkey }: { pubkey: string }): ReactNode => {
  const { navigate } = useStore();
  const profile = useProfile(pubkey);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey });
  // Prefer the human-readable profile name; fall back to a NIP-05 handle, and
  // only show the raw key (monospace) when the profile has neither — typically
  // while it's still loading or for a user with no metadata.
  const hasName = Boolean(profile?.displayName?.trim() || profile?.name?.trim());
  const label = hasName ? name : (profile?.nip05 ?? shortNpub(pubkey));
  const isRawKey = !hasName && !profile?.nip05;

  return (
    <button
      type="button"
      aria-label={`Open ${name}'s profile`}
      title={`Open ${name}'s profile`}
      onClick={(event) => {
        event.stopPropagation();
        navigate("profile", { pubkey });
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "middle",
        gap: 7,
        minWidth: 0,
        maxWidth: "min(220px, 46vw)",
        padding: "4px 8px 4px 5px",
        marginLeft: 1,
        border: "1px solid var(--glass-border)",
        borderRadius: 999,
        background: "linear-gradient(135deg,var(--accent-soft),var(--glass))",
        color: "var(--text)",
        boxShadow: "0 8px 24px -18px var(--accent)",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: 700,
      }}
    >
      <span
        style={{
          ...avatarStyle(pubkey, 24, profile?.picture),
          borderRadius: 999,
          fontSize: 9,
          boxShadow: "0 0 0 1px var(--glass-border)",
        }}
      >
        {!profile?.picture && initials(name)}
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: isRawKey ? "'Geist Mono',monospace" : "inherit",
        }}
      >
        {label}
      </span>
    </button>
  );
};
