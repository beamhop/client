import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { useStore } from "@beamhop/state";
import { initials, avatarStyle } from "@beamhop/lib";
import { shortNpub } from "@beamhop/nostr";
import {
  agentStatusMeta,
  agentTabStyle,
  segStyle,
  chipSelectStyle,
  rowSelectStyle,
  checkBoxStyle,
} from "../ui/styles.ts";

// ───────────────────────── domain model + persistence ─────────────────────────

type AgentStatus = "active" | "paused";
type McpStatus = "connected" | "degraded";

type Mcp = { name: string; status: McpStatus; detail: string };

type ActivityEvent = {
  type: "post" | "reply" | "mention" | "dm" | "follow" | "flag";
  text: string;
  time: string;
  conf?: number;
  flagged: boolean;
  resolved?: boolean;
};

type AgentStats = {
  posts: number;
  replies: number;
  dms: number;
  mentions: number;
  followers: number;
  uptime: string;
};

type Agent = {
  id: string;
  name: string;
  handle: string;
  npub: string;
  pubkeyHex: string;
  secretHex: string;
  status: AgentStatus;
  autonomy: "autonomous" | "supervised";
  persona: string;
  tone: string;
  model: string;
  bio: string;
  avatar: string | null;
  skills: string[];
  tools: string[];
  mcps: Mcp[];
  stats: AgentStats;
  activity: ActivityEvent[];
  createdAt: number;
};

const STORAGE_KEY = "beamhop.agents.v1";

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asNumber = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Lenient decoder: tolerates records persisted by older shapes and fills sane defaults,
// so the localStorage store survives schema growth without throwing data away.
const decodeAgent = (v: unknown): Agent | null => {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.pubkeyHex !== "string" || typeof a.secretHex !== "string")
    return null;
  const status: AgentStatus = a.status === "paused" ? "paused" : "active";
  const stats = (typeof a.stats === "object" && a.stats !== null ? a.stats : {}) as Record<string, unknown>;
  const mcps: Mcp[] = Array.isArray(a.mcps)
    ? a.mcps.flatMap((m): Mcp[] => {
        if (typeof m !== "object" || m === null) return [];
        const r = m as Record<string, unknown>;
        return [
          {
            name: asString(r.name),
            status: r.status === "degraded" ? "degraded" : "connected",
            detail: asString(r.detail),
          },
        ];
      })
    : [];
  const activity: ActivityEvent[] = Array.isArray(a.activity)
    ? a.activity.flatMap((e): ActivityEvent[] => {
        if (typeof e !== "object" || e === null) return [];
        const r = e as Record<string, unknown>;
        const types = ["post", "reply", "mention", "dm", "follow", "flag"] as const;
        const type = types.find((t) => t === r.type) ?? "post";
        return [
          {
            type,
            text: asString(r.text),
            time: asString(r.time, "just now"),
            conf: typeof r.conf === "number" ? r.conf : undefined,
            flagged: r.flagged === true,
            resolved: r.resolved === true,
          },
        ];
      })
    : [];
  return {
    id: a.id,
    name: asString(a.name, "Agent"),
    handle: asString(a.handle),
    npub: asString(a.npub),
    pubkeyHex: a.pubkeyHex,
    secretHex: a.secretHex,
    status,
    autonomy: a.autonomy === "supervised" ? "supervised" : "autonomous",
    persona: asString(a.persona, "helpful"),
    tone: asString(a.tone, "concise"),
    model: asString(a.model, "Claude Sonnet 4.5"),
    bio: asString(a.bio),
    avatar: typeof a.avatar === "string" ? a.avatar : null,
    skills: asStringArray(a.skills),
    tools: asStringArray(a.tools),
    mcps,
    stats: {
      posts: asNumber(stats.posts),
      replies: asNumber(stats.replies),
      dms: asNumber(stats.dms),
      mentions: asNumber(stats.mentions),
      followers: asNumber(stats.followers),
      uptime: asString(stats.uptime, "new"),
    },
    activity,
    createdAt: asNumber(a.createdAt, Date.now()),
  };
};

const loadAgents = (): Agent[] => {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) => {
      const a = decodeAgent(v);
      return a ? [a] : [];
    });
  } catch {
    return [];
  }
};

const saveAgents = (a: Agent[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
};

// ───────────────────────── catalogs ─────────────────────────

const PERSONAS = ["curious", "helpful", "editorial", "analytical", "playful"] as const;
const TONES = ["concise", "warm", "professional", "friendly", "formal"] as const;

const MODELS: { label: string; desc: string }[] = [
  { label: "Claude Opus 4.8", desc: "Deepest reasoning, highest quality" },
  { label: "Claude Sonnet 4.5", desc: "Balanced speed and capability" },
  { label: "Claude Haiku 4.5", desc: "Fastest, lightweight tasks" },
];

const SKILL_CATALOG = [
  "Topic monitoring",
  "Thread summarization",
  "DM auto-response",
  "Intent classification",
  "Knowledge-base lookup",
  "Sentiment triage",
  "Citation linking",
  "Escalation routing",
  "Daily summarization",
  "Highlight ranking",
  "Scheduled posting",
  "Translation",
] as const;

type ToolDef = { id: string; label: string; desc: string };
const TOOL_CATALOG: ToolDef[] = [
  { id: "post", label: "Post", desc: "Publish notes to the network" },
  { id: "reply", label: "Reply", desc: "Respond in post threads" },
  { id: "mention", label: "Mention", desc: "Tag and notify other users" },
  { id: "respond_dm", label: "Respond to DMs", desc: "Answer incoming direct messages" },
  { id: "send_dm", label: "Send DMs", desc: "Start direct conversations" },
  { id: "search_relays", label: "Search relays", desc: "Query the relay network" },
  { id: "search_docs", label: "Search docs", desc: "Look up internal knowledge" },
  { id: "fetch_url", label: "Fetch URL", desc: "Read linked web pages" },
];

type McpDef = { id: string; name: string; detail: string };
const MCP_CATALOG: McpDef[] = [
  { id: "relay_index", name: "Relay Index", detail: "wss://index.aperture.co" },
  { id: "web_search", name: "Web Search", detail: "mcp://search.v2" },
  { id: "help_center", name: "Help Center", detail: "mcp://docs.aperture.co" },
  { id: "ticket_bridge", name: "Ticket Bridge", detail: "mcp://zendesk" },
  { id: "github", name: "GitHub", detail: "mcp://github.com" },
  { id: "calendar", name: "Calendar", detail: "mcp://cal.v1" },
];

const toolDef = (id: string): ToolDef =>
  TOOL_CATALOG.find((t) => t.id === id) ?? { id, label: id, desc: "" };

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const handleFromName = (name: string): string => `${slug(name) || "agent"}@aperture.co`;

const toggleId = (xs: string[], x: string): string[] =>
  xs.includes(x) ? xs.filter((v) => v !== x) : [...xs, x];

const autonomyLabel = (a: Agent["autonomy"]): string =>
  a === "supervised" ? "Supervised" : "Autonomous";

// ───────────────────────── small svg glyphs ─────────────────────────

const BotPath = (): ReactNode => <path d="M12 3v2M5 8h14v9H5zM9 13h.01M15 13h.01" />;

const BotIcon = ({ size, stroke = 2 }: { size: number; stroke?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    <BotPath />
  </svg>
);

const SparkleFill = ({ size }: { size: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z" />
  </svg>
);

const SparkleStroke = ({ size, color }: { size: number; color: string }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z" />
  </svg>
);

const Glyph = ({ size, stroke = 2, path }: { size: number; stroke?: number; path: string }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    <path d={path} />
  </svg>
);

const CheckGlyph = ({ size, stroke = 3, color = "#fff" }: { size: number; stroke?: number; color?: string }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 13 4 4L19 7" />
  </svg>
);

const ACT_ICON: Record<ActivityEvent["type"], string> = {
  post: "M12 5v14M5 12h14",
  reply: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  mention: "M12 2a10 10 0 1 0 4 19m1-9a5 5 0 1 0-1 4c1-1 1-3 1-4z",
  dm: "M4 4h16v12H8l-4 4z",
  follow: "M16 11l2 2 4-4M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a6 6 0 0 1 12 0",
  flag: "M4 21V4M4 4h13l-2 4 2 4H4",
};

// ───────────────────────── status pill ─────────────────────────

const StatusPill = ({ status }: { status: AgentStatus }): ReactNode => {
  const m = agentStatusMeta(status);
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
        background: m.soft,
        color: m.color,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: m.dot }} />
      {m.label}
    </span>
  );
};

// ───────────────────────── avatar w/ bot badge ─────────────────────────

const AgentAvatar = ({
  agent,
  size,
  badge,
  badgeBorder,
}: {
  agent: Pick<Agent, "name" | "avatar">;
  size: number;
  badge: number;
  badgeBorder: string;
}): ReactNode => {
  const badgeRadius = Math.round(badge * 0.32);
  const botSize = Math.round(badge * 0.6);
  return (
    <span style={{ position: "relative", flexShrink: 0, display: "inline-block", width: size, height: size }}>
      <span style={avatarStyle(agent.name, size, agent.avatar ?? undefined)}>
        {!agent.avatar && initials(agent.name)}
      </span>
      <span
        style={{
          position: "absolute",
          right: -3,
          bottom: -3,
          width: badge,
          height: badge,
          borderRadius: badgeRadius,
          background: "var(--accent)",
          border: `2.5px solid ${badgeBorder}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <BotIcon size={botSize} stroke={2.4} />
      </span>
    </span>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  LIST VIEW
// ═══════════════════════════════════════════════════════════════════

const sumActions = (a: Agent): number => a.stats.posts + a.stats.replies + a.stats.dms;

const ListStat = ({
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
        fontFamily: "'Geist',sans-serif",
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

const AgentCard = ({ agent, onOpen }: { agent: Agent; onOpen: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  const handle = agent.handle || shortNpub(agent.pubkeyHex);
  return (
    <button
      type="button"
      data-testid="agent-card"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--glass)",
        border: `1px solid ${hover ? "var(--accent)" : "var(--glass-border)"}`,
        borderRadius: 15,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        transform: hover ? "translateY(-2px)" : "none",
        boxShadow: hover ? "0 10px 30px -16px rgba(0,0,0,.28)" : "none",
        transition: "all .18s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <AgentAvatar agent={agent} size={44} badge={18} badgeBorder="var(--glass)" />
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
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                padding: "2px 6px",
                borderRadius: 6,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                fontSize: 9.5,
                fontWeight: 800,
                letterSpacing: ".04em",
                flexShrink: 0,
              }}
            >
              <SparkleFill size={9} /> AI
            </span>
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-3)",
              fontFamily: "'Geist Mono',monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {handle}
          </div>
        </div>
      </div>

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

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <StatusPill status={agent.status} />
        <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{autonomyLabel(agent.autonomy)}</span>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        {[
          { v: agent.stats.posts, l: "posts" },
          { v: agent.stats.replies, l: "replies" },
          { v: agent.stats.dms, l: "DMs" },
        ].map((s) => (
          <span key={s.l} style={{ fontSize: 12, color: "var(--text-2)" }}>
            <b style={{ color: "var(--text)", fontFamily: "'Geist',sans-serif" }}>{s.v}</b> {s.l}
          </span>
        ))}
      </div>
    </button>
  );
};

const NewAgentCard = ({ onClick }: { onClick: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="agent-card-new"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        minHeight: 200,
        padding: 18,
        borderRadius: 15,
        border: `1.5px dashed ${hover ? "var(--accent)" : "var(--glass-border)"}`,
        background: "transparent",
        color: hover ? "var(--accent)" : "var(--text-3)",
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
        <Glyph size={22} stroke={2.2} path="M12 5v14M5 12h14" />
      </span>
      <span style={{ fontWeight: 700, fontSize: 14 }}>Create a new agent</span>
      <span style={{ fontSize: 12, maxWidth: 200, textAlign: "center", lineHeight: 1.4 }}>
        Give it an identity, skills, tools and MCP connections
      </span>
    </button>
  );
};

const AgentsList = ({
  agents,
  onCreate,
  onOpen,
}: {
  agents: Agent[];
  onCreate: () => void;
  onOpen: (id: string) => void;
}): ReactNode => {
  const [createHover, setCreateHover] = useState(false);
  const activeCount = agents.filter((a) => a.status === "active").length;
  const totalActions = agents.reduce((n, a) => n + sumActions(a), 0);
  const flagCount = agents.reduce(
    (n, a) => n + a.activity.filter((e) => e.flagged && !e.resolved).length,
    0,
  );

  return (
    <div data-testid="view-agents" style={{ maxWidth: 1000, margin: "0 auto", padding: "6px 22px 120px" }}>
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
          <ListStat value={agents.length} label="Agents" />
          <ListStat value={activeCount} label="Active now" color="var(--success)" />
          <ListStat value={totalActions} label="Actions taken" />
          <ListStat value={flagCount} label="Need review" color="var(--warn)" />
        </div>
        <button
          type="button"
          data-testid="create-agent-button"
          onClick={onCreate}
          onMouseEnter={() => setCreateHover(true)}
          onMouseLeave={() => setCreateHover(false)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 18px",
            border: "1px solid var(--accent)",
            borderRadius: 10,
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            fontSize: 14,
            fontFamily: "inherit",
            cursor: "pointer",
            filter: createHover ? "brightness(1.06)" : "none",
            transform: createHover ? "translateY(-1px)" : "none",
            transition: "all .18s",
          }}
        >
          <Glyph size={18} stroke={2.2} path="M12 5v14M5 12h14" /> Create agent
        </button>
      </div>

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
        <NewAgentCard onClick={onCreate} />
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════

type DetailTab = "activity" | "capabilities" | "connections";
type DetailLayout = "timeline" | "dashboard";

const sectionTitle: CSSProperties = {
  margin: "0 0 12px",
  fontFamily: "'Geist',sans-serif",
  fontSize: 15,
  fontWeight: 700,
};

const MetaChip = ({
  children,
  icon,
  capitalize,
}: {
  children: ReactNode;
  icon?: ReactNode;
  capitalize?: boolean;
}): ReactNode => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "5px 11px",
      borderRadius: 8,
      background: "var(--glass-2)",
      fontSize: 12,
      color: "var(--text-2)",
      fontWeight: 600,
      textTransform: capitalize ? "capitalize" : "none",
    }}
  >
    {icon}
    {children}
  </span>
);

const ActIconChip = ({ ev, size }: { ev: ActivityEvent; size: number }): ReactNode => {
  const warn = ev.type === "flag" || ev.flagged;
  return (
    <span
      style={{
        width: 34,
        height: 34,
        minWidth: 34,
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: warn ? "rgba(224,145,31,.13)" : "var(--accent-soft)",
        color: warn ? "var(--warn)" : "var(--accent)",
      }}
    >
      <Glyph size={size} path={ACT_ICON[ev.type]} />
    </span>
  );
};

const NeedsReviewButton = ({
  onClear,
  alignSelf,
}: {
  onClear: () => void;
  alignSelf?: CSSProperties["alignSelf"];
}): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClear();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        alignSelf,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 9px",
        borderRadius: 7,
        border: "1px solid var(--warn)",
        background: hover ? "var(--warn)" : "transparent",
        color: hover ? "#fff" : "var(--warn)",
        fontSize: 11,
        fontWeight: 700,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "all .15s",
      }}
    >
      Needs review · clear
    </button>
  );
};

const ActivityTimeline = ({
  activity,
  onClear,
}: {
  activity: ActivityEvent[];
  onClear: (idx: number) => void;
}): ReactNode => (
  <div data-testid="agent-activity-timeline" style={{ marginTop: 18 }}>
    {activity.map((ev, idx) => (
      <div key={idx} style={{ display: "flex", gap: 13, padding: "14px 0", alignItems: "flex-start" }}>
        <ActIconChip ev={ev} size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--text)" }}>{ev.text}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{ev.time}</span>
            {ev.conf !== undefined && (
              <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                · {Math.round(ev.conf * 100)}% confidence
              </span>
            )}
            {ev.flagged && <NeedsReviewButton onClear={() => onClear(idx)} />}
          </div>
        </div>
      </div>
    ))}
  </div>
);

const ActivityDashboard = ({
  activity,
  onClear,
}: {
  activity: ActivityEvent[];
  onClear: (idx: number) => void;
}): ReactNode => (
  <div
    data-testid="agent-activity-dashboard"
    style={{
      marginTop: 18,
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
      gap: 12,
    }}
  >
    {activity.map((ev, idx) => (
      <div
        key={idx}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 15,
          borderRadius: 13,
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <ActIconChip ev={ev} size={15} />
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{ev.time}</span>
        </div>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--text)" }}>{ev.text}</p>
        {ev.flagged && <NeedsReviewButton onClear={() => onClear(idx)} alignSelf="flex-start" />}
      </div>
    ))}
  </div>
);

const CapabilitiesTab = ({ agent }: { agent: Agent }): ReactNode => (
  <div data-testid="agent-capabilities" style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 24 }}>
    <div>
      <h3 style={sectionTitle}>Skills</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {agent.skills.length === 0 && (
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>No skills configured.</span>
        )}
        {agent.skills.map((sk) => (
          <span
            key={sk}
            style={{
              padding: "8px 14px",
              borderRadius: 9,
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-2)",
            }}
          >
            {sk}
          </span>
        ))}
      </div>
    </div>
    <div>
      <h3 style={sectionTitle}>Tools</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
        {agent.tools.map((id) => {
          const t = toolDef(id);
          return (
            <div
              key={id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "13px 14px",
                borderRadius: 11,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
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
                <Glyph size={16} path="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2.2-.6-.6-2.2z" />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{t.label}</div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.desc}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  </div>
);

const ConnectionsTab = ({ agent }: { agent: Agent }): ReactNode => (
  <div data-testid="agent-connections" style={{ marginTop: 20 }}>
    <h3 style={sectionTitle}>MCP connections</h3>
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {agent.mcps.length === 0 && (
        <span style={{ fontSize: 13, color: "var(--text-3)" }}>No MCP servers connected.</span>
      )}
      {agent.mcps.map((m) => {
        const color = m.status === "degraded" ? "var(--warn)" : "var(--success)";
        const label = m.status === "degraded" ? "Degraded" : "Connected";
        return (
          <div
            key={m.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              padding: "15px 16px",
              borderRadius: 12,
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                minWidth: 38,
                borderRadius: 10,
                background: "var(--glass-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-2)",
              }}
            >
              <Glyph size={18} path="M5 12h14M5 12a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2M5 12a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{m.name}</div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-3)",
                  fontFamily: "'Geist Mono',monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {m.detail}
              </div>
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
              {label}
            </span>
          </div>
        );
      })}
    </div>
  </div>
);

const DetailActionButton = ({
  testid,
  onClick,
  icon,
  label,
  danger,
}: {
  testid: string;
  onClick: () => void;
  icon?: ReactNode;
  label: string;
  danger?: boolean;
}): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        background: hover ? "var(--glass-2)" : "var(--glass)",
        color: danger ? "var(--danger)" : "var(--text)",
        fontWeight: 700,
        fontSize: 13.5,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "all .15s",
      }}
    >
      {icon}
      {label}
    </button>
  );
};

const BackButton = ({ onClick }: { onClick: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="agent-back"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: hover ? 9 : 7,
        padding: 0,
        border: "none",
        background: "transparent",
        color: hover ? "var(--text)" : "var(--text-3)",
        fontWeight: 600,
        fontSize: 13.5,
        fontFamily: "inherit",
        cursor: "pointer",
        marginBottom: 16,
        transition: "all .15s",
      }}
    >
      <Glyph size={17} stroke={2.2} path="m15 18-6-6 6-6" /> All agents
    </button>
  );
};

const CopyNpubButton = ({ npub, onCopy }: { npub: string; onCopy: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="agent-npub"
      onClick={onCopy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: 0,
        border: "none",
        background: "transparent",
        color: hover ? "var(--accent)" : "var(--text-3)",
        fontSize: 12,
        fontFamily: "'Geist Mono',monospace",
        cursor: "pointer",
        transition: "color .15s",
      }}
    >
      <Glyph size={12} path="M9 9h11v11H9zM5 15V5a2 2 0 0 1 2-2h10" /> {npub}
    </button>
  );
};

const AgentDetail = ({
  agent,
  tab,
  setTab,
  onBack,
  onCopyNpub,
  onToggle,
  onEdit,
  onClearFlag,
}: {
  agent: Agent;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onBack: () => void;
  onCopyNpub: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onClearFlag: (idx: number) => void;
}): ReactNode => {
  const [layout, setLayout] = useState<DetailLayout>("timeline");
  const isActive = agent.status === "active";

  const stats: { value: string | number; label: string }[] = [
    { value: agent.stats.posts, label: "Posts" },
    { value: agent.stats.replies, label: "Replies" },
    { value: agent.stats.dms, label: "DMs" },
    { value: agent.stats.mentions, label: "Mentions" },
    { value: agent.stats.followers, label: "Followers" },
    { value: agent.status === "paused" ? "paused" : agent.stats.uptime, label: "Uptime" },
  ];

  return (
    <div data-testid="view-agent-detail" style={{ maxWidth: 1000, margin: "0 auto", padding: "14px 22px 120px" }}>
      <BackButton onClick={onBack} />

      {/* identity band */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
        <AgentAvatar agent={agent} size={72} badge={26} badgeBorder="var(--glass-strong)" />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h2
              style={{
                margin: 0,
                fontFamily: "'Geist',sans-serif",
                fontSize: 24,
                fontWeight: 700,
                letterSpacing: "-.02em",
              }}
            >
              {agent.name}
            </h2>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 9px",
                borderRadius: 7,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: ".04em",
              }}
            >
              <SparkleFill size={11} /> AI AGENT
            </span>
            <StatusPill status={agent.status} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, color: "var(--text-3)", fontFamily: "'Geist Mono',monospace" }}>
              {agent.handle || shortNpub(agent.pubkeyHex)}
            </span>
            <CopyNpubButton npub={shortNpub(agent.pubkeyHex)} onCopy={onCopyNpub} />
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
            <MetaChip icon={<SparkleStroke size={13} color="var(--accent)" />}>{agent.model}</MetaChip>
            <MetaChip capitalize>
              {agent.persona} · {agent.tone}
            </MetaChip>
            <MetaChip>{autonomyLabel(agent.autonomy)}</MetaChip>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <DetailActionButton
            testid="agent-edit"
            onClick={onEdit}
            icon={<Glyph size={16} path="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />}
            label="Edit"
          />
          <DetailActionButton
            testid="agent-toggle"
            onClick={onToggle}
            icon={
              isActive ? (
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x={6} y={5} width={4} height={14} rx={1} />
                  <rect x={14} y={5} width={4} height={14} rx={1} />
                </svg>
              ) : undefined
            }
            label={isActive ? "Pause" : "Resume"}
          />
        </div>
      </div>

      {/* stat dashboard */}
      <div
        data-testid="agent-stats"
        style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, marginTop: 22 }}
      >
        {stats.map((st) => (
          <div
            key={st.label}
            style={{
              padding: 14,
              borderRadius: 12,
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
            }}
          >
            <div style={{ fontFamily: "'Geist',sans-serif", fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
              {st.value}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 5 }}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* tabs + layout switcher */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 24,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div role="tablist" style={{ display: "flex", gap: 22 }}>
          <button type="button" role="tab" data-testid="atab-activity" onClick={() => setTab("activity")} style={agentTabStyle(tab === "activity")}>
            Activity
          </button>
          <button type="button" role="tab" data-testid="atab-capabilities" onClick={() => setTab("capabilities")} style={agentTabStyle(tab === "capabilities")}>
            Capabilities
          </button>
          <button type="button" role="tab" data-testid="atab-connections" onClick={() => setTab("connections")} style={agentTabStyle(tab === "connections")}>
            Connections
          </button>
        </div>
        {tab === "activity" && (
          <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 10, background: "var(--glass-2)", marginBottom: 8 }}>
            <button type="button" data-testid="layout-timeline" onClick={() => setLayout("timeline")} style={segStyle(layout === "timeline")}>
              Timeline
            </button>
            <button type="button" data-testid="layout-dashboard" onClick={() => setLayout("dashboard")} style={segStyle(layout === "dashboard")}>
              Dashboard
            </button>
          </div>
        )}
      </div>

      {tab === "activity" &&
        (layout === "timeline" ? (
          <ActivityTimeline activity={agent.activity} onClear={onClearFlag} />
        ) : (
          <ActivityDashboard activity={agent.activity} onClear={onClearFlag} />
        ))}
      {tab === "capabilities" && <CapabilitiesTab agent={agent} />}
      {tab === "connections" && <ConnectionsTab agent={agent} />}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  CREATE / EDIT WIZARD
// ═══════════════════════════════════════════════════════════════════

type WizardVariant = "wizard" | "page";

type WizardForm = {
  name: string;
  handle: string;
  handleEdited: boolean;
  persona: string;
  tone: string;
  model: string;
  skills: string[];
  tools: string[];
  mcps: string[];
  autonomy: "autonomous" | "supervised";
  avatar: string | null;
};

const emptyForm = (): WizardForm => ({
  name: "",
  handle: "",
  handleEdited: false,
  persona: "curious",
  tone: "concise",
  model: "Claude Sonnet 4.5",
  skills: [],
  tools: ["post", "reply"],
  mcps: [],
  autonomy: "autonomous",
  avatar: null,
});

const formFromAgent = (a: Agent): WizardForm => ({
  name: a.name,
  handle: a.handle,
  handleEdited: true,
  persona: a.persona,
  tone: a.tone,
  model: a.model,
  skills: a.skills,
  tools: a.tools,
  mcps: a.mcps.flatMap((m) => {
    const def = MCP_CATALOG.find((c) => c.name === m.name);
    return def ? [def.id] : [];
  }),
  autonomy: a.autonomy,
  avatar: a.avatar,
});

const WIZARD_STEPS = ["Identity", "Persona", "Capabilities", "Connections", "Review"] as const;

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
  marginBottom: 6,
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

const WizardInput = ({
  testid,
  value,
  onChange,
  placeholder,
  mono,
  marginBottom,
}: {
  testid: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  mono?: boolean;
  marginBottom?: number;
}): ReactNode => {
  const [focus, setFocus] = useState(false);
  return (
    <input
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      placeholder={placeholder}
      style={{
        ...inputStyle,
        marginBottom,
        fontFamily: mono ? "'Geist Mono',monospace" : "inherit",
        borderColor: focus ? "var(--accent)" : "var(--glass-border)",
      }}
    />
  );
};

const SectionHeader = ({ children }: { children: ReactNode }): ReactNode => (
  <div
    style={{
      fontFamily: "'Geist',sans-serif",
      fontSize: 14,
      fontWeight: 700,
      color: "var(--text-3)",
      textTransform: "uppercase",
      letterSpacing: ".05em",
      marginBottom: 14,
    }}
  >
    {children}
  </div>
);

const RemovePhotoButton = ({ onClick }: { onClick: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="wizard-avatar-remove"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        marginTop: 6,
        padding: 0,
        border: "none",
        background: "transparent",
        color: hover ? "var(--text)" : "var(--text-3)",
        fontSize: 12,
        fontWeight: 700,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "color .15s",
      }}
    >
      Remove photo
    </button>
  );
};

const IdentitySection = ({
  form,
  setForm,
  onAvatar,
  onRemoveAvatar,
  withHeader,
}: {
  form: WizardForm;
  setForm: (fn: (p: WizardForm) => WizardForm) => void;
  onAvatar: (file: File) => void;
  onRemoveAvatar: () => void;
  withHeader: boolean;
}): ReactNode => (
  <div style={{ marginBottom: 26 }}>
    {withHeader && <SectionHeader>Identity</SectionHeader>}
    <div style={{ display: "flex", alignItems: "center", gap: 15, marginBottom: 16 }}>
      <label
        data-testid="wizard-avatar-upload"
        title="Upload a photo"
        style={{ position: "relative", flexShrink: 0, cursor: "pointer", display: "block" }}
      >
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAvatar(file);
          }}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
        <span style={avatarStyle(form.name || "Agent", 56, form.avatar ?? undefined)}>
          {!form.avatar && initials(form.name || "Agent")}
        </span>
        <span
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            width: 22,
            height: 22,
            borderRadius: 7,
            background: "var(--accent)",
            border: "2.5px solid var(--glass-strong)",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h8l2 3h3a2 2 0 0 1 2 2z" />
            <circle cx={12} cy={13} r={3.5} />
          </svg>
        </span>
      </label>
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.5 }}>
          Your agent gets its own keypair and verified handle the moment it launches. Tap the avatar to add a photo.
        </p>
        {form.avatar && <RemovePhotoButton onClick={onRemoveAvatar} />}
      </div>
    </div>

    <label style={fieldLabel}>Name</label>
    <WizardInput
      testid="wizard-name"
      value={form.name}
      onChange={(name) =>
        setForm((p) => ({ ...p, name, handle: p.handleEdited ? p.handle : handleFromName(name) }))
      }
      placeholder="e.g. Release Notes Bot"
      marginBottom={14}
    />
    <label style={fieldLabel}>Handle</label>
    <WizardInput
      testid="wizard-handle"
      value={form.handle}
      onChange={(handle) => setForm((p) => ({ ...p, handle: handle.replace(/\s/g, ""), handleEdited: true }))}
      placeholder="bot@aperture.co"
      mono
    />
  </div>
);

const ModelRow = ({
  model,
  selected,
  onClick,
}: {
  model: { label: string; desc: string };
  selected: boolean;
  onClick: () => void;
}): ReactNode => (
  <button type="button" onClick={onClick} style={rowSelectStyle(selected)}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{model.label}</div>
      <div style={{ fontSize: 12, color: "var(--text-3)" }}>{model.desc}</div>
    </div>
    {selected && <CheckGlyph size={18} stroke={2.4} color="var(--accent)" />}
  </button>
);

const PersonaSection = ({
  form,
  setForm,
  withHeader,
}: {
  form: WizardForm;
  setForm: (fn: (p: WizardForm) => WizardForm) => void;
  withHeader: boolean;
}): ReactNode => (
  <div style={{ marginBottom: 26 }}>
    {withHeader && <SectionHeader>Persona</SectionHeader>}
    <label style={{ ...fieldLabel, marginBottom: 9 }}>Personality</label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
      {PERSONAS.map((p) => (
        <button key={p} type="button" onClick={() => setForm((f) => ({ ...f, persona: p }))} style={chipSelectStyle(form.persona === p)}>
          {p}
        </button>
      ))}
    </div>
    <label style={{ ...fieldLabel, marginBottom: 9 }}>Tone of voice</label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
      {TONES.map((t) => (
        <button key={t} type="button" onClick={() => setForm((f) => ({ ...f, tone: t }))} style={chipSelectStyle(form.tone === t)}>
          {t}
        </button>
      ))}
    </div>
    <label style={{ ...fieldLabel, marginBottom: 9 }}>Model</label>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {MODELS.map((m) => (
        <ModelRow key={m.label} model={m} selected={form.model === m.label} onClick={() => setForm((f) => ({ ...f, model: m.label }))} />
      ))}
    </div>
  </div>
);

const CheckRow = ({
  selected,
  onClick,
  title,
  desc,
  mono,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  mono?: boolean;
}): ReactNode => (
  <button type="button" onClick={onClick} style={rowSelectStyle(selected)}>
    <span style={checkBoxStyle(selected)}>{selected && <CheckGlyph size={13} />}</span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{title}</div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-3)",
          fontFamily: mono ? "'Geist Mono',monospace" : "inherit",
          overflow: mono ? "hidden" : "visible",
          textOverflow: mono ? "ellipsis" : "clip",
          whiteSpace: mono ? "nowrap" : "normal",
        }}
      >
        {desc}
      </div>
    </div>
  </button>
);

const CapabilitiesSection = ({
  form,
  setForm,
  withHeader,
}: {
  form: WizardForm;
  setForm: (fn: (p: WizardForm) => WizardForm) => void;
  withHeader: boolean;
}): ReactNode => (
  <div style={{ marginBottom: 26 }}>
    {withHeader && <SectionHeader>Capabilities</SectionHeader>}
    <label style={{ ...fieldLabel, marginBottom: 9 }}>Skills</label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
      {SKILL_CATALOG.map((s) => (
        <button key={s} type="button" onClick={() => setForm((f) => ({ ...f, skills: toggleId(f.skills, s) }))} style={chipSelectStyle(form.skills.includes(s))}>
          {s}
        </button>
      ))}
    </div>
    <label style={{ ...fieldLabel, marginBottom: 9 }}>Tools the agent can use</label>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {TOOL_CATALOG.map((t) => (
        <CheckRow
          key={t.id}
          selected={form.tools.includes(t.id)}
          onClick={() => setForm((f) => ({ ...f, tools: toggleId(f.tools, t.id) }))}
          title={t.label}
          desc={t.desc}
        />
      ))}
    </div>
  </div>
);

const ConnectionsSection = ({
  form,
  setForm,
  withHeader,
}: {
  form: WizardForm;
  setForm: (fn: (p: WizardForm) => WizardForm) => void;
  withHeader: boolean;
}): ReactNode => (
  <div style={{ marginBottom: 26 }}>
    {withHeader && <SectionHeader>Connections</SectionHeader>}
    <label style={{ ...fieldLabel, marginBottom: 4 }}>MCP servers</label>
    <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-3)" }}>
      Connect external context and tools through the Model Context Protocol.
    </p>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {MCP_CATALOG.map((m) => (
        <CheckRow
          key={m.id}
          selected={form.mcps.includes(m.id)}
          onClick={() => setForm((f) => ({ ...f, mcps: toggleId(f.mcps, m.id) }))}
          title={m.name}
          desc={m.detail}
          mono
        />
      ))}
    </div>
  </div>
);

const ReviewCell = ({
  label,
  value,
  full,
  capitalize,
}: {
  label: string;
  value: string;
  full?: boolean;
  capitalize?: boolean;
}): ReactNode => (
  <div style={{ padding: 13, borderRadius: 11, background: "var(--glass-2)", gridColumn: full ? "1 / -1" : undefined }}>
    <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 3 }}>{label}</div>
    <div style={{ fontWeight: 700, fontSize: 13.5, textTransform: capitalize ? "capitalize" : "none" }}>{value}</div>
  </div>
);

const ReviewSection = ({ form }: { form: WizardForm }): ReactNode => {
  const handle = form.handle || handleFromName(form.name);
  return (
    <div data-testid="wizard-review" style={{ marginBottom: 26 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: 16,
          borderRadius: 13,
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
          marginBottom: 14,
        }}
      >
        <span style={{ position: "relative", flexShrink: 0 }}>
          <span style={avatarStyle(form.name || "Agent", 40, form.avatar ?? undefined)}>
            {!form.avatar && initials(form.name || "Agent")}
          </span>
          <span
            style={{
              position: "absolute",
              right: -3,
              bottom: -3,
              width: 20,
              height: 20,
              borderRadius: 7,
              background: "var(--accent)",
              border: "2.5px solid var(--glass)",
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <BotIcon size={11} stroke={2.4} />
          </span>
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, fontFamily: "'Geist',sans-serif" }}>
            {form.name || "New Agent"}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)", fontFamily: "'Geist Mono',monospace" }}>{handle}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <ReviewCell label="Model" value={form.model} />
        <ReviewCell label="Persona" value={`${form.persona} · ${form.tone}`} capitalize />
        <ReviewCell label="Skills" value={`${form.skills.length} selected`} />
        <ReviewCell label="Tools" value={`${form.tools.length} enabled`} />
        <ReviewCell label="MCP connections" value={`${form.mcps.length} connected`} full />
      </div>
    </div>
  );
};

const wizardNextStyle = (disabled: boolean): CSSProperties => ({
  padding: "11px 22px",
  border: "1px solid var(--accent)",
  borderRadius: 10,
  background: "var(--accent)",
  color: "var(--on-accent)",
  fontWeight: 700,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1,
  transition: "all .15s",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
});

const StepperButton = ({
  index,
  current,
  label,
  onClick,
}: {
  index: number;
  current: number;
  label: string;
  onClick: () => void;
}): ReactNode => {
  const done = index < current;
  const active = index === current;
  const dotStyle: CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
    ...(done
      ? { background: "var(--accent)", color: "#fff" }
      : active
        ? { background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent)" }
        : { background: "var(--glass-2)", color: "var(--text-3)" }),
  };
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "transparent", cursor: "pointer", flexShrink: 0, padding: 0 }}
    >
      <span style={dotStyle}>{done ? <CheckGlyph size={13} stroke={3} /> : index + 1}</span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: active ? 700 : 600,
          color: active || done ? "var(--text)" : "var(--text-3)",
        }}
      >
        {label}
      </span>
    </button>
  );
};

const HeaderClose = ({ onClick }: { onClick: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="wizard-close"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        padding: 7,
        border: "none",
        borderRadius: 8,
        background: hover ? "var(--glass-2)" : "transparent",
        color: hover ? "var(--text)" : "var(--text-3)",
        cursor: "pointer",
        transition: "all .15s",
      }}
    >
      <Glyph size={18} stroke={2} path="M18 6 6 18M6 6l12 12" />
    </button>
  );
};

const FooterBackButton = ({ onClick }: { onClick: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="wizard-back"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "11px 18px",
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        background: hover ? "var(--glass-2)" : "transparent",
        color: "var(--text)",
        fontWeight: 700,
        fontSize: 14,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "all .15s",
      }}
    >
      Back
    </button>
  );
};

const AgentWizard = ({
  mode,
  initial,
  onClose,
  onSubmit,
  onInfo,
}: {
  mode: "create" | "edit";
  initial: WizardForm;
  onClose: () => void;
  onSubmit: (f: WizardForm) => void;
  onInfo: (msg: string) => void;
}): ReactNode => {
  const [form, setFormState] = useState<WizardForm>(initial);
  const [variant, setVariant] = useState<WizardVariant>(mode === "edit" ? "page" : "wizard");
  const [step, setStep] = useState(0);

  const setForm = (fn: (p: WizardForm) => WizardForm): void => setFormState(fn);

  const stepped = variant === "wizard";
  const clamp = (n: number): number => Math.max(0, Math.min(4, n));
  const goStep = (i: number): void => setStep(clamp(i));

  const switchVariant = (v: WizardVariant): void => {
    setVariant(v);
    setStep(0);
  };

  const canContinue = step !== 0 || (form.name.trim().length > 0 && form.handle.trim().length > 0);
  const blocked = !canContinue;

  const onAvatar = (file: File): void => {
    if (!file.type.startsWith("image/")) {
      onInfo("Please choose an image file");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setForm((p) => ({ ...p, avatar: reader.result as string }));
    };
    reader.readAsDataURL(file);
  };

  const showBack = stepped && step > 0;
  const showNext = stepped && step < 4;
  const showLaunch = stepped ? step === 4 : true;
  const primaryLabel = mode === "create" ? "Launch agent" : "Save changes";

  return (
    <div
      data-testid="modal-wizard"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,10,25,.45)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        zIndex: 55,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        animation: "beamhop-fade .15s",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 600,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--glass-strong)",
          border: "1px solid var(--glass-border)",
          borderRadius: 16,
          boxShadow: "var(--glass-shadow-lg)",
          overflow: "hidden",
          animation: "beamhop-scale .18s cubic-bezier(.2,.9,.3,1)",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px", borderBottom: "1px solid var(--hairline)" }}>
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
            <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <BotPath />
            </svg>
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontFamily: "'Geist',sans-serif", fontSize: 17, fontWeight: 700 }}>
              {mode === "create" ? "Create agent" : "Edit agent"}
            </h3>
            <p style={{ margin: "1px 0 0", fontSize: 12, color: "var(--text-3)" }}>
              Give it an identity, skills, tools and MCP connections
            </p>
          </div>
          <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 9, background: "var(--glass-2)" }}>
            <button type="button" data-testid="wizard-var-wizard" onClick={() => switchVariant("wizard")} style={segStyle(variant === "wizard")}>
              Guided
            </button>
            <button type="button" data-testid="wizard-var-page" onClick={() => switchVariant("page")} style={segStyle(variant === "page")}>
              Single page
            </button>
          </div>
          <HeaderClose onClick={onClose} />
        </div>

        {/* stepper */}
        {stepped && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "16px 20px 4px", overflowX: "auto" }}>
            {WIZARD_STEPS.map((label, i) => (
              <StepperButton key={label} index={i} current={step} label={label} onClick={() => goStep(i)} />
            ))}
          </div>
        )}

        {/* body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {stepped ? (
            <>
              {step === 0 && (
                <IdentitySection form={form} setForm={setForm} onAvatar={onAvatar} onRemoveAvatar={() => setForm((p) => ({ ...p, avatar: null }))} withHeader={false} />
              )}
              {step === 1 && <PersonaSection form={form} setForm={setForm} withHeader={false} />}
              {step === 2 && <CapabilitiesSection form={form} setForm={setForm} withHeader={false} />}
              {step === 3 && <ConnectionsSection form={form} setForm={setForm} withHeader={false} />}
              {step === 4 && <ReviewSection form={form} />}
            </>
          ) : (
            <>
              <IdentitySection form={form} setForm={setForm} onAvatar={onAvatar} onRemoveAvatar={() => setForm((p) => ({ ...p, avatar: null }))} withHeader />
              <PersonaSection form={form} setForm={setForm} withHeader />
              <CapabilitiesSection form={form} setForm={setForm} withHeader />
              <ConnectionsSection form={form} setForm={setForm} withHeader />
            </>
          )}
        </div>

        {/* footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", borderTop: "1px solid var(--hairline)" }}>
          {showBack && <FooterBackButton onClick={() => goStep(step - 1)} />}
          <div style={{ flex: 1 }} />
          {showNext && (
            <button
              type="button"
              data-testid="wizard-next"
              onClick={() => !blocked && goStep(step + 1)}
              style={wizardNextStyle(blocked)}
            >
              Continue
            </button>
          )}
          {showLaunch && (
            <button
              type="button"
              data-testid="wizard-launch"
              onClick={() => !blocked && onSubmit(form)}
              style={wizardNextStyle(blocked)}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Glyph size={16} stroke={2.2} path="M5 12h14M13 6l6 6-6 6" />
                {primaryLabel}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  ROOT VIEW
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_BIO = "A new agent you own — acting on the network on your behalf.";

export const AgentsView = (): ReactNode => {
  const { state, navigate, goBack, toast } = useStore();
  const [agents, setAgents] = useState<Agent[]>(() => loadAgents());
  const [wizard, setWizard] = useState<"create" | "edit" | null>(null);

  const view = state.nav.view;
  const detailId = state.nav.params.id;
  const detailTab: DetailTab =
    state.nav.params.agentTab === "capabilities"
      ? "capabilities"
      : state.nav.params.agentTab === "connections"
        ? "connections"
        : "activity";

  const persist = (next: Agent[]): void => {
    saveAgents(next);
    setAgents(next);
  };

  const detailAgent = useMemo(
    () => (detailId ? agents.find((a) => a.id === detailId) : undefined),
    [agents, detailId],
  );

  const setDetailTab = (t: DetailTab): void => {
    if (!detailAgent) return;
    navigate("agentDetail", { id: detailAgent.id, agentTab: t });
  };

  const launchAgent = (f: WizardForm): void => {
    const sk = generateSecretKey();
    const pubkeyHex = getPublicKey(sk);
    const name = f.name.trim() || "New Agent";
    const handle = f.handle.trim() || handleFromName(name);
    const mcps: Mcp[] = f.mcps.flatMap((id) => {
      const def = MCP_CATALOG.find((c) => c.id === id);
      return def ? [{ name: def.name, status: "connected" as const, detail: def.detail }] : [];
    });
    const agent: Agent = {
      id: `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      handle,
      npub: nip19.npubEncode(pubkeyHex),
      pubkeyHex,
      secretHex: bytesToHex(sk),
      status: "active",
      autonomy: f.autonomy,
      persona: f.persona,
      tone: f.tone,
      model: f.model,
      bio: DEFAULT_BIO,
      avatar: f.avatar,
      skills: f.skills,
      tools: f.tools,
      mcps,
      stats: { posts: 0, replies: 0, dms: 0, mentions: 0, followers: 0, uptime: "new" },
      activity: [
        {
          type: "flag",
          text: "Agent created and joined the network. It will appear here as it acts.",
          time: "just now",
          flagged: false,
        },
      ],
      createdAt: Date.now(),
    };
    persist([agent, ...agents]);
    setWizard(null);
    setTimeout(() => toast(`${agent.name} is live on the network`, "check"), 0);
    navigate("agentDetail", { id: agent.id, agentTab: "activity" });
  };

  const saveAgentEdits = (f: WizardForm): void => {
    if (!detailAgent) return;
    const name = f.name.trim() || detailAgent.name;
    const mcps: Mcp[] = f.mcps.flatMap((id) => {
      const def = MCP_CATALOG.find((c) => c.id === id);
      return def ? [{ name: def.name, status: "connected" as const, detail: def.detail }] : [];
    });
    const next = agents.map((a) =>
      a.id === detailAgent.id
        ? {
            ...a,
            name,
            handle: f.handle.trim() || handleFromName(name),
            persona: f.persona,
            tone: f.tone,
            model: f.model,
            skills: f.skills,
            tools: f.tools,
            mcps,
            avatar: f.avatar,
          }
        : a,
    );
    persist(next);
    setWizard(null);
    toast("Agent updated", "check");
  };

  const copyNpub = (npub: string): void => {
    void navigator.clipboard?.writeText(npub);
    toast("Public key copied to clipboard", "copy");
  };

  const toggleStatus = (a: Agent): void => {
    const nextStatus: AgentStatus = a.status === "active" ? "paused" : "active";
    persist(agents.map((x) => (x.id === a.id ? { ...x, status: nextStatus } : x)));
    toast(
      nextStatus === "active"
        ? "Agent resumed — now acting autonomously"
        : "Agent paused — it will stop acting",
      "check",
    );
  };

  const clearFlag = (agentId: string, idx: number): void => {
    persist(
      agents.map((a) =>
        a.id === agentId
          ? { ...a, activity: a.activity.map((e, i) => (i === idx ? { ...e, flagged: false, resolved: true } : e)) }
          : a,
      ),
    );
    toast("Flag cleared", "check");
  };

  if (view === "agentDetail") {
    if (!detailAgent) {
      return (
        <div data-testid="view-agent-detail" style={{ maxWidth: 1000, margin: "0 auto", padding: "14px 22px 120px" }}>
          <BackButton onClick={goBack} />
          <p style={{ fontSize: 14, color: "var(--text-3)" }}>This agent was not found. It may have been deleted.</p>
        </div>
      );
    }
    return (
      <>
        <AgentDetail
          agent={detailAgent}
          tab={detailTab}
          setTab={setDetailTab}
          onBack={goBack}
          onCopyNpub={() => copyNpub(detailAgent.npub)}
          onToggle={() => toggleStatus(detailAgent)}
          onEdit={() => setWizard("edit")}
          onClearFlag={(idx) => clearFlag(detailAgent.id, idx)}
        />
        {wizard === "edit" && (
          <AgentWizard
            mode="edit"
            initial={formFromAgent(detailAgent)}
            onClose={() => setWizard(null)}
            onSubmit={saveAgentEdits}
            onInfo={(msg) => toast(msg, "info")}
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
        onOpen={(id) => navigate("agentDetail", { id, agentTab: "activity" })}
      />
      {wizard === "create" && (
        <AgentWizard
          mode="create"
          initial={emptyForm()}
          onClose={() => setWizard(null)}
          onSubmit={launchAgent}
          onInfo={(msg) => toast(msg, "info")}
        />
      )}
    </>
  );
};
