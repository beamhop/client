import type { CSSProperties, ReactNode } from "react";
import { avatarStyle, initials, displayName } from "../lib/format.ts";
import { useProfile } from "../state/store.tsx";
import { VerifiedSeal } from "./icons.tsx";

export const glass: CSSProperties = {
  background: "var(--glass)",
  border: "1px solid var(--glass-border)",
  borderRadius: 16,
  boxShadow: "var(--glass-shadow)",
};

export const glassStrong: CSSProperties = {
  background: "var(--glass-strong)",
  border: "1px solid var(--glass-border)",
  borderRadius: 16,
};

export const Card = ({
  children,
  style,
  ...rest
}: {
  children: ReactNode;
  style?: CSSProperties;
} & React.HTMLAttributes<HTMLDivElement>): ReactNode => (
  <div style={{ ...glass, ...style }} {...rest}>
    {children}
  </div>
);

/** A gradient/photo avatar resolved from a pubkey's profile. */
export const Avatar = ({
  pubkey,
  size = 44,
  name,
  picture,
  online,
  onClick,
}: {
  pubkey: string;
  size?: number;
  name?: string;
  picture?: string;
  online?: boolean;
  onClick?: () => void;
}): ReactNode => {
  const label = name ?? `${pubkey.slice(0, 8)}`;
  const wrap: CSSProperties = {
    position: "relative",
    flexShrink: 0,
    width: size,
    height: size,
    cursor: onClick ? "pointer" : "default",
  };
  return (
    <span style={wrap} onClick={onClick}>
      <span style={avatarStyle(pubkey, size, picture)}>{!picture && initials(label)}</span>
      {online !== undefined && (
        <span
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: size > 40 ? 13 : 11,
            height: size > 40 ? 13 : 11,
            borderRadius: "50%",
            background: online ? "var(--success)" : "var(--text-3)",
            border: "2.5px solid var(--bg-base)",
            boxSizing: "border-box",
          }}
        />
      )}
    </span>
  );
};

/** Avatar + name + handle, resolved live from the network. */
export const AuthorChip = ({
  pubkey,
  size = 44,
  subtitle,
  onClick,
}: {
  pubkey: string;
  size?: number;
  subtitle?: string;
  onClick?: () => void;
}): ReactNode => {
  const profile = useProfile(pubkey);
  const name = displayName({
    name: profile?.name,
    displayName: profile?.displayName,
    pubkey,
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
      <Avatar pubkey={pubkey} size={size} name={name} picture={profile?.picture} onClick={onClick} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontWeight: 700,
            fontSize: 14.5,
            color: "var(--text)",
            cursor: onClick ? "pointer" : "default",
          }}
          onClick={onClick}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </span>
          {profile?.nip05 && <VerifiedSeal size={14} />}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--text-3)",
            fontFamily: "'JetBrains Mono',monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subtitle ?? profile?.nip05 ?? `${pubkey.slice(0, 12)}…`}
        </div>
      </div>
    </div>
  );
};

export const Spinner = ({ size = 22 }: { size?: number }): ReactNode => (
  <span
    style={{
      display: "inline-block",
      width: size,
      height: size,
      border: "2.5px solid var(--glass-border)",
      borderTopColor: "var(--accent)",
      borderRadius: "50%",
      animation: "verity-spin .7s linear infinite",
    }}
  />
);

export const EmptyState = ({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}): ReactNode => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10,
      padding: "56px 24px",
      textAlign: "center",
      color: "var(--text-3)",
    }}
  >
    {icon && <div style={{ opacity: 0.6 }}>{icon}</div>}
    <div style={{ fontWeight: 700, fontSize: 16, color: "var(--text-2)" }}>{title}</div>
    {hint && <div style={{ fontSize: 13.5, maxWidth: 320 }}>{hint}</div>}
  </div>
);

export const PrimaryButton = ({
  children,
  onClick,
  disabled,
  style,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  type?: "button" | "submit";
}): ReactNode => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: "11px 18px",
      border: "1px solid rgba(255,255,255,.25)",
      borderRadius: 10,
      background: "var(--accent)",
      color: "var(--on-accent)",
      fontWeight: 700,
      fontSize: 14.5,
      fontFamily: "inherit",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "filter .2s, transform .12s",
      ...style,
    }}
  >
    {children}
  </button>
);

export const GhostButton = ({
  children,
  onClick,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
}): ReactNode => (
  <button
    type="button"
    onClick={onClick}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: "10px 16px",
      border: "1px solid var(--glass-border)",
      borderRadius: 10,
      background: "transparent",
      color: "var(--text-2)",
      fontWeight: 700,
      fontSize: 14,
      fontFamily: "inherit",
      cursor: "pointer",
      transition: "background .15s",
      ...style,
    }}
  >
    {children}
  </button>
);

/** Centered modal with backdrop. */
export const Modal = ({
  children,
  onClose,
  width = 540,
}: {
  children: ReactNode;
  onClose: () => void;
  width?: number;
}): ReactNode => (
  <div
    onClick={onClose}
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 60,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      padding: "8vh 16px 16px",
      background: "rgba(10,11,20,.5)",
      backdropFilter: "blur(3px)",
      WebkitBackdropFilter: "blur(3px)",
      animation: "verity-fade .18s ease",
      overflowY: "auto",
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        ...glassStrong,
        width: "100%",
        maxWidth: width,
        boxShadow: "var(--glass-shadow-lg)",
        animation: "verity-scale .2s ease",
      }}
    >
      {children}
    </div>
  </div>
);

export const Pill = ({ children, tone }: { children: ReactNode; tone?: "accent" | "muted" }): ReactNode => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "3px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 700,
      background: tone === "accent" ? "var(--accent-soft)" : "var(--glass-2)",
      color: tone === "accent" ? "var(--accent)" : "var(--text-3)",
    }}
  >
    {children}
  </span>
);
