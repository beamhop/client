/**
 * A local activity/audit log. Nostr has no native audit trail, so Verity keeps
 * a client-side log of security-relevant actions (key access, profile updates,
 * DM decryption, logins). Persisted per-identity in localStorage.
 */
export type AuditType = 'key' | 'dm' | 'profile' | 'device' | 'backup' | 'verify' | 'post';

export interface AuditEntry {
  readonly id: string;
  readonly type: AuditType;
  readonly event: string;
  readonly detail: string;
  readonly at: number;
}

const KEY_PREFIX = 'verity:audit:';
const MAX_ENTRIES = 200;

function storageKey(pubkey: string): string {
  return `${KEY_PREFIX}${pubkey}`;
}

export function loadAudit(pubkey: string): AuditEntry[] {
  const raw = localStorage.getItem(storageKey(pubkey));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AuditEntry[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return [];
}

export function appendAudit(
  pubkey: string,
  entry: Omit<AuditEntry, 'id' | 'at'>,
): AuditEntry[] {
  const full: AuditEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  };
  const next = [full, ...loadAudit(pubkey)].slice(0, MAX_ENTRIES);
  localStorage.setItem(storageKey(pubkey), JSON.stringify(next));
  return next;
}

/** Serialize the audit log to CSV for compliance export. */
export function auditToCsv(entries: readonly AuditEntry[]): string {
  const header = 'timestamp,type,event,detail';
  const rows = entries.map((e) => {
    const ts = new Date(e.at).toISOString();
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    return [esc(ts), esc(e.type), esc(e.event), esc(e.detail)].join(',');
  });
  return [header, ...rows].join('\n');
}
