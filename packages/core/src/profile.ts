import { Kind } from './types.js';
import type { NostrEvent, Profile, ProfileMetadata } from './types.js';

/** Parse a kind 0 event into a structured Profile. Returns null if invalid. */
export function parseProfile(event: NostrEvent): Profile | null {
  if (event.kind !== Kind.Metadata) return null;
  try {
    const metadata = JSON.parse(event.content) as ProfileMetadata;
    if (typeof metadata !== 'object' || metadata === null) return null;
    return { pubkey: event.pubkey, metadata, createdAt: event.created_at };
  } catch {
    return null;
  }
}

/** Best-effort human display name from profile metadata. */
export function displayName(profile: Profile | undefined, fallback: string): string {
  const m = profile?.metadata;
  return m?.display_name?.trim() || m?.name?.trim() || fallback;
}

/** Build the content + kind for a kind 0 metadata event. */
export function buildProfileContent(metadata: ProfileMetadata): string {
  // Strip undefined values so we publish a clean object.
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== '') clean[key] = value;
  }
  return JSON.stringify(clean);
}
