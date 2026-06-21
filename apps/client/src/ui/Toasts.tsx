import type { ReactNode } from "react";
import { useStore, type Toast, type ToastAction } from "@beamhop/state";
import { CheckIcon, CopyIcon, RepostIcon } from "./icons.tsx";
import { ProfileToastChip } from "./ProfileToastChip.tsx";

const toneIcon = (tone: Toast["tone"]): ReactNode => {
  switch (tone) {
    case "check":
      return <CheckIcon size={16} />;
    case "copy":
      return <CopyIcon size={16} />;
    case "repost":
      return <RepostIcon size={16} />;
    default:
      return null;
  }
};

const toneColor = (tone: Toast["tone"]): string => {
  if (tone === "warn") return "var(--warn)";
  if (tone === "check") return "var(--success)";
  return "var(--accent)";
};

const ToastActionView = ({ action }: { action: ToastAction }): ReactNode => {
  if (action.type === "profile") return <ProfileToastChip pubkey={action.pubkey} />;
  return null;
};

export const Toasts = (): ReactNode => {
  const { state } = useStore();
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      {state.toasts.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "calc(100vw - 32px)",
            padding: "11px 16px",
            borderRadius: 12,
            background: "var(--glass-strong)",
            border: "1px solid var(--glass-border)",
            boxShadow: "var(--glass-shadow-lg)",
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--text)",
            animation: "beamhop-toast .25s ease",
            pointerEvents: "auto",
          }}
        >
          <span style={{ color: toneColor(t.tone), display: "flex" }}>{toneIcon(t.tone)}</span>
          {t.text}
          {t.action && <ToastActionView action={t.action} />}
        </div>
      ))}
    </div>
  );
};
