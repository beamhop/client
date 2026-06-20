import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type BubblePopTone = "accent" | "success" | "info" | "warn" | "danger";

type BubblePopProps = {
  children: ReactNode;
  message: ReactNode;
  activeKey: number | string | null | undefined;
  tone?: BubblePopTone;
  durationMs?: number;
  style?: CSSProperties;
  bubbleStyle?: CSSProperties;
};

const toneColors: Record<BubblePopTone, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  info: "var(--accent)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

const wrapperStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  isolation: "isolate",
};

export const BubblePop = ({
  children,
  message,
  activeKey,
  tone = "info",
  durationMs = 980,
  style,
  bubbleStyle,
}: BubblePopProps): ReactNode => {
  const [visible, setVisible] = useState(false);
  const [instance, setInstance] = useState(0);
  const didMount = useRef(false);
  const color = toneColors[tone];

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    if (activeKey === null || activeKey === undefined || typeof window === "undefined") return;

    setVisible(false);
    const frame = window.requestAnimationFrame(() => {
      setInstance((current) => current + 1);
      setVisible(true);
    });
    const timer = window.setTimeout(() => setVisible(false), durationMs);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [activeKey, durationMs]);

  return (
    <span style={{ ...wrapperStyle, ...style }}>
      {children}
      {visible && (
        <span
          key={instance}
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            left: "50%",
            bottom: "calc(100% - 1px)",
            zIndex: 8,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 27,
            padding: "7px 10px",
            borderRadius: 999,
            border: `1px solid ${color}`,
            background: "var(--glass-strong)",
            color,
            boxShadow: "0 14px 34px -18px rgba(20,22,45,.58)",
            fontSize: 12,
            fontWeight: 800,
            lineHeight: 1,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            transform: "translate(-50%, 6px) scale(.78)",
            transformOrigin: "50% 100%",
            animation: `verity-bubble-pop ${durationMs}ms cubic-bezier(.18,.82,.22,1) forwards`,
            ...bubbleStyle,
          }}
        >
          {message}
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 8,
              height: 8,
              borderRadius: "50%",
              border: `1.5px solid ${color}`,
              opacity: 0,
              transform: "translate(-50%, -50%) scale(.7)",
              animation: `verity-bubble-burst ${Math.round(durationMs * 0.42)}ms ease-out forwards`,
              animationDelay: `${Math.round(durationMs * 0.55)}ms`,
            }}
          />
        </span>
      )}
    </span>
  );
};
