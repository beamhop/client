import type { ReactNode } from "react";
import { useStore } from "../state/store.tsx";
import { CheckIcon, CopyIcon, RepostIcon } from "./icons.tsx";

const toneIcon = (tone: string): ReactNode => {
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

const toneColor = (tone: string): string => {
  if (tone === "warn") return "var(--warn)";
  if (tone === "check") return "var(--success)";
  return "var(--accent)";
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
            padding: "11px 16px",
            borderRadius: 12,
            background: "var(--glass-strong)",
            border: "1px solid var(--glass-border)",
            boxShadow: "var(--glass-shadow-lg)",
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--text)",
            animation: "verity-toast .25s ease",
          }}
        >
          <span style={{ color: toneColor(t.tone), display: "flex" }}>{toneIcon(t.tone)}</span>
          {t.text}
        </div>
      ))}
    </div>
  );
};
