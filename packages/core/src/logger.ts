import type { Logger } from './plugins.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always redacted in logs. */
const SECRET_KEY = /(token|secret|password|nsec|apikey|api_key|authorization|cookie|private)/i;

export const redact = (data: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
};

export interface LoggerOptions {
  level?: Level;
  json?: boolean;
  sink?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

export const createLogger = (opts: LoggerOptions = {}): Logger => {
  const level: Level = opts.level ?? (process.env.BEAMHOP_LOG_LEVEL as Level | undefined) ?? 'info';
  const json = opts.json ?? process.env.BEAMHOP_LOG_JSON === '1';
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const bindings = opts.bindings ?? {};
  const write = (l: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return;
    const rec = { t: new Date().toISOString(), level: l, msg, ...bindings, ...redact(data) };
    if (json) sink(JSON.stringify(rec));
    else {
      const extra = { ...bindings, ...redact(data) };
      const tail = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      sink(`${rec.t} ${l.toUpperCase().padEnd(5)} ${msg}${tail}`);
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (b) => createLogger({ ...opts, level, json, sink, bindings: { ...bindings, ...b } }),
  };
};

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
