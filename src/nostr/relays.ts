import type { RelayInfo } from "./types.ts";

const STORAGE_KEY = "verity.relays.v1";

/** A sensible default relay set with broad reach and good uptime. */
export const DEFAULT_RELAYS: readonly RelayInfo[] = [
  { url: "wss://relay.damus.io", read: true, write: true, status: "disconnected" },
  { url: "wss://nos.lol", read: true, write: true, status: "disconnected" },
  { url: "wss://relay.nostr.band", read: true, write: true, status: "disconnected" },
  { url: "wss://relay.primal.net", read: true, write: true, status: "disconnected" },
  { url: "wss://nostr.wine", read: true, write: false, status: "disconnected" },
];

export const loadRelays = (): RelayInfo[] => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_RELAYS.map((r) => ({ ...r }));
  try {
    const parsed = JSON.parse(raw) as RelayInfo[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty");
    return parsed.map((r) => ({ ...r, status: "disconnected" as const }));
  } catch {
    return DEFAULT_RELAYS.map((r) => ({ ...r }));
  }
};

export const saveRelays = (relays: RelayInfo[]): void =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(relays));

export const readRelays = (relays: RelayInfo[]): string[] =>
  relays.filter((r) => r.read).map((r) => r.url);

export const writeRelays = (relays: RelayInfo[]): string[] =>
  relays.filter((r) => r.write).map((r) => r.url);

export const normalizeRelayUrl = (input: string): string => {
  let url = input.trim();
  if (!/^wss?:\/\//.test(url)) url = `wss://${url}`;
  return url.replace(/\/+$/, "");
};
