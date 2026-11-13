/**
 * `beamhop init`: the first-run wizard (§9A, JOURNEYS 1). Seven steps, each skippable:
 * doctor → harnesses → owner identity → pair a phone → first agent → hello round trip → next steps.
 * Interactive in a terminal (clack prompts); `--yes` plus flags runs it headless.
 */
import { resolve } from 'node:path';
import type { BeamhopClient } from '@beamhop/client';
import type { HarnessView } from '@beamhop/core';
import pc from 'picocolors';
import QRCode from 'qrcode';

export interface InitOptions {
  yes?: boolean;
  ownerNpub?: string;
  exportNsec?: boolean;
  /** Skip flags; with --yes, pairing and the hello round trip only run when asked (`--pair`, `--hello`). */
  doctor?: boolean;
  harnesses?: boolean;
  identity?: boolean;
  pair?: boolean;
  agent?: boolean;
  hello?: boolean;
  agentName?: string;
  harness?: string;
  preset?: string;
  mount?: string;
  mountMode?: 'ro' | 'rw';
  sandbox?: 'strict' | 'workspace';
  deviceName?: string;
  pairTimeout?: number;
  helloTimeout?: number;
}

export interface Prompter {
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message: string): void;
  step(title: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  note(body: string, title?: string): void;
  confirm(message: string, initial: boolean): Promise<boolean>;
  select<T extends string>(
    message: string,
    options: { value: T; label: string; hint?: string }[],
    initial: T,
  ): Promise<T>;
  text(message: string, initial: string): Promise<string>;
}

export class InitCancelled extends Error {
  constructor() {
    super('setup cancelled');
  }
}

/** Headless prompter: every question takes its default; output goes to `out`. */
export const headlessPrompter = (out: (l: string) => void): Prompter => ({
  interactive: false,
  intro: (t) => out(pc.bold(t)),
  outro: (m) => out(m),
  step: (t) => out(`\n${pc.bold(pc.cyan(t))}`),
  info: (m) => out(m),
  success: (m) => out(`${pc.green('✓')} ${m}`),
  warn: (m) => out(`${pc.yellow('!')} ${m}`),
  note: (b, t) => out(t ? `${pc.bold(t)}\n${b}` : b),
  confirm: async (_m, initial) => initial,
  select: async (_m, _o, initial) => initial,
  text: async (_m, initial) => initial,
});

/** Interactive prompter on @clack/prompts (loaded lazily so non-TTY runs never touch the terminal). */
export const clackPrompter = async (): Promise<Prompter> => {
  const p = await import('@clack/prompts');
  const check = <T>(v: T | symbol): T => {
    if (p.isCancel(v)) {
      p.cancel('Setup cancelled. Run `beamhop init` again any time.');
      throw new InitCancelled();
    }
    return v as T;
  };
  return {
    interactive: true,
    intro: (t) => p.intro(t),
    outro: (m) => p.outro(m),
    step: (t) => p.log.step(pc.bold(t)),
    info: (m) => p.log.info(m),
    success: (m) => p.log.success(m),
    warn: (m) => p.log.warn(m),
    note: (b, t) => p.note(b, t),
    confirm: async (message, initialValue) => check<boolean>(await p.confirm({ message, initialValue })),
    select: async (message, options, initialValue) =>
      check(await p.select({ message, options: options as never, initialValue })) as never,
    text: async (message, initialValue) =>
      check<string>(await p.text({ message, initialValue, defaultValue: initialValue })),
  };
};

export interface InitDeps {
  client: BeamhopClient;
  ui: Prompter;
  sleep?: (ms: number) => Promise<void>;
  /** Folder suggested for the first agent (default: cwd). */
  cwd?: string;
  /** ms clock for wait loops. */
  now?: () => number;
}

export interface InitResult {
  owner?: string;
  device?: { id: string; name: string };
  agent?: { name: string; npub?: string };
  hello?: 'replied' | 'timeout' | 'skipped';
}

const STATUS: Record<string, string> = {
  ok: pc.green('✓'),
  warn: pc.yellow('!'),
  fail: pc.red('✗'),
  skip: pc.dim('○'),
  ready: pc.green('ready'),
  'needs-login': pc.yellow('needs login'),
  'not-installed': pc.dim('not installed'),
  'unsupported-version': pc.yellow('unsupported version'),
  error: pc.red('error'),
};

const PRESET_NAMES: Record<string, string> = {
  'personal-assistant': 'assistant',
  'code-reviewer': 'reviewer',
  'team-dev-bot': 'devbot',
  'public-qa': 'qa',
};

const middle = (s: string, keep = 12) =>
  s.length > keep * 2 + 1 ? `${s.slice(0, keep)}…${s.slice(-keep)}` : s;

const harnessHint = (h: HarnessView): string => {
  if (h.status === 'needs-login') return h.message ?? `log in: ${h.command} login`;
  if (h.status === 'not-installed') {
    const i = h.install;
    const opts = [
      i?.npm && `npm i -g ${i.npm}`,
      i?.brew && `brew install ${i.brew}`,
      i?.winget,
      i?.url,
    ].filter(Boolean);
    return opts.length ? `install: ${opts.join('  |  ')}` : 'not installed';
  }
  return h.message ?? h.version ?? '';
};

/** Render a QR code for the terminal (small, using half blocks). */
export const terminalQr = (text: string): Promise<string> =>
  QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });

/**
 * Show the pairing QR (hosted PWA URL), wait for the phone's `device.pairComplete`, then confirm the
 * 4-word safety phrase on this (trusted) side. Returns the paired device, or undefined.
 */
export const pairPhone = async (
  deps: { client: BeamhopClient; ui: Prompter; sleep: (ms: number) => Promise<void>; now: () => number },
  o: { name: string; timeoutS: number },
): Promise<{ id: string; name: string } | undefined> => {
  const { client: c, ui, sleep, now } = deps;
  const p = await c.call('device.pairStart', { name: o.name, requireConfirm: true });
  ui.note(await terminalQr(p.uri), 'Scan with your phone camera');
  ui.info(`Or open: ${pc.bold(p.uri)}`);
  if (p.link) ui.info(pc.dim(`App link: ${p.link}`));
  ui.info(`Code ${pc.bold(p.code)} ${pc.dim(`· expires ${new Date(p.expiresAt).toLocaleTimeString()}`)}`);
  const pairingId = p.pairingId;
  if (!pairingId) {
    ui.warn('This daemon does not report pairing status; check `beamhop device ls`.');
    return undefined;
  }
  const deadline = now() + o.timeoutS * 1000;
  ui.info(pc.dim('Waiting for your phone…'));
  let st = await c.call('device.pairStatus', { pairingId });
  while (st.status === 'waiting' && now() < deadline) {
    await sleep(1000);
    st = await c.call('device.pairStatus', { pairingId });
  }
  if (st.status === 'awaiting-confirm' && st.safetyPhrase) {
    const phrase = st.safetyPhrase.map((w) => w.toUpperCase()).join(' · ');
    ui.info(`Safety phrase: ${pc.bold(phrase)}`);
    const yes = await ui.confirm(`Does your phone show: ${pc.bold(phrase)}?`, true);
    st = await c.call('device.pairConfirm', { pairingId, accept: yes });
  }
  if (st.status === 'paired' && st.device) {
    ui.success(`Paired · ${st.device.name}`);
    return { id: st.device.id, name: st.device.name };
  }
  if (st.status === 'rejected')
    ui.warn('Pairing cancelled. If the words did not match, someone else may have scanned the code.');
  else {
    if (st.status === 'waiting') await c.call('device.pairConfirm', { pairingId, accept: false });
    ui.warn('No phone answered. Pair later with `beamhop device pair`; you can reply from any Nostr client.');
  }
  return undefined;
};

export const runInit = async (deps: InitDeps, o: InitOptions): Promise<InitResult> => {
  const { client: c, ui } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const headless = !ui.interactive;
  const result: InitResult = {};
  /** Should a step run? Explicit flag wins; headless defaults to `headlessDefault`; interactive asks. */
  const want = async (flag: boolean | undefined, question: string, headlessDefault = true) => {
    if (flag !== undefined) return flag;
    if (headless) return headlessDefault;
    return ui.confirm(question, true);
  };

  ui.intro('beamhop setup');
  const status = await c.call('system.status');
  ui.info(pc.dim(`daemon ${status.version} · ${status.home}`));

  // ── 01 doctor ──
  let needsKey = false;
  if (await want(o.doctor, 'Check the sandbox prerequisites?')) {
    ui.step('01 Doctor');
    const { checks } = await c.call('system.doctor');
    needsKey = checks.some((k) => k.id === 'llm.keys' && k.status !== 'ok');
    for (const k of checks) {
      ui.info(`${STATUS[k.status] ?? '?'} ${k.title}  ${pc.dim(k.message)}`);
      if (k.fix && k.status !== 'ok') ui.info(`    ${pc.cyan('fix:')} ${k.fix}`);
    }
    const failed = checks.filter((k) => k.status === 'fail');
    if (failed.length) {
      ui.warn(`${failed.length} check(s) failed. beamhop works, but fix these before trusting the sandbox.`);
      if (!headless && !(await ui.confirm('Continue anyway?', true))) throw new InitCancelled();
    } else ui.success('Prerequisites look good.');
  }

  // ── 02 harnesses ──
  let ready: HarnessView[] = [];
  let all: HarnessView[] = [];
  if (await want(o.harnesses, 'Look for agent harnesses (Claude Code, Codex, …)?')) {
    ui.step('02 Harnesses');
    all = (await c.call('harness.scan')).harnesses;
    const width = Math.max(18, ...all.map((h) => h.displayName.length));
    for (const h of all)
      ui.info(`${h.displayName.padEnd(width)} ${STATUS[h.status] ?? h.status}  ${pc.dim(harnessHint(h))}`);
    ready = all.filter((h) => h.status === 'ready');
    if (ready.length) ui.success(`${ready.length} ready.`);
    else
      ui.warn(
        'No harness is ready yet. Install or log in to one (hints above), then run `beamhop harness scan`.',
      );
  }

  // ── 03 owner identity ──
  let owner = (await c.call('identity.get')).npub;
  if (await want(o.identity, 'Set up your owner identity?')) {
    ui.step('03 Identity');
    if (o.ownerNpub) {
      owner = (await c.call('identity.ownerImport', { npub: o.ownerNpub })).npub;
      ui.success(`Owner ${owner} (your key stays on your device; it signs attestations there).`);
    } else {
      let mode: 'keep' | 'create' | 'import' = owner ? 'keep' : 'create';
      if (!headless)
        mode = await ui.select(
          'Owner key',
          [
            ...(owner ? [{ value: 'keep' as const, label: `Keep ${middle(owner)}` }] : []),
            {
              value: 'create' as const,
              label: 'Create a new owner key',
              hint: 'stored in your OS keychain; you can export it once',
            },
            {
              value: 'import' as const,
              label: 'Use an existing Nostr key (npub)',
              hint: 'signing stays on your device',
            },
          ],
          mode,
        );
      if (mode === 'import') {
        const npub = await ui.text('Your npub', '');
        owner = (await c.call('identity.ownerImport', { npub: npub.trim() })).npub;
        ui.success(`Owner ${owner}`);
      } else if (mode === 'create') {
        owner = (await c.call('identity.ownerCreate', { replace: !!owner })).npub;
        ui.success(`Created owner key ${pc.bold(owner)}`);
        ui.info(pc.dim('It signs role changes and control messages. Agents get their own keys.'));
        const exportIt =
          o.exportNsec ??
          (!headless &&
            (await ui.confirm(
              'Export a backup of the secret key (nsec) now? It is shown only once. Anyone who has it controls your agents.',
              false,
            )));
        if (exportIt) {
          const { nsec } = await c.call('identity.ownerExport');
          ui.note(
            `${nsec}\n\n${pc.yellow('Store this in a password manager. Never paste it into a website or chat.')}\nIt is not shown again.`,
            'Owner secret key (nsec)',
          );
        }
      } else ui.success(`Owner ${owner}`);
    }
  }
  if (owner) result.owner = owner;

  // ── 04 pair a phone ──
  if (await want(o.pair, 'Pair your phone now? (scan a QR code)', false)) {
    ui.step('04 Phone');
    const dev = await pairPhone(
      { client: c, ui, sleep, now },
      { name: o.deviceName ?? 'Phone', timeoutS: o.pairTimeout ?? 120 },
    );
    if (dev) result.device = dev;
  }

  // ── 05 first agent ──
  let agentName: string | undefined;
  if (await want(o.agent, 'Create your first agent?')) {
    ui.step('05 Agent');
    const { presets } = await c.call('agent.presets');
    const preset =
      o.preset ??
      (await ui.select(
        'Preset',
        presets.map((p) => ({ value: p.id, label: p.title, hint: p.description })),
        presets.find((p) => p.id === 'personal-assistant')?.id ?? presets[0]?.id ?? 'personal-assistant',
      ));
    const presetDef = presets.find((p) => p.id === preset);
    const defaultName = PRESET_NAMES[preset] ?? 'assistant';
    const presetProfile =
      ((presetDef?.config.sandbox as { profile?: string } | undefined)?.profile as 'strict' | 'workspace') ??
      'workspace';
    const name = o.agentName ?? (await ui.text('Name', defaultName)).trim();
    const choices = (ready.length ? ready : all).map((h) => h.id);
    let harness = o.harness ?? choices[0];
    if (!o.harness && !headless && choices.length > 1)
      harness = await ui.select(
        'Harness',
        choices.map((id) => ({ value: id, label: id })),
        choices[0]!,
      );
    if (!harness) harness = (await c.call('harness.list')).harnesses.find((h) => h.status === 'ready')?.id;
    const existing = (await c.call('agent.list')).agents.find((a) => a.config.name === name);
    if (existing) {
      ui.info(`Agent ${pc.bold(name)} already exists; using it.`);
      agentName = name;
      result.agent = {
        name,
        ...(existing.config.identity.npub ? { npub: existing.config.identity.npub } : {}),
      };
    } else if (!harness) {
      ui.warn('Skipping: no harness available. Run `beamhop init` again after installing one.');
    } else {
      const folder = o.mount ?? (await ui.text('Folder the agent may use', deps.cwd ?? process.cwd()));
      const mode =
        o.mountMode ??
        (await ui.select(
          'Access to that folder',
          [
            { value: 'ro' as const, label: 'Read-only', hint: 'recommended' },
            { value: 'rw' as const, label: 'Read-write', hint: 'git repos get one branch per session' },
          ],
          'ro',
        ));
      const sandbox =
        o.sandbox ??
        (await ui.select(
          'Sandbox profile',
          [
            {
              value: 'workspace' as const,
              label: 'workspace',
              hint: 'its folders + the harness API and common dev hosts',
            },
            { value: 'strict' as const, label: 'strict', hint: 'its folders only, minimal network' },
          ],
          presetProfile === 'strict' ? 'strict' : 'workspace',
        ));
      const v = await c.call('agent.create', {
        preset,
        config: {
          name,
          harness,
          ...(folder ? { mounts: [{ path: resolve(folder), mode }] } : {}),
          sandbox: { profile: sandbox },
          memberships: [{ target: 'nostr:dm', defaultRole: 'viewer', triggers: ['dm', 'mention', 'reply'] }],
        },
      });
      agentName = name;
      const npub = v.config.identity.npub;
      result.agent = { name, ...(npub ? { npub } : {}) };
      ui.success(`Created ${pc.bold(name)}${npub ? ` · ${npub}` : ''}`);
      if (owner)
        ui.info(pc.dim(`Profile: "${v.config.displayName ?? name} · AI agent operated by ${owner}"`));
      if (folder)
        ui.info(
          pc.dim(`Can ${mode === 'ro' ? 'read' : 'read and write'} ${resolve(folder)} · sandbox ${sandbox}`),
        );
    }
  }

  // ── 06 hello round trip ──
  result.hello = 'skipped';
  if (agentName && owner && (await want(o.hello, 'Send a hello DM to check the whole chain?', false))) {
    ui.step('06 Hello');
    const h = await c.call('onboarding.hello', { agent: agentName });
    ui.info(`${pc.bold(agentName)} sent a Nostr DM to ${middle(h.to)}.`);
    ui.info(
      `Reply from your phone: the beamhop app, or any Nostr client signed in as your owner key. The agent is ${pc.bold(h.from)}.`,
    );
    const timeoutS = o.helloTimeout ?? 120;
    for (;;) {
      const started = now();
      const deadline = started + timeoutS * 1000;
      let st = await c.call('onboarding.helloStatus', { agent: agentName });
      while (!st.replied && now() < deadline) {
        await sleep(1000);
        st = await c.call('onboarding.helloStatus', { agent: agentName });
      }
      if (st.replied) {
        const ms = st.repliedAt && st.sentAt ? Date.parse(st.repliedAt) - Date.parse(st.sentAt) : undefined;
        ui.success(
          `It works. Your phone → relays → ${agentName}${ms !== undefined ? `, in ${(ms / 1000).toFixed(1)} s` : ''}.`,
        );
        result.hello = 'replied';
        break;
      }
      result.hello = 'timeout';
      if (
        headless ||
        !(await ui.confirm('Still waiting. Did the message arrive on your phone? Keep waiting?', false))
      ) {
        ui.warn(`No reply within ${timeoutS}s. You can test later by DMing ${h.from}.`);
        break;
      }
    }
  }

  // ── 07 next steps ──
  ui.step('07 Next steps');
  ui.note(
    [
      ...(needsKey
        ? [
            'Give agents a model key'.padEnd(34) +
              pc.cyan('beamhop secret set ANTHROPIC_API_KEY --from-env ANTHROPIC_API_KEY'),
          ]
        : []),
      ...(agentName
        ? [
            `Talk to ${agentName} right now`.padEnd(34) +
              pc.cyan(`beamhop session start ${agentName} "hello"`),
          ]
        : []),
      `Add Telegram, Slack or Discord    ${pc.cyan('beamhop channel add telegram --name mybot --token-env TG_TOKEN')}`,
      `Set up a NIP-05 handle            ${pc.cyan('beamhop identity nip05 --domain example.com')}`,
      `Move an agent to the cloud        ${pc.cyan(`beamhop deploy plan --agent ${agentName ?? '<name>'} --provider hetzner`)}`,
      ...(result.device ? [] : [`Pair a phone                      ${pc.cyan('beamhop device pair')}`]),
    ].join('\n'),
  );
  ui.outro('Done. Run `beamhop status` any time.');
  return result;
};
