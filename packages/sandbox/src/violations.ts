/** A sandbox violation, expressed as the rule that would have allowed it. */
export interface Violation {
  kind: 'net.allow' | 'fs.read' | 'fs.write';
  value: string;
  /** Raw srt line (diagnostic; attacker-influenced, never use it for policy decisions). */
  raw?: string;
  /** True when learning mode let the operation through. */
  allowed?: boolean;
}

const stripPort = (hostPort: string): string => {
  const h = hostPort.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const i = h.lastIndexOf(':');
  return i > 0 && /^\d+$/.test(h.slice(i + 1)) ? h.slice(0, i) : h;
};

/**
 * Parse one srt violation line. Formats seen:
 * - proxy:   `deny network-outbound host:port (reason)`
 * - linux:   `deny <syscall> /abs/path` (seccomp observer; write-intent syscalls only)
 * - macOS:   `... deny(1) file-read-data /abs/path` / `... deny(1) file-write-create /abs/path`
 */
export const parseViolationLine = (line: string): Violation | null => {
  const net = /network-outbound\s+(\S+)/.exec(line);
  if (net?.[1]) {
    const target = net[1];
    if (target.startsWith('/')) return null; // unix socket
    return { kind: 'net.allow', value: stripPort(target).toLowerCase(), raw: line };
  }
  const mac = /deny(?:\(\d+\))?\s+(file-[a-z*-]+)\s+(\/.*)$/.exec(line);
  if (mac?.[1] && mac[2]) {
    return { kind: mac[1].startsWith('file-read') ? 'fs.read' : 'fs.write', value: mac[2].trim(), raw: line };
  }
  const linux = /^deny\s+([a-z0-9_]+)\s+(\/.*)$/.exec(line.trim());
  if (linux?.[2]) return { kind: 'fs.write', value: linux[2], raw: line };
  return null;
};
