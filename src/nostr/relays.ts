import type { RelayInfo } from "./types.ts";

const STORAGE_KEY = "verity.relays.v1";

/** A sensible default relay set with broad reach and good uptime. */
export const DEFAULT_RELAYS: readonly RelayInfo[] = [
  { url: "wss://relay.damus.io", enabled: true, read: true, write: true, status: "disconnected" },
  { url: "wss://nos.lol", enabled: true, read: true, write: true, status: "disconnected" },
  { url: "wss://relay.nostr.band", enabled: true, read: true, write: true, status: "disconnected" },
  { url: "wss://relay.primal.net", enabled: true, read: true, write: true, status: "disconnected" },
  { url: "wss://nostr.wine", enabled: true, read: true, write: false, status: "disconnected" },
];

const normalizeStoredRelay = (relay: unknown): RelayInfo | null => {
  if (!relay || typeof relay !== "object") return null;
  const candidate = relay as Record<string, unknown>;
  if (typeof candidate.url !== "string" || candidate.url.trim() === "") return null;
  return {
    url: candidate.url,
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    read: typeof candidate.read === "boolean" ? candidate.read : true,
    write: typeof candidate.write === "boolean" ? candidate.write : true,
    status: "disconnected",
  };
};

export const loadRelays = (): RelayInfo[] => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_RELAYS.map((r) => ({ ...r }));
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("empty");
    const relays = parsed
      .map(normalizeStoredRelay)
      .filter((relay): relay is RelayInfo => relay !== null);
    if (relays.length === 0) throw new Error("empty");
    return relays;
  } catch {
    return DEFAULT_RELAYS.map((r) => ({ ...r }));
  }
};

export const saveRelays = (relays: RelayInfo[]): void =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(relays));

export const readRelays = (relays: RelayInfo[]): string[] =>
  relays.filter((r) => r.enabled && r.read).map((r) => r.url);

export const writeRelays = (relays: RelayInfo[]): string[] =>
  relays.filter((r) => r.enabled && r.write).map((r) => r.url);

export const normalizeRelayUrl = (input: string): string => {
  let url = input.trim();
  if (!/^wss?:\/\//.test(url)) url = `wss://${url}`;
  return url.replace(/\/+$/, "");
};
