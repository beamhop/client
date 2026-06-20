import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { useStore } from "../state/store.tsx";
import { shortNpub } from "../nostr/keys.ts";
import {
  Avatar,
  Modal,
  PrimaryButton,
  GhostButton,
  Pill,
  EmptyState,
  glass,
} from "../ui/primitives.tsx";
import {
  AgentsIcon,
  PlusIcon,
  CopyIcon,
  CloseIcon,
  ChevronLeftIcon,
  CheckIcon,
  KeyIcon,
} from "../ui/icons.tsx";

// ───────────────────────── persistence layer ─────────────────────────

type Agent = {
  id: string;
  name: string;
  handle: string;
  npub: string;
  pubkeyHex: string;
  secretHex: string;
  status: "active" | "paused";
  persona: string;
  tone: string;
  model: string;
  bio: string;
  skills: string[];
  tools: string[];
  createdAt: number;
};

const STORAGE_KEY = "verity.agents.v1";

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const isAgent = (v: unknown): v is Agent => {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.handle === "string" &&
    typeof a.npub === "string" &&
    typeof a.pubkeyHex === "string" &&
    typeof a.secretHex === "string" &&
    (a.status === "active" || a.status === "paused") &&
    typeof a.persona === "string" &&
    typeof a.tone === "string" &&
    typeof a.model === "string" &&
    typeof a.bio === "string" &&
    Array.isArray(a.skills) &&
    Array.isArray(a.tools) &&
    typeof a.createdAt === "number"
  );
};

const loadAgents = (): Agent[] => {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAgent);
  } catch {
    return [];
  }
};

const saveAgents = (a: Agent[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
};

// ───────────────────────── catalogs ─────────────────────────

const SKILL_CATALOG = [
  "Topic monitoring",
  "Thread summarization",
  "DM auto-response",
  "Intent classification",
  "Citation linking",
  "Daily summarization",
  "Translation",
] as const;

const TOOL_CATALOG: { id: string; label: string; desc: string }[] = [
  { id: "post", label: "Post", desc: "Publish notes to the network" },
  { id: "reply", label: "Reply", desc: "Respond in post threads" },
  { id: "mention", label: "Mention", desc: "Tag and notify other users" },
  { id: "send_dm", label: "Send DMs", desc: "Start direct conversations" },
  { id: "search_relays", label: "Search relays", desc: "Query the relay network" },
  { id: "fetch_url", label: "Fetch URL", desc: "Read linked web pages" },
];

const PERSONAS = ["curious", "helpful", "editorial", "analytical", "playful"] as const;
const TONES = ["concise", "warm", "professional", "friendly", "formal"] as const;
const MODELS: { label: string; desc: string }[] = [
  { label: "Claude Opus 4.8", desc: "Deepest reasoning, highest quality" },
  { label: "Claude Sonnet 4.5", desc: "Balanced speed and capability" },
  { label: "Claude Haiku 4.5", desc: "Fastest, lightweight tasks" },
];

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const handleFromName = (name: string): string => {
  const slug = slugify(name);
  return `${slug || "agent"}@verity.app`;
};

const toolLabel = (id: string): string => TOOL_CATALOG.find((t) => t.id === id)?.label ?? id;
const toolDesc = (id: string): string => TOOL_CATALOG.find((t) => t.id === id)?.desc ?? "";

// ───────────────────────── status pill ─────────────────────────

const StatusPill = ({ status }: { status: Agent["status"] }): ReactNode => {
  const active = status === "active";
  const color = active ? "var(--success)" : "var(--warn)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 800,
        letterSpacing: ".02em",
        background: active ? "rgba(34,197,94,.14)" : "rgba(245,158,11,.14)",
        color,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
      {active ? "Active" : "Paused"}
    </span>
  );
};

// ───────────────────────── wizard form ─────────────────────────

type Draft = {
  name: string;
  handle: string;
  handleEdited: boolean;
  persona: string;
  tone: string;
  model: string;
  bio: string;
  skills: string[];
  tools: string[];
};

const emptyDraft = (): Draft => ({
  name: "",
  handle: "",
  handleEdited: false,
  persona: "curious",
  tone: "concise",
  model: "Claude Sonnet 4.5",
  bio: "",
  skills: [],
  tools: ["post", "reply"],
});

const draftFromAgent = (a: Agent): Draft => ({
  name: a.name,
  handle: a.handle,
  handleEdited: true,
  persona: a.persona,
  tone: a.tone,
  model: a.model,
  bio: a.bio,
  skills: a.skills,
  tools: a.tools,
});

const toggle = (xs: string[], x: string): string[] =>
  xs.includes(x) ? xs.filter((v) => v !== x) : [...xs, x];

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
  marginBottom: 8,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  border: "1px solid var(--glass-border)",
  borderRadius: 10,
  background: "var(--glass)",
  color: "var(--text)",
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const chipStyle = (selected: boolean): CSSProperties => ({
  padding: "8px 14px",
  borderRadius: 9,
  border: `1px solid ${selected ? "var(--accent)" : "var(--glass-border)"}`,
  background: selected ? "var(--accent-soft)" : "var(--glass)",
  color: selected ? "var(--accent)" : "var(--text-2)",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "all .15s",
  textTransform: "capitalize",
});

const AgentWizard = ({
  initial,
  title,
  primaryLabel,
  onClose,
  onSubmit,
}: {
  initial: Draft;
  title: string;
  primaryLabel: string;
  onClose: () => void;
  onSubmit: (d: Draft) => void;
}): ReactNode => {
  const [d, setD] = useState<Draft>(initial);

  const setName = (name: string): void =>
    setD((p) => ({
      ...p,
      name,
      handle: p.handleEdited ? p.handle : handleFromName(name),
    }));
  const setHandle = (handle: string): void =>
    setD((p) => ({ ...p, handle, handleEdited: true }));

  const canSubmit = d.name.trim().length > 0;

  return (
    <Modal onClose={onClose} width={600}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "18px 20px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "var(--accent-soft)",
            color: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AgentsIcon size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontFamily: "'Space Grotesk',sans-serif",
              fontSize: 17,
              fontWeight: 700,
            }}
          >
            {title}
          </h3>
          <p style={{ margin: "1px 0 0", fontSize: 12, color: "var(--text-3)" }}>
            Give it an identity, persona, skills and tools.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex",
            padding: 7,
            border: "none",
            borderRadius: 8,
            background: "transparent",
            color: "var(--text-3)",
            cursor: "pointer",
          }}
        >
          <CloseIcon size={18} />
        </button>
      </div>

      <div style={{ maxHeight: "62vh", overflowY: "auto", padding: 20 }}>
        {/* Identity */}
        <label style={fieldLabel}>Name</label>
        <input
          value={d.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Release Notes Bot"
          style={{ ...inputStyle, marginBottom: 14 }}
        />
        <label style={fieldLabel}>Handle</label>
        <input
          value={d.handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="bot@verity.app"
          style={{
            ...inputStyle,
            marginBottom: 14,
            fontFamily: "'JetBrains Mono',monospace",
          }}
        />
        <label style={fieldLabel}>Bio</label>
        <textarea
          value={d.bio}
          onChange={(e) => setD((p) => ({ ...p, bio: e.target.value }))}
          placeholder="What does this agent do?"
          rows={3}
          style={{ ...inputStyle, marginBottom: 22, resize: "vertical" }}
        />

        {/* Persona */}
        <label style={fieldLabel}>Personality</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {PERSONAS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setD((prev) => ({ ...prev, persona: p }))}
              style={chipStyle(d.persona === p)}
            >
              {p}
            </button>
          ))}
        </div>

        <label style={fieldLabel}>Tone of voice</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {TONES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setD((prev) => ({ ...prev, tone: t }))}
              style={chipStyle(d.tone === t)}
            >
              {t}
            </button>
          ))}
        </div>

        <label style={fieldLabel}>Model</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
          {MODELS.map((m) => {
            const selected = d.model === m.label;
            return (
              <button
                key={m.label}
                type="button"
                onClick={() => setD((prev) => ({ ...prev, model: m.label }))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 11,
                  border: `1px solid ${selected ? "var(--accent)" : "var(--glass-border)"}`,
                  background: selected ? "var(--accent-soft)" : "var(--glass)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all .15s",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>
                    {m.label}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>{m.desc}</div>
                </div>
                {selected && (
                  <span style={{ color: "var(--accent)" }}>
                    <CheckIcon size={18} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Capabilities */}
        <label style={fieldLabel}>Skills</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 22 }}>
          {SKILL_CATALOG.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setD((prev) => ({ ...prev, skills: toggle(prev.skills, s) }))}
              style={{ ...chipStyle(d.skills.includes(s)), textTransform: "none" }}
            >
              {s}
            </button>
          ))}
        </div>

        <label style={fieldLabel}>Tools the agent can use</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {TOOL_CATALOG.map((t) => {
            const selected = d.tools.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setD((prev) => ({ ...prev, tools: toggle(prev.tools, t.id) }))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  textAlign: "left",
                  padding: "11px 13px",
                  borderRadius: 11,
                  border: `1px solid ${selected ? "var(--accent)" : "var(--glass-border)"}`,
                  background: selected ? "var(--accent-soft)" : "var(--glass)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all .15s",
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    minWidth: 20,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: selected ? "var(--accent)" : "transparent",
                    border: selected ? "none" : "1.5px solid var(--glass-border)",
                    color: "#fff",
                  }}
                >
                  {selected && <CheckIcon size={13} stroke={3} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>
                    {t.label}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>{t.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 20px",
          borderTop: "1px solid var(--hairline)",
        }}
      >
        <div style={{ flex: 1 }} />
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton disabled={!canSubmit} onClick={() => canSubmit && onSubmit(d)}>
          {primaryLabel}
        </PrimaryButton>
      </div>
    </Modal>
  );
};

// ───────────────────────── list screen ─────────────────────────

const AgentCard = ({ agent, onOpen }: { agent: Agent; onOpen: () => void }): ReactNode => (
  <button
    type="button"
    onClick={onOpen}
    style={{
      ...glass,
      display: "flex",
      flexDirection: "column",
      gap: 12,
      padding: 16,
      textAlign: "left",
      cursor: "pointer",
      fontFamily: "inherit",
      transition: "all .18s",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
      <Avatar pubkey={agent.pubkeyHex} name={agent.name} size={44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: 15.5,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.name}
          </span>
          <Pill tone="accent">AI</Pill>
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
          {agent.handle}
        </div>
      </div>
    </div>

    {agent.bio && (
      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--text-2)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {agent.bio}
      </p>
    )}

    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <StatusPill status={agent.status} />
      <span style={{ fontSize: 11.5, color: "var(--text-3)", textTransform: "capitalize" }}>
        {agent.persona} · {agent.tone}
      </span>
    </div>

    {agent.skills.length > 0 && (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          paddingTop: 12,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        {agent.skills.slice(0, 3).map((s) => (
          <Pill key={s}>{s}</Pill>
        ))}
        {agent.skills.length > 3 && <Pill>+{agent.skills.length - 3}</Pill>}
      </div>
    )}
  </button>
);

const Stat = ({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color?: string;
}): ReactNode => (
  <div>
    <div
      style={{
        fontFamily: "'Space Grotesk',sans-serif",
        fontSize: 26,
        fontWeight: 700,
        lineHeight: 1,
        color: color ?? "var(--text)",
      }}
    >
      {value}
    </div>
    <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>{label}</div>
  </div>
);

const AgentsList = ({
  agents,
  onCreate,
  onOpen,
}: {
  agents: Agent[];
  onCreate: () => void;
  onOpen: (id: string) => void;
}): ReactNode => {
  const active = agents.filter((a) => a.status === "active").length;
  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "6px 22px 120px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", gap: 22, flex: 1, minWidth: 0, flexWrap: "wrap" }}>
          <Stat value={agents.length} label="Agents" />
          <Stat value={active} label="Active now" color="var(--success)" />
          <Stat value={agents.length - active} label="Paused" color="var(--warn)" />
        </div>
        <PrimaryButton onClick={onCreate}>
          <PlusIcon size={18} /> Create an agent
        </PrimaryButton>
      </div>

      {agents.length === 0 ? (
        <div style={{ ...glass, padding: "8px 0" }}>
          <EmptyState
            icon={<AgentsIcon size={40} />}
            title="No agents yet"
            hint="Create your first agent — an autonomous identity with its own keypair, persona, skills and tools."
          />
          <div style={{ display: "flex", justifyContent: "center", paddingBottom: 24 }}>
            <PrimaryButton onClick={onCreate}>
              <PlusIcon size={18} /> Create your first agent
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))",
            gap: 14,
          }}
        >
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} onOpen={() => onOpen(a.id)} />
          ))}
          <button
            type="button"
            onClick={onCreate}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              minHeight: 200,
              padding: 18,
              borderRadius: 16,
              border: "1.5px dashed var(--glass-border)",
              background: "transparent",
              color: "var(--text-3)",
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all .18s",
            }}
          >
            <span
              style={{
                width: 46,
                height: 46,
                borderRadius: 13,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <PlusIcon size={22} />
            </span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Create a new agent</span>
            <span style={{ fontSize: 12, maxWidth: 200, textAlign: "center", lineHeight: 1.4 }}>
              Give it an identity, skills and tools
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

// ───────────────────────── detail screen ─────────────────────────

const sectionTitle: CSSProperties = {
  margin: "0 0 12px",
  fontFamily: "'Space Grotesk',sans-serif",
  fontSize: 15,
  fontWeight: 700,
};

const tabBtn = (active: boolean): CSSProperties => ({
  padding: "0 0 12px",
  border: "none",
  background: "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: 700,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
  borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
  marginBottom: -1,
});

type Tab = "overview" | "activity" | "identity";

const MetaChip = ({
  children,
  capitalize,
}: {
  children: ReactNode;
  capitalize?: boolean;
}): ReactNode => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "5px 11px",
      borderRadius: 8,
      background: "var(--glass-2)",
      fontSize: 12,
      color: "var(--text-2)",
      fontWeight: 600,
      textTransform: capitalize ? "capitalize" : "none",
    }}
  >
    {children}
  </span>
);

const OverviewTab = ({ agent }: { agent: Agent }): ReactNode => (
  <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 24 }}>
    {agent.bio && (
      <div>
        <h3 style={sectionTitle}>About</h3>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--text-2)" }}>
          {agent.bio}
        </p>
      </div>
    )}
    <div>
      <h3 style={sectionTitle}>Skills</h3>
      {agent.skills.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-3)" }}>No skills configured.</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {agent.skills.map((s) => (
            <span
              key={s}
              style={{
                padding: "8px 14px",
                borderRadius: 9,
                ...glass,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-2)",
              }}
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
    <div>
      <h3 style={sectionTitle}>Tools</h3>
      {agent.tools.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-3)" }}>No tools enabled.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 10,
          }}
        >
          {agent.tools.map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "13px 14px",
                borderRadius: 11,
                ...glass,
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  minWidth: 32,
                  borderRadius: 9,
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <KeyIcon size={16} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>
                  {toolLabel(t)}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {toolDesc(t)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    <div>
      <h3 style={sectionTitle}>Model</h3>
      <MetaChip>{agent.model}</MetaChip>
    </div>
  </div>
);

const ActivityTab = ({ agent }: { agent: Agent }): ReactNode => {
  const when = new Date(agent.createdAt).toLocaleString();
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", gap: 13, padding: "14px 0" }}>
        <span
          style={{
            width: 34,
            height: 34,
            minWidth: 34,
            borderRadius: 10,
            background: "var(--accent-soft)",
            color: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CheckIcon size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--text)" }}>
            Agent created and joined the network.
          </p>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 5 }}>{when}</div>
        </div>
      </div>
      <div
        style={{
          marginTop: 12,
          padding: 16,
          borderRadius: 12,
          background: "var(--glass-2)",
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--text-3)",
        }}
      >
        Activity will appear here as the agent acts on the network — posts, replies, mentions and
        DMs it sends will be logged in this timeline.
      </div>
    </div>
  );
};

const IdentityTab = ({
  agent,
  onCopyNpub,
}: {
  agent: Agent;
  onCopyNpub: () => void;
}): ReactNode => (
  <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
    <div style={{ padding: 16, borderRadius: 12, ...glass }}>
      <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>Public key (npub)</div>
      <button
        type="button"
        onClick={onCopyNpub}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text)",
          fontSize: 13,
          fontFamily: "'JetBrains Mono',monospace",
          cursor: "pointer",
          wordBreak: "break-all",
          textAlign: "left",
        }}
      >
        <CopyIcon size={14} />
        {agent.npub}
      </button>
    </div>
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        background: "var(--glass-2)",
        fontSize: 13,
        lineHeight: 1.55,
        color: "var(--text-3)",
      }}
    >
      This agent has its own Nostr keypair, generated and stored locally on this device. It signs
      and acts under its own identity — independent of your account.
    </div>
  </div>
);

const AgentDetail = ({
  agent,
  onBack,
  onCopyNpub,
  onToggle,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  onBack: () => void;
  onCopyNpub: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): ReactNode => {
  const [tab, setTab] = useState<Tab>("overview");
  const active = agent.status === "active";

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "14px 22px 120px" }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-3)",
          fontWeight: 600,
          fontSize: 13.5,
          fontFamily: "inherit",
          cursor: "pointer",
          marginBottom: 16,
        }}
      >
        <ChevronLeftIcon size={17} /> All agents
      </button>

      {/* identity band */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
        <Avatar pubkey={agent.pubkeyHex} name={agent.name} size={72} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h2
              style={{
                margin: 0,
                fontFamily: "'Space Grotesk',sans-serif",
                fontSize: 24,
                fontWeight: 700,
                letterSpacing: "-.02em",
              }}
            >
              {agent.name}
            </h2>
            <Pill tone="accent">AI AGENT</Pill>
            <StatusPill status={agent.status} />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 6,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 13.5,
                color: "var(--text-3)",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              {agent.handle}
            </span>
            <button
              type="button"
              onClick={onCopyNpub}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: 0,
                border: "none",
                background: "transparent",
                color: "var(--text-3)",
                fontSize: 12,
                fontFamily: "'JetBrains Mono',monospace",
                cursor: "pointer",
              }}
            >
              <CopyIcon size={12} />
              {shortNpub(agent.pubkeyHex)}
            </button>
          </div>
          {agent.bio && (
            <p
              style={{
                margin: "11px 0 0",
                fontSize: 14,
                lineHeight: 1.55,
                color: "var(--text-2)",
                maxWidth: 560,
              }}
            >
              {agent.bio}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <MetaChip>{agent.model}</MetaChip>
            <MetaChip capitalize>
              {agent.persona} · {agent.tone}
            </MetaChip>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <GhostButton onClick={onEdit}>Edit</GhostButton>
          <GhostButton onClick={onToggle}>{active ? "Pause" : "Resume"}</GhostButton>
          <GhostButton onClick={onDelete} style={{ color: "var(--danger)" }}>
            Delete
          </GhostButton>
        </div>
      </div>

      {/* tabs */}
      <div
        style={{
          display: "flex",
          gap: 22,
          marginTop: 24,
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <button type="button" style={tabBtn(tab === "overview")} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" style={tabBtn(tab === "activity")} onClick={() => setTab("activity")}>
          Activity
        </button>
        <button type="button" style={tabBtn(tab === "identity")} onClick={() => setTab("identity")}>
          Identity
        </button>
      </div>

      {tab === "overview" && <OverviewTab agent={agent} />}
      {tab === "activity" && <ActivityTab agent={agent} />}
      {tab === "identity" && <IdentityTab agent={agent} onCopyNpub={onCopyNpub} />}
    </div>
  );
};

// ───────────────────────── delete confirm ─────────────────────────

const DeleteConfirm = ({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode => (
  <Modal onClose={onCancel} width={420}>
    <div style={{ padding: 24 }}>
      <h3
        style={{
          margin: "0 0 8px",
          fontFamily: "'Space Grotesk',sans-serif",
          fontSize: 18,
          fontWeight: 700,
        }}
      >
        Delete {name}?
      </h3>
      <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.55, color: "var(--text-2)" }}>
        This permanently removes the agent and its keypair from this device. This cannot be undone.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton onClick={onConfirm} style={{ background: "var(--danger)" }}>
          Delete agent
        </PrimaryButton>
      </div>
    </div>
  </Modal>
);

// ───────────────────────── root view ─────────────────────────

export const AgentsView = (): ReactNode => {
  const { state, navigate, toast } = useStore();
  const [agents, setAgents] = useState<Agent[]>(() => loadAgents());
  const [wizard, setWizard] = useState<"create" | "edit" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const view = state.nav.view;
  const detailId = state.nav.params.id;

  const persist = (next: Agent[]): void => {
    saveAgents(next);
    setAgents(next);
  };

  const detailAgent = useMemo(
    () => (detailId ? agents.find((a) => a.id === detailId) : undefined),
    [agents, detailId],
  );

  const createAgent = (d: Draft): void => {
    const sk = generateSecretKey();
    const pubkeyHex = getPublicKey(sk);
    const agent: Agent = {
      id: `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: d.name.trim(),
      handle: d.handle.trim() || handleFromName(d.name),
      npub: nip19.npubEncode(pubkeyHex),
      pubkeyHex,
      secretHex: bytesToHex(sk),
      status: "active",
      persona: d.persona,
      tone: d.tone,
      model: d.model,
      bio: d.bio.trim(),
      skills: d.skills,
      tools: d.tools,
      createdAt: Date.now(),
    };
    persist([agent, ...agents]);
    setWizard(null);
    toast(`${agent.name} is live on the network`, "check");
    navigate("agentDetail", { id: agent.id });
  };

  const updateAgent = (id: string, patch: Partial<Agent>): void =>
    persist(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const saveEdit = (d: Draft): void => {
    if (!detailAgent) return;
    updateAgent(detailAgent.id, {
      name: d.name.trim(),
      handle: d.handle.trim() || handleFromName(d.name),
      persona: d.persona,
      tone: d.tone,
      model: d.model,
      bio: d.bio.trim(),
      skills: d.skills,
      tools: d.tools,
    });
    setWizard(null);
    toast("Agent updated", "check");
  };

  const copyNpub = (npub: string): void => {
    void navigator.clipboard?.writeText(npub);
    toast("npub copied", "copy");
  };

  const toggleStatus = (a: Agent): void => {
    const next: Agent["status"] = a.status === "active" ? "paused" : "active";
    updateAgent(a.id, { status: next });
    toast(next === "active" ? `${a.name} resumed` : `${a.name} paused`, "info");
  };

  const deleteAgent = (a: Agent): void => {
    persist(agents.filter((x) => x.id !== a.id));
    setConfirmDelete(false);
    toast(`${a.name} deleted`, "info");
    navigate("agents");
  };

  if (view === "agentDetail") {
    if (!detailAgent) {
      return (
        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "40px 22px" }}>
          <EmptyState
            icon={<AgentsIcon size={40} />}
            title="Agent not found"
            hint="It may have been deleted."
          />
          <div style={{ display: "flex", justifyContent: "center" }}>
            <GhostButton onClick={() => navigate("agents")}>Back to agents</GhostButton>
          </div>
        </div>
      );
    }
    return (
      <>
        <AgentDetail
          agent={detailAgent}
          onBack={() => navigate("agents")}
          onCopyNpub={() => copyNpub(detailAgent.npub)}
          onToggle={() => toggleStatus(detailAgent)}
          onEdit={() => setWizard("edit")}
          onDelete={() => setConfirmDelete(true)}
        />
        {wizard === "edit" && (
          <AgentWizard
            initial={draftFromAgent(detailAgent)}
            title="Edit agent"
            primaryLabel="Save changes"
            onClose={() => setWizard(null)}
            onSubmit={saveEdit}
          />
        )}
        {confirmDelete && (
          <DeleteConfirm
            name={detailAgent.name}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => deleteAgent(detailAgent)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <AgentsList
        agents={agents}
        onCreate={() => setWizard("create")}
        onOpen={(id) => navigate("agentDetail", { id })}
      />
      {wizard === "create" && (
        <AgentWizard
          initial={emptyDraft()}
          title="Create an agent"
          primaryLabel="Launch agent"
          onClose={() => setWizard(null)}
          onSubmit={createAgent}
        />
      )}
    </>
  );
};
