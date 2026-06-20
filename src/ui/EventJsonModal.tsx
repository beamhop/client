import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { Event as NostrEvent } from "nostr-tools";
import { useStore } from "../state/store.tsx";
import { Modal } from "./primitives.tsx";

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  minWidth: 32,
  padding: 0,
  border: "none",
  borderRadius: 9,
  background: "transparent",
  color: "var(--text-3)",
  cursor: "pointer",
};

const headerButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "8px 12px",
  border: "1px solid var(--glass-border)",
  borderRadius: 9,
  background: "var(--glass)",
  color: "var(--text)",
  fontSize: 12.5,
  fontWeight: 800,
  fontFamily: "inherit",
  cursor: "pointer",
};

const CodeGlyph = ({ size = 17 }: { size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="4 6 16 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m10 8-4 4 4 4" />
    <path d="m14 8 4 4-4 4" />
  </svg>
);

const CopyGlyph = (): ReactNode => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const CloseGlyph = (): ReactNode => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const EventJsonButton = ({
  event,
  label = "Original Nostr event",
  title = "View raw event",
  style,
}: {
  event?: NostrEvent;
  label?: string;
  title?: string;
  style?: CSSProperties;
}): ReactNode => {
  const { state, toast } = useStore();
  const [open, setOpen] = useState(false);
  const json = useMemo(() => (event ? JSON.stringify(event, null, 2) : ""), [event]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!state.developerMode || !event) return null;

  const onOpen = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    setOpen(true);
  };

  const copy = (): void => {
    void navigator.clipboard?.writeText(json).then(
      () => toast("Event JSON copied", "copy"),
      () => toast("Could not copy event JSON", "warn"),
    );
  };

  return (
    <>
      <button type="button" data-testid="event-json-button" aria-label={title} title={title} onClick={onOpen} style={{ ...buttonStyle, ...style }}>
        <CodeGlyph />
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)} width={820}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 18px", borderBottom: "1px solid var(--hairline)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, fontWeight: 800, color: "var(--text)" }}>{label}</div>
              <div style={{ marginTop: 2, fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                kind {event.kind} · {event.id}
              </div>
            </div>
            <button type="button" onClick={copy} style={headerButtonStyle}>
              <CopyGlyph />
              Copy
            </button>
            <button type="button" aria-label="Close event JSON" onClick={() => setOpen(false)} style={{ ...buttonStyle, color: "var(--text-2)" }}>
              <CloseGlyph />
            </button>
          </div>
          <pre
            data-testid="event-json-modal"
            style={{
              margin: 0,
              padding: 18,
              maxHeight: "68vh",
              overflow: "auto",
              background: "var(--glass-2)",
              color: "var(--text)",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12.5,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {json}
          </pre>
        </Modal>
      )}
    </>
  );
};
