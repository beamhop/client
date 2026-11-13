/**
 * Split a long message into chunks of at most `limit` characters, preferring line
 * boundaries and keeping fenced code blocks balanced: a fence that is open at a chunk
 * boundary is closed at the end of that chunk and reopened (with its language tag) at
 * the start of the next one. Lines longer than a chunk are hard-cut.
 */
export const splitText = (text: string, limit: number): string[] => {
  if (limit < 32) throw new RangeError('split limit too small');
  if (text.length <= limit) return [text];
  const FENCE = '```';
  const CLOSE = '\n```';
  const chunks: string[] = [];
  let lines: string[] = [];
  let len = 0;
  let inFence = false;
  let fenceOpen = FENCE;

  const push = (l: string) => {
    len += (lines.length ? 1 : 0) + l.length;
    lines.push(l);
  };
  const budget = () => limit - (inFence ? CLOSE.length : 0);
  const onlyReopen = () => lines.length === 0 || (inFence && lines.length === 1 && lines[0] === fenceOpen);
  const flush = () => {
    if (!lines.length) return;
    chunks.push(lines.join('\n') + (inFence ? CLOSE : ''));
    lines = [];
    len = 0;
    if (inFence) push(fenceOpen);
  };

  for (const line of text.split('\n')) {
    let rest = line;
    for (;;) {
      const sep = lines.length ? 1 : 0;
      if (len + sep + rest.length <= budget()) {
        push(rest);
        break;
      }
      if (!onlyReopen()) {
        flush();
        continue;
      }
      const room = Math.max(1, budget() - len - sep);
      push(rest.slice(0, room));
      rest = rest.slice(room);
      flush();
      if (rest.length === 0) break;
    }
    if (line.trimStart().startsWith(FENCE)) {
      inFence = !inFence;
      if (inFence) fenceOpen = line.trim();
    }
  }
  if (lines.length && !onlyReopen()) chunks.push(lines.join('\n') + (inFence ? CLOSE : ''));
  return chunks;
};
