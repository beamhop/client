import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, type ViewId } from "../state/store.tsx";

type Command = {
  id: string;
  label: string;
  group: string;
  iconPath: string;
  kbd?: string;
  run: () => void;
};

/** ⌘K command palette, faithful to the design (verity-glass.html 1635-1664). */
export const CommandPalette = ({ onClose, onCompose }: { onClose: () => void; onCompose: () => void }): ReactNode => {
  const { navigate, toggleTheme, state } = useStore();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = (view: ViewId) => () => {
    navigate(view);
    onClose();
  };

  const commands = useMemo<Command[]>(
    () => [
      { id: "home", label: "Go to Home", group: "Navigate", iconPath: "M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z", run: go("home") },
      { id: "explore", label: "Go to Explore", group: "Navigate", iconPath: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3", run: go("explore") },
      { id: "notifications", label: "Go to Notifications", group: "Navigate", iconPath: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21a2 2 0 0 0 4 0", run: go("notifications") },
      { id: "docs", label: "Go to Documentations", group: "Navigate", iconPath: "M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", run: go("docs") },
      { id: "messages", label: "Go to Messages", group: "Navigate", iconPath: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", run: go("messages") },
      { id: "agents", label: "Go to Agents", group: "Navigate", iconPath: "M4 7h16v12H4zM12 7V4", run: go("agents") },
      { id: "profile", label: "Go to Profile", group: "Navigate", iconPath: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0", run: go("profile") },
      { id: "security", label: "Go to Keys & Security", group: "Navigate", iconPath: "M12 22s8-3.5 8-9.5V5l-8-3-8 3v7.5C4 18.5 12 22 12 22z", run: go("security") },
      { id: "compose", label: "New post", group: "Create", iconPath: "M12 5v14M5 12h14", kbd: "C", run: () => { onClose(); onCompose(); } },
      { id: "writedoc", label: "Write documentation", group: "Create", iconPath: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", run: go("docEditor") },
      { id: "writearticle", label: "Write article", group: "Create", iconPath: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", run: go("articleEditor") },
      { id: "theme", label: state.theme === "dark" ? "Switch to light mode" : "Switch to dark mode", group: "Settings", iconPath: "M12 3v2M12 19v2M5 12H3M21 12h-2", run: () => { toggleTheme(); onClose(); } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.theme],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setIndex(0), [query]);

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[index]?.run();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      data-testid="command-palette"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(10,10,25,.42)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "92px 18px", animation: "verity-fade .14s" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 580, background: "var(--glass-strong)", border: "1px solid var(--glass-border)", borderRadius: 14, boxShadow: "var(--glass-shadow-lg)", overflow: "hidden", animation: "verity-scale .18s cubic-bezier(.2,.9,.3,1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 16px", borderBottom: "1px solid var(--hairline)" }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
          <input ref={inputRef} data-testid="palette-input" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Type a command or search…" style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontSize: 16, color: "var(--text)", fontFamily: "inherit" }} />
          <span style={{ fontSize: 11, color: "var(--text-3)", background: "var(--glass-2)", padding: "3px 7px", borderRadius: 6, fontFamily: "'JetBrains Mono',monospace" }}>esc</span>
        </div>
        <div data-testid="palette-list" style={{ maxHeight: 344, overflowY: "auto", padding: 6 }}>
          {results.map((c, i) => (
            <button
              key={c.id}
              data-testid="palette-item"
              onClick={c.run}
              onMouseMove={() => setIndex(i)}
              style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 12px", border: "none", borderRadius: 9, background: i === index ? "var(--accent-soft)" : "transparent", cursor: "pointer", fontFamily: "inherit", transition: "background .1s" }}
            >
              <span style={{ display: "flex", width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", background: "var(--glass-2)", color: i === index ? "var(--accent)" : "var(--text-2)", flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={c.iconPath} /></svg>
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 14, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
              </span>
              <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600, letterSpacing: ".03em" }}>{c.group}</span>
              {c.kbd && <span style={{ fontSize: 11, color: "var(--text-3)", background: "var(--glass-2)", padding: "3px 7px", borderRadius: 6, fontFamily: "'JetBrains Mono',monospace" }}>{c.kbd}</span>}
            </button>
          ))}
          {results.length === 0 && <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 13.5, color: "var(--text-3)" }}>No commands match “{query}”</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 16px", borderTop: "1px solid var(--hairline)", fontSize: 11.5, color: "var(--text-3)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontFamily: "'JetBrains Mono',monospace", background: "var(--glass-2)", padding: "2px 6px", borderRadius: 5 }}>↑↓</span> navigate</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontFamily: "'JetBrains Mono',monospace", background: "var(--glass-2)", padding: "2px 6px", borderRadius: 5 }}>↵</span> run</span>
        </div>
      </div>
    </div>
  );
};
