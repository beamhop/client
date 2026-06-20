import { useEffect, useMemo, useRef, useState } from "react";
import type { Filter } from "nostr-tools";
import { useStore } from "./store.tsx";
import { Kind, type Note } from "../nostr/types.ts";
import { decodeNote } from "../nostr/events.ts";

/** Live-subscribe to a feed of notes (kind 1) matching the given filter. */
export const useFeed = (filter: Filter, deps: unknown[]): { notes: Note[]; loading: boolean } => {
  const { client, readRelayUrls } = useStore();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  // Stable filter identity across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableFilter = useMemo(() => filter, deps);

  useEffect(() => {
    if (readRelayUrls.length === 0) return;
    setLoading(true);
    setNotes([]);
    const byId = new Map<string, Note>();
    const flush = () => setNotes([...byId.values()].sort((a, b) => b.createdAt - a.createdAt));
    const unsub = client.subscribe(
      readRelayUrls,
      stableFilter,
      (event) => {
        if (event.kind !== Kind.Note) return;
        if (byId.has(event.id)) return;
        byId.set(event.id, decodeNote(event));
        flush();
      },
      () => setLoading(false),
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, readRelayUrls, stableFilter]);

  return { notes, loading };
};

export type Engagement = {
  likes: number;
  reposts: number;
  replies: number;
  liked: boolean;
  reposted: boolean;
};

const empty: Engagement = { likes: 0, reposts: 0, replies: 0, liked: false, reposted: false };

/** Fetch like/repost/reply counts for a batch of notes in a single query. */
export const useEngagement = (
  noteIds: string[],
  optimistic: Record<string, Partial<Engagement>> = {},
): Map<string, Engagement> => {
  const { client, readRelayUrls, state } = useStore();
  const [map, setMap] = useState<Map<string, Engagement>>(new Map());
  const key = noteIds.join(",");
  const me = state.identity?.pubkey;
  const lastKey = useRef("");

  useEffect(() => {
    if (noteIds.length === 0 || readRelayUrls.length === 0) return;
    if (lastKey.current === key) return;
    lastKey.current = key;
    let cancelled = false;
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.Reaction, Kind.Repost, Kind.Note],
        "#e": noteIds,
      });
      if (cancelled) return;
      const next = new Map<string, Engagement>();
      for (const id of noteIds) next.set(id, { ...empty });
      for (const ev of events) {
        const target = [...ev.tags].reverse().find((t) => t[0] === "e")?.[1];
        const cur = target ? next.get(target) : undefined;
        if (!cur) continue;
        if (ev.kind === Kind.Reaction && ev.content !== "-") {
          cur.likes++;
          if (ev.pubkey === me) cur.liked = true;
        } else if (ev.kind === Kind.Repost) {
          cur.reposts++;
          if (ev.pubkey === me) cur.reposted = true;
        } else if (ev.kind === Kind.Note) {
          cur.replies++;
        }
      }
      setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, key, me, noteIds]);

  // Merge optimistic overrides without refetching.
  return useMemo(() => {
    const merged = new Map<string, Engagement>();
    for (const id of noteIds) {
      const base = map.get(id) ?? empty;
      merged.set(id, { ...base, ...optimistic[id] });
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, JSON.stringify(optimistic)]);
};
