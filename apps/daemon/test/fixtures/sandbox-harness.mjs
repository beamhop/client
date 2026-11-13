// A tiny "harness" that runs inside srt. Reads one JSON prompt per line on stdin and answers with
// beamhop HarnessEvent JSON lines on stdout. Used by integration.test.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const rl = createInterface({ input: process.stdin });

const tryRead = (p) => {
  try {
    return `read:${readFileSync(p, 'utf8').trim()}`;
  } catch (e) {
    return `denied:${e.code ?? 'error'}`;
  }
};
const tryWrite = (p) => {
  try {
    writeFileSync(p, 'x');
    return 'wrote';
  } catch (e) {
    return `denied:${e.code ?? 'error'}`;
  }
};

rl.on('line', (line) => {
  const { prompt, secretFile, outsideFile } = JSON.parse(line);
  if (prompt.includes('HANG')) {
    writeFileSync(join(process.cwd(), 'pid.txt'), String(process.pid));
    out({ type: 'text', delta: 'hanging ' });
    setInterval(() => {}, 1000);
    return;
  }
  const results = {
    secret: tryRead(secretFile),
    inside: tryWrite(join(process.cwd(), 'made-in-sandbox.txt')),
    outside: tryWrite(outsideFile),
    session: process.env.BEAMHOP_SESSION_ID ? 'marked' : 'unmarked',
    leakedEnv: process.env.SHOULD_NOT_LEAK ?? 'none',
  };
  out({ type: 'tool_call', id: 't1', name: 'probe', input: {} });
  out({ type: 'tool_result', id: 't1', ok: true, output: JSON.stringify(results) });
  out({ type: 'text', delta: `results ${JSON.stringify(results)}` });
  out({ type: 'done', stopReason: 'end_turn' });
});
