/**
 * Onboarding 01 Doctor and 02 Harnesses (JOURNEYS §1.01–02).
 * Doctor: rows resolve live one after another (instant under reduced motion); failing/warning rows open
 * inline with why beamhop needs it and the exact fix to copy; AppArmor gets its two options.
 * Harnesses: scan rows with version + lamp; `needs login` shows the login command + Check again;
 * `not installed` opens an Install sheet with package-manager commands; `Add ACP agent…` tests a
 * handshake. Continue needs ≥1 ready harness; with none, the primary becomes Install (no dead end).
 */
import type { DoctorCheck, HarnessView } from '@beamhop/core';
import { Plus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { harnessLamp, harnessMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { cx } from '../../lib/cx.ts';
import { announce } from '../../lib/live.ts';
import { Button } from '../../ui/Button.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { LetterTile } from '../../ui/Meta.tsx';
import { useReduced } from '../../ui/motion.ts';
import { Sheet } from '../../ui/Sheet.tsx';
import { Banner, ErrorState, Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { markDone, markSkipped, nextStep, useSetupProgress } from './progress.ts';
import { StepFrame, useGoStep } from './StepFrame.tsx';

const WHY: Record<string, string> = {
  srt: 'srt runs each agent in its sandbox and enforces the network allowlist.',
  bwrap: 'bubblewrap isolates the agent’s filesystem: it only sees the folders you mount.',
  socat: 'socat bridges the sandbox to beamhop’s network broker.',
  rg: 'ripgrep is how harnesses search your code quickly.',
  userns: 'bubblewrap needs unprivileged user namespaces to build the sandbox.',
};

/** A fix command with a copy button (DESIGN §9.1 Copy field). */
export const CommandLine = ({ cmd, label }: { cmd: string; label: string }) => (
  <div className="flex items-center gap-1 rounded-md bg-sunken py-0.5 pr-0.5 pl-3">
    <code className="min-w-0 flex-1 overflow-x-auto py-2 type-code whitespace-pre text-ink">{cmd}</code>
    <CopyButton value={cmd} label={label} compact />
  </div>
);

const LAMP = { ok: 'ready', warn: 'needs-you', fail: 'error', skip: 'stopped' } as const;
const WORD = { ok: 'ok', warn: 'attention', fail: 'missing', skip: 'skipped' } as const;

const CheckRow = ({ c, revealed }: { c: DoctorCheck; revealed: boolean }) => {
  const open = revealed && (c.status === 'warn' || c.status === 'fail');
  return (
    <li className={cx('px-4 py-3', open && 'bg-caution-wash/40')}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block type-title-3 text-ink">{c.title}</span>
          <span className="block truncate type-meta text-ink-2">{revealed ? c.message : 'checking…'}</span>
        </span>
        {revealed ? (
          <StatusDot state={LAMP[c.status]} label={WORD[c.status]} />
        ) : (
          <StatusDot state="live" label="checking" />
        )}
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-2.5">
          {WHY[c.id] && <p className="type-body-sm text-ink-2">{WHY[c.id]}</p>}
          {c.id === 'userns' ? (
            <>
              <p className="type-label text-ink">Allow it for bubblewrap only (recommended)</p>
              <CommandLine
                label="Copy AppArmor profile command"
                cmd={`sudo tee /etc/apparmor.d/bwrap <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\nEOF\nsudo systemctl reload apparmor`}
              />
              <p className="type-label text-ink">Or turn the restriction off system-wide</p>
              <p className="type-body-sm text-ink-2">
                Simpler, but every program gets user namespaces again.
              </p>
              {c.fix && <CommandLine cmd={c.fix} label="Copy sysctl command" />}
            </>
          ) : (
            c.fix && <CommandLine cmd={c.fix} label={`Copy fix for ${c.title}`} />
          )}
          <p className="type-meta text-ink-2">
            Or run <span className="text-ink">beamhop doctor --fix</span> in a terminal; it asks for your
            password there.
          </p>
        </div>
      )}
    </li>
  );
};

export const StepDoctor = () => {
  const q = useApi('system.doctor');
  const reduce = useReduced();
  const [shown, setShown] = useState(0);
  const [, update] = useSetupProgress();
  const go = useGoStep();
  const checks = q.data?.checks ?? [];

  // Rows resolve one after another so the user can follow along (not a spinner).
  useEffect(() => {
    if (!q.data) return;
    if (reduce) {
      setShown(checks.length);
      return;
    }
    setShown(0);
    let n = 0;
    const t = window.setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= checks.length) window.clearInterval(t);
    }, 220);
    return () => window.clearInterval(t);
  }, [q.data, reduce, checks.length]);

  const finished = q.data && shown >= checks.length;
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  useEffect(() => {
    if (finished)
      announce(
        `${checks.length} checks: ${checks.length - fails - warns} ok, ${warns} need attention, ${fails} missing.`,
      );
  }, [finished, checks.length, fails, warns]);

  return (
    <StepFrame
      step="doctor"
      title="Check this computer"
      lede="beamhop sandboxes every agent. These are the parts it needs. Nothing is installed without you."
      cli="beamhop doctor"
      primary={{
        label: 'Continue · Harnesses',
        disabled: !finished || fails > 0,
        onPress: () => {
          update((p) => markDone(p, 'doctor'));
          go('harnesses');
        },
      }}
      skip={
        fails > 0
          ? {
              label: 'Skip for now',
              onPress: () => {
                update((p) => markSkipped(p, 'doctor'));
                go('harnesses');
              },
            }
          : undefined
      }
    >
      {q.isError ? (
        <ErrorState title="Couldn't run the checks." details={q.error} onRetry={() => void q.refetch()}>
          {q.error.message} Is beamhopd running? Start it with{' '}
          <code className="font-mono">beamhop start</code>.
        </ErrorState>
      ) : !q.data ? (
        <Skeleton variant="list" count={5} label="Running checks" />
      ) : (
        <>
          <ul
            aria-label="Checks"
            aria-busy={!finished}
            className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
          >
            {checks.map((c, i) => (
              <CheckRow key={c.id} c={c} revealed={i < shown} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="type-meta text-ink-2" role="status">
              {finished
                ? `${checks.length} checks · ${checks.length - fails - warns} ok${warns ? ` · ${warns} attention` : ''}${fails ? ` · ${fails} missing` : ''}`
                : `checking ${Math.min(shown + 1, checks.length)} of ${checks.length}…`}
            </p>
            <Button
              variant="quiet"
              size="sm"
              onPress={() => void q.refetch()}
              isPending={q.isFetching && !!q.data}
            >
              Run again
            </Button>
          </div>
          {finished && warns > 0 && fails === 0 && (
            <Banner tone="caution" className="rounded-md border-x px-4">
              You can continue. Fix the item above when you can; until then the sandbox is weaker on this
              computer.
            </Banner>
          )}
          {finished && fails > 0 && (
            <Banner tone="stop" className="rounded-md border-x px-4">
              Agents can't be sandboxed until the missing parts are installed. Run the fix, then Run again.
            </Banner>
          )}
        </>
      )}
    </StepFrame>
  );
};

// ─────────── 02 Harnesses ───────────
const InstallSheet = ({
  h,
  onClose,
  onCheck,
}: {
  h: HarnessView;
  onClose: () => void;
  onCheck: () => void;
}) => {
  const opts = Object.entries(h.install ?? {}).filter(([k]) => k !== 'url') as Array<[string, string]>;
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={`Install ${h.displayName}`}
      footer={
        <Button variant="primary" size="lg" fullWidth onPress={onCheck}>
          Check again
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body-sm text-ink-2">Run one of these in a terminal, then check again.</p>
        {opts.length ? (
          opts.map(([pm, cmd]) => (
            <div key={pm} className="flex flex-col gap-1.5">
              <span className="type-micro text-ink-2">{pm}</span>
              <CommandLine cmd={cmd} label={`Copy ${pm} command`} />
            </div>
          ))
        ) : (
          <p className="type-body-sm text-ink-2">
            See {h.install?.url ?? 'the vendor’s site'} for install steps.
          </p>
        )}
      </div>
    </Sheet>
  );
};

export const StepHarnesses = () => {
  const q = useApi('harness.scan');
  const add = useMutationApi('harness.add', { invalidate: ['harness.scan'] });
  const [, update] = useSetupProgress();
  const go = useGoStep();
  const [installing, setInstalling] = useState<HarnessView>();
  const [acp, setAcp] = useState(false);
  const [cmd, setCmd] = useState('');
  const hs = q.data?.harnesses ?? [];
  const ready = hs.filter((h) => h.status === 'ready');
  const firstInstallable = hs.find((h) => h.status === 'not-installed');

  return (
    <StepFrame
      step="harnesses"
      title="Find your coding agents"
      lede="A harness is the agent program beamhop drives: Claude Code, Codex, Gemini CLI and others. It uses your own login."
      cli="beamhop harness scan"
      primary={
        ready.length || !firstInstallable
          ? {
              label: 'Continue · Identity',
              disabled: !ready.length,
              onPress: () => {
                update((p) => markDone(p, 'harnesses'));
                go(nextStep('harnesses'));
              },
            }
          : {
              label: `Install ${firstInstallable.displayName}`,
              onPress: () => setInstalling(firstInstallable),
              icon: <Plus size={16} weight="bold" aria-hidden="true" />,
            }
      }
    >
      {q.isError ? (
        <ErrorState title="Couldn't scan for harnesses." details={q.error} onRetry={() => void q.refetch()}>
          {q.error.message}
        </ErrorState>
      ) : !q.data ? (
        <Skeleton variant="list" count={5} label="Scanning" />
      ) : (
        <>
          <p className="type-meta text-ink-2" role="status">
            {hs.length} found · {ready.length} ready
          </p>
          <ul
            aria-label="Harnesses"
            className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
          >
            {hs.map((h) => (
              <li key={h.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <LetterTile code={harnessMonogram(h.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block type-title-3 text-ink">{h.displayName}</span>
                    <span className="block truncate type-meta text-ink-2">
                      {[h.version, h.protocol].filter(Boolean).join(' · ') || h.command}
                    </span>
                  </span>
                  <StatusDot
                    state={harnessLamp(h)}
                    label={
                      {
                        ready: 'ready',
                        'needs-login': 'needs login',
                        'not-installed': 'not installed',
                        'unsupported-version': 'too old',
                        error: 'error',
                      }[h.status]
                    }
                  />
                </div>
                {h.status === 'needs-login' && (
                  <div className="flex flex-col gap-2 pl-10">
                    <CommandLine cmd={`${h.command} login`} label={`Copy ${h.displayName} login command`} />
                    <Button
                      variant="quiet"
                      size="sm"
                      className="-ml-3 self-start"
                      isPending={q.isFetching}
                      onPress={() => void q.refetch()}
                    >
                      Check again
                    </Button>
                  </div>
                )}
                {h.status === 'not-installed' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-10 self-start"
                    onPress={() => setInstalling(h)}
                  >
                    Install…
                  </Button>
                )}
                {(h.status === 'unsupported-version' || h.status === 'error') && h.message && (
                  <p className="pl-10 type-body-sm text-ink-2">{h.message}</p>
                )}
              </li>
            ))}
          </ul>
          {acp ? (
            <form
              className="flex flex-col gap-3 rounded-lg border border-line p-4"
              onSubmit={(e) => {
                e.preventDefault();
                const [command = '', ...args] = cmd.trim().split(/\s+/);
                if (!command) return;
                add.mutate({ id: command.split('/').pop() ?? command, command, args });
              }}
            >
              <TextField
                label="ACP agent command"
                mono
                value={cmd}
                onChange={setCmd}
                placeholder="my-agent --acp"
                description="Any program that speaks the Agent Client Protocol on stdio."
              />
              <Button
                type="submit"
                variant="secondary"
                className="self-start"
                isPending={add.isPending}
                isDisabled={!cmd.trim()}
              >
                Test handshake
              </Button>
              {add.data && (
                <StatusDot
                  state="ready"
                  label={`${add.data.displayName}: ${add.data.message ?? 'handshake ok'}`}
                />
              )}
              {add.isError && <p className="type-body-sm text-stop-text">{add.error.message}</p>}
            </form>
          ) : (
            <Button variant="quiet" className="-ml-3 self-start" onPress={() => setAcp(true)}>
              Add ACP agent…
            </Button>
          )}
        </>
      )}
      {installing && (
        <InstallSheet
          h={installing}
          onClose={() => setInstalling(undefined)}
          onCheck={() => {
            setInstalling(undefined);
            void q.refetch();
          }}
        />
      )}
    </StepFrame>
  );
};
