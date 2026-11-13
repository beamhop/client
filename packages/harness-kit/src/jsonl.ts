import type { Readable, Writable } from 'node:stream';

/** Hard cap per JSON line, to bound memory if a harness misbehaves (16 MiB). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Read newline-delimited JSON from a stream. Splits on LF only (U+2028/U+2029 are valid
 * inside JSON strings, so `readline` is not safe — see pi's RPC docs). A trailing CR is stripped.
 * Lines that do not parse as JSON are passed to `onBadLine` (if given) and skipped.
 */
export const readJsonLines = (
  stream: Readable,
  onMessage: (msg: unknown) => void,
  opts: { onBadLine?: (line: string, err: unknown) => void; maxLineBytes?: number } = {},
): void => {
  const max = opts.maxLineBytes ?? MAX_LINE_BYTES;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) parseLine(line);
      idx = buf.indexOf('\n');
    }
    if (buf.length > max) {
      opts.onBadLine?.(buf.slice(0, 200), new Error(`line exceeds ${max} bytes`));
      buf = '';
    }
  });
  stream.on('end', () => {
    if (buf.trim()) parseLine(buf);
    buf = '';
  });
  function parseLine(line: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      opts.onBadLine?.(line, err);
      return;
    }
    onMessage(msg);
  }
};

/** Write one JSON message followed by LF. Resolves once flushed (or immediately if the stream is gone). */
export const writeJsonLine = (stream: Writable, msg: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error('stream closed'));
      return;
    }
    stream.write(`${JSON.stringify(msg)}\n`, (err) => (err ? reject(err) : resolve()));
  });
