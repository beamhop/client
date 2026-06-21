import { useState, type ReactNode } from "react";
import { Modal } from "./primitives.tsx";

// One-off announcement shown on every load until the user opts out. We persist a
// single boolean so the dismissal survives reloads but stays trivially clearable.
const DISMISS_KEY = "beamhop.pitch.dismissed.v1";
const VIDEO_ID = "jhuY-7NyXFE";
const MESSAGE =
  "Stupid megathon app did not allow us to edit the submission link so we needed to pitch our video here";

const isDismissed = (): boolean => {
  try {
    return localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
};

export const PitchModal = (): ReactNode => {
  const [open, setOpen] = useState(() => !isDismissed());
  const [dontShow, setDontShow] = useState(false);

  if (!open) return null;

  const close = (): void => {
    if (dontShow) {
      try {
        localStorage.setItem(DISMISS_KEY, "true");
      } catch {
        /* storage unavailable — fall back to dismissing for this session only */
      }
    }
    setOpen(false);
  };

  return (
    <Modal onClose={close} width={640}>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
        <p
          style={{
            margin: 0,
            fontFamily: "'Geist Mono', monospace",
            fontSize: 20,
            fontWeight: 800,
            lineHeight: 1.3,
            letterSpacing: "-0.01em",
            textTransform: "uppercase",
            color: "var(--accent)",
            textWrap: "balance",
          }}
        >
          {MESSAGE.split("").map((ch, i) => (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                opacity: 0,
                animation: "beamhop-letter .4s cubic-bezier(.2,.9,.3,1.4) both",
                animationDelay: `${i * 0.025}s`,
              }}
            >
              {ch}
            </span>
          ))}
        </p>

        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "16 / 9",
            borderRadius: 12,
            overflow: "hidden",
            background: "#000",
          }}
        >
          <iframe
            src={`https://www.youtube.com/embed/${VIDEO_ID}`}
            title="Our pitch video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-2)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Do not show this again
          </label>
          <button
            onClick={close}
            style={{
              padding: "9px 18px",
              border: "1px solid var(--glass-border)",
              borderRadius: 10,
              background: "var(--accent)",
              color: "var(--on-accent)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            👍🏻 Got it 
          </button>
        </div>
      </div>
    </Modal>
  );
};
