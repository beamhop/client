/**
 * Sign-in helper for pi (SignIn.helper `pi-oauth`). pi signs in to subscriptions only from its own
 * interactive screen (`/login`), so beamhop runs pi's own login code (the pi-ai package inside pi's
 * install) with this script and writes the result where pi reads it (`auth.json` in PI_CODING_AGENT_DIR).
 *
 * Run with node (the daemon's runtime): `node helper.mjs <pi binary> <provider> <browser|device> <auth.json>`.
 * It prints the sign-in page ("Open this page: …") and any device code ("Enter code: …") for the job to
 * show, never the credential.
 */
export const PI_OAUTH_HELPER = String.raw`
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [piBin, provider, mode, authFile] = process.argv.slice(2);
const LOADERS = {
  'openai-codex': 'loadOpenAICodexOAuth',
  'openai-chatgpt': 'loadOpenAIChatGPTOAuth',
  'github-copilot': 'loadGitHubCopilotOAuth',
  'kimi-coding': 'loadKimiCodingOAuth',
};
const fail = (m) => { console.error('beamhop: ' + m); process.exit(2); };
if (!LOADERS[provider]) fail('unsupported pi provider ' + provider);

// pi's package root: the first parent of the real binary with a pi-coding-agent package.json.
let dir = dirname(realpathSync(piBin));
let root;
for (let i = 0; i < 8 && !root; i++, dir = dirname(dir)) {
  const pj = join(dir, 'package.json');
  if (existsSync(pj) && /pi-coding-agent/.test(JSON.parse(readFileSync(pj, 'utf8')).name ?? '')) root = dir;
}
if (!root) fail("can't find pi's install next to " + piBin);
// pi-ai: pi's own dependency (nested, or a sibling in a flat/scoped node_modules).
const candidates = [];
for (let d = root; d !== dirname(d); d = dirname(d)) {
  candidates.push(join(d, 'node_modules', '@earendil-works', 'pi-ai'), join(d, 'node_modules', '@mariozechner', 'pi-ai'));
}
candidates.push(join(dirname(root), 'pi-ai'));
const piAi = candidates.find((c) => existsSync(join(c, 'dist', 'auth', 'oauth', 'load.js')));
if (!piAi) fail("this pi version has no sign-in module beamhop can use; update pi");
const load = await import(pathToFileURL(join(piAi, 'dist', 'auth', 'oauth', 'load.js')).href);
const oauth = await load[LOADERS[provider]]();

const never = new Promise(() => {});
const interaction = {
  signal: new AbortController().signal,
  notify(e) {
    if (e.type === 'auth_url') console.log('Open this page: ' + e.url);
    else if (e.type === 'device_code') console.log('Open ' + e.verificationUri + ' and enter code: ' + e.userCode);
    else if (e.message) console.log(e.message);
  },
  prompt(p) {
    if (p.type === 'select') {
      const opts = p.options ?? [];
      const pick = mode === 'device' ? opts.find((o) => /device|headless/i.test(o.id + ' ' + o.label)) : undefined;
      return Promise.resolve((pick ?? opts[0])?.id ?? '');
    }
    // GitHub Enterprise domain: blank means github.com. Pasted codes: wait for the browser callback.
    if (p.type === 'text') return Promise.resolve('');
    return never;
  },
};
const cred = await oauth.login(interaction, { agentName: 'beamhop' });
let all = {};
try { all = JSON.parse(readFileSync(authFile, 'utf8')); } catch {}
all[provider] = { type: 'oauth', ...cred };
mkdirSync(dirname(authFile), { recursive: true, mode: 0o700 });
writeFileSync(authFile, JSON.stringify(all, null, 2), { mode: 0o600 });
console.log('Signed in.');
process.exit(0);
`;
