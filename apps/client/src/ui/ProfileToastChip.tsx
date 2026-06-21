import type { ReactNode } from "react";
import { displayName, initials, avatarStyle } from "@beamhop/lib";
import { shortNpub } from "@beamhop/nostr";
import { useProfile, useStore } from "@beamhop/state";

export const ProfileToastChip = ({ pubkey }: { pubkey: string }): ReactNode => {
  const { navigate } = useStore();
  const profile = useProfile(pubkey);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey });
  const handle = profile?.nip05 ?? shortNpub(pubkey);

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
          fontFamily: profile?.nip05 ? "inherit" : "'JetBrains Mono',monospace",
        }}
      >
        {handle}
      </span>
    </button>
  );
};
