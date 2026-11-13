/**
 * /_kitchen — every design-system component in every state, with theme / contrast / motion toggles.
 * For design review and for builders looking for the right component. Keep it complete: when you add a
 * component to src/ui, add it here.
 */
import { CheckCircle, Copy, Plus, Stop, Trash } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import type { LampState } from '../../api/derive.ts';
import { useAppearance } from '../../lib/appearance.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Wordmark } from '../../shell/Wordmark.tsx';
import {
  Badge,
  Banner,
  BarChart,
  BeamGlyph,
  Button,
  Card,
  Checkbox,
  ChipGroup,
  ChipInput,
  CliStrip,
  CodeBlock,
  ConfirmDialog,
  CountBadge,
  DiffView,
  EmptyState,
  ErrorState,
  Eyebrow,
  IconButton,
  Kbd,
  LetterTile,
  LinkButton,
  MetaLine,
  NumberField,
  PathPicker,
  QrCode,
  Radio,
  RadioGroup,
  Readout,
  RiskTag,
  RouteLine,
  SearchField,
  SecretField,
  SegmentedControl,
  SegmentedMeter,
  Select,
  Sheet,
  SignalBars,
  Skeleton,
  SlipGlyph,
  Sparkline,
  StatusDot,
  Stepper,
  SwipeAction,
  Switch,
  Tabs,
  TextField,
  TextLink,
  TicketCard,
  UntrustedQuote,
  useToast,
} from '../../ui/index.ts';

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={`k-${id}`} className="flex flex-col gap-4 border-t border-line pt-6">
    <h2 id={`k-${id}`} className="type-title-2 text-ink">
      {title}
    </h2>
    {children}
  </section>
);

const Row = ({ children, label }: { children: ReactNode; label?: string }) => (
  <div className="flex flex-col gap-2">
    {label && <p className="type-micro text-ink-3">{label}</p>}
    <div className="flex flex-wrap items-center gap-3">{children}</div>
  </div>
);

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,4 +40,4 @@ export async function login(req, res) {
   const next = req.query.next;
-  res.redirect('/');
+  res.redirect(safeNext(next));
 }`;

const LAMPS: LampState[] = ['live', 'ready', 'needs-you', 'paused', 'stopped', 'error', 'offline', 'panic'];

export const KitchenScreen = () => {
  const [prefs, resolved, set] = useAppearance();
  const toast = useToast();
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pulse, setPulse] = useState(0);
  const [hosts, setHosts] = useState(['api.anthropic.com', 'github.com', 'registry.npmjs.org']);
  const [slips, setSlips] = useState(['a41f', 'b72c']);
  const [path, setPath] = useState('~/code/app');
  const [seg, setSeg] = useState<'ro' | 'rw'>('ro');
  const [step, setStep] = useState(2);
  const [budget, setBudget] = useState(5);

  return (
    <Screen
      title="Kitchen sink"
      back={{ href: '/', label: 'Home' }}
      maxWidth="wide"
      slug={
        <MetaLine
          items={[
            'CARRIER design system',
            `${resolved.theme} · contrast ${resolved.contrast} · motion ${resolved.motion}`,
          ]}
        />
      }
    >
      <div className="flex flex-col gap-8">
        <div className="sticky top-[52px] z-10 -mx-4 flex flex-wrap items-center gap-3 border-b border-line bg-bg px-4 py-3 expanded:top-[72px]">
          <SegmentedControl
            label="Theme"
            size="sm"
            value={prefs.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { id: 'system', label: 'System' },
              { id: 'light', label: 'Paper' },
              { id: 'dark', label: 'Night' },
            ]}
          />
          <SegmentedControl
            label="Contrast"
            size="sm"
            value={prefs.contrast}
            onChange={(contrast) => set({ contrast })}
            options={[
              { id: 'system', label: 'Std' },
              { id: 'more', label: 'High' },
            ]}
          />
          <SegmentedControl
            label="Motion"
            size="sm"
            value={prefs.motion}
            onChange={(motion) => set({ motion })}
            options={[
              { id: 'system', label: 'Full' },
              { id: 'reduced', label: 'Reduced' },
            ]}
          />
        </div>

        <Section id="type" title="Type & identity">
          <Wordmark size={32} />
          <Readout>12:40</Readout>
          <p className="type-title-1">Title 1 · Who owns these agents?</p>
          <p className="type-title-2">Title 2 · Allow git push?</p>
          <p className="type-title-3">Title 3 · reviewer</p>
          <p className="type-body max-w-[68ch]">
            Body · reviewer wants to reach <strong>registry.npmjs.org</strong>. It's not in the sandbox
            allowlist. Allowing lets this session download packages from npm.
          </p>
          <p className="type-body-sm text-ink-2">Body small · secondary description in ink-2.</p>
          <MetaLine
            items={[
              'claude 2.1.4',
              'workspace',
              '~/code/app rw',
              { value: 'npub1x7k4m2q9r8t5w3e6y1u0i7o4p2a5s8d3f6g9q9fz', truncate: 16 },
            ]}
          />
          <p className="type-micro text-ink-2">Micro · pending · 3</p>
          <Eyebrow count={3} href="/inbox">
            Needs you
          </Eyebrow>
          <Row label="Letter tiles">
            {['CC', 'CX', 'GH', 'GM', 'OC', 'pi', 'AC', 'NS', 'TG', 'SL', 'DC'].map((c) => (
              <LetterTile key={c} code={c} />
            ))}
          </Row>
          <Row label="Kbd">
            <Kbd>⌘K</Kbd> <Kbd>g</Kbd> <Kbd>i</Kbd> <Kbd>⇧A</Kbd>
          </Row>
        </Section>

        <Section id="buttons" title="Buttons">
          <Row>
            <Button variant="primary">Add Telegram</Button>
            <Button variant="secondary">Details</Button>
            <Button variant="quiet">Not now</Button>
            <Button variant="allow" icon={<CheckCircle size={18} weight="bold" aria-hidden="true" />}>
              Allow once
            </Button>
            <Button variant="deny">Deny</Button>
            <Button variant="destructive" icon={<Trash size={18} aria-hidden="true" />}>
              Delete reviewer
            </Button>
            <Button variant="destructive-outline" icon={<Stop size={16} weight="fill" aria-hidden="true" />}>
              Stop everything
            </Button>
          </Row>
          <Row label="States">
            <Button variant="primary" isPending>
              Deploy · €4.51/mo
            </Button>
            <Button variant="primary" isDisabled>
              Continue · Phone
            </Button>
            <Button variant="secondary" size="sm">
              Small
            </Button>
            <Button variant="primary" size="lg">
              Large 56px
            </Button>
          </Row>
          <Row label="Icon buttons & links">
            <IconButton label="Copy npub" icon={<Copy size={20} />} />
            <IconButton label="Add" variant="secondary" icon={<Plus size={20} />} />
            <IconButton
              label="Stop everything"
              variant="destructive-ghost"
              icon={<Stop size={20} weight="fill" />}
            />
            <LinkButton href="/agents/new" icon={<Plus size={16} aria-hidden="true" />}>
              New agent
            </LinkButton>
            <TextLink href="https://t.me/BotFather" external>
              Open BotFather
            </TextLink>
          </Row>
        </Section>

        <Section id="status" title="Status: lamps, meters, routes">
          <Row label="StatusDot (shape + colour + word)">
            {LAMPS.map((s) => (
              <StatusDot key={s} state={s} />
            ))}
          </Row>
          <Row label="SignalBars">
            <SignalBars up={3} total={4} unit="relays" />
            <SignalBars up={4} total={4} unit="relays" />
            <SignalBars up={3} total={3} unit="hops" limit />
            <SignalBars up={0} total={4} busy unit="connecting" />
          </Row>
          <Row label="SegmentedMeter">
            <SegmentedMeter
              name="reviewer budget"
              value={3.2}
              max={5}
              label="$3.20 / $5.00 today"
              valueText="$3.20 of $5.00 used today"
            />
            <SegmentedMeter
              name="ci-bot budget"
              value={4.2}
              max={5}
              label="$4.20 / $5.00 today"
              valueText="$4.20 of $5.00 used today"
            />
            <SegmentedMeter
              name="helpdesk budget"
              value={5.42}
              max={5}
              label="over by $0.42"
              valueText="$5.42 of $5.00, over budget"
            />
          </Row>
          <div className="flex max-w-[480px] flex-col gap-4">
            <RouteLine
              nodes={[
                { label: 'tg:group/-100123', kind: 'channel' },
                { label: 'reviewer', kind: 'agent' },
              ]}
              pulse={pulse}
            />
            <RouteLine
              nodes={[
                { label: 'nostr:dm', kind: 'channel' },
                { label: 'reviewer', kind: 'agent' },
                { label: 'slack:#deploys', kind: 'channel' },
              ]}
              live
            />
            <RouteLine
              nodes={[
                { label: 'slack:#ops', kind: 'channel' },
                { label: 'ci-bot', kind: 'agent' },
              ]}
              state="broken"
              reason="Token rejected (401)"
            />
            <RouteLine
              nodes={[
                { label: 'reviewer', kind: 'agent' },
                { label: '169.254.169.254', kind: 'channel' },
              ]}
              state="blocked"
              reason="Blocked by policy: cloud metadata"
            />
            <Button size="sm" onPress={() => setPulse((p) => p + 1)}>
              Send a pulse
            </Button>
          </div>
          <Row label="Badges">
            <Badge>this device</Badge>
            <Badge tone="flare">demo</Badge>
            <Badge tone="go">connected</Badge>
            <Badge tone="caution">learning</Badge>
            <Badge tone="stop">blocked</Badge>
            <RiskTag risk="LOW" />
            <RiskTag risk="ELEVATED" />
            <RiskTag risk="HIGH" />
            <span className="relative inline-flex">
              Inbox <CountBadge count={3} className="ml-1" />
            </span>
          </Row>
          <Row label="Sparkline">
            <Sparkline
              values={[0, 1, 0, 2, 1, 0, 0, 5, 1, 0, 0, 1, 3, 0, 0, 1, 0, 0, 2, 1, 0, 0, 1, 0]}
              spikeAt={4}
              label="Blocked hosts, last 24 hours: 19 events, peak 5"
            />
          </Row>
        </Section>

        <Section id="cards" title="Cards & transmission slips">
          <div className="grid max-w-[720px] grid-cols-1 gap-3 medium:grid-cols-2">
            <Card>
              <div className="flex items-center gap-3">
                <LetterTile code="CC" />
                <span className="flex-1 type-title-3">reviewer</span>
                <StatusDot state="live" />
              </div>
              <MetaLine className="mt-1" items={['claude 2.1.4', 'workspace', 'local']} />
            </Card>
            <Card tone="sunken">Sunken card · wells, tool output</Card>
          </div>
          <div className="flex max-w-[560px] flex-col gap-4">
            {slips.map((id) => (
              <SwipeAction
                key={id}
                aria-label={`Approval from reviewer: Run a shell command, git push origin beamhop/842, ${id === 'a41f' ? 'low' : 'high'} risk`}
                hint="Press A to allow once, D to deny."
                rightMode={id === 'a41f' ? 'commit' : 'intent'}
                onSwipeRight={() => {
                  if (id !== 'a41f') {
                    toast.show({ message: 'Scope sheet would open (HIGH risk)' });
                    return;
                  }
                  setSlips((s) => s.filter((x) => x !== id));
                  toast.show({
                    message: 'Allowed once · git push',
                    onUndo: () => setSlips((s) => [id, ...s]),
                  });
                }}
                onSwipeLeft={() => {
                  setSlips((s) => s.filter((x) => x !== id));
                  toast.show({ message: 'Denied · git push', onUndo: () => setSlips((s) => [id, ...s]) });
                }}
              >
                {({ commit, dragging }) => (
                  <TicketCard
                    state={dragging ? 'dragging' : 'resting'}
                    eyebrow={`Approval · #${id}`}
                    tag={<RiskTag risk={id === 'a41f' ? 'LOW' : 'HIGH'} />}
                    decision={
                      <div className="flex gap-2">
                        <Button variant="deny" onPress={() => commit('left')} className="flex-1">
                          Deny
                        </Button>
                        <Button variant="quiet">Details</Button>
                        <Button variant="allow" onPress={() => commit('right')} className="flex-1">
                          {id === 'a41f' ? 'Allow once' : 'Allow…'}
                        </Button>
                      </div>
                    }
                  >
                    <MetaLine items={['reviewer', 'tg:group/-100123', 'thread 842', 'from Alice (user)']} />
                    <h3 className="mt-3 type-title-3">Run a shell command</h3>
                    <code className="mt-2 block rounded-md bg-sunken px-3 py-2 type-code">
                      git push origin beamhop/842
                    </code>
                    <div className="mt-3">
                      <UntrustedQuote>pushing the fix so CI can run</UntrustedQuote>
                    </div>
                    <p className="mt-3 flex items-baseline gap-3 type-body-sm text-ink-2">
                      Auto-denies in <Readout size="md">12:40</Readout>
                    </p>
                  </TicketCard>
                )}
              </SwipeAction>
            ))}
            {slips.length === 0 && (
              <Button variant="secondary" onPress={() => setSlips(['a41f', 'b72c'])}>
                Reset slips
              </Button>
            )}
            <TicketCard
              state="expired"
              eyebrow="Approval · #9a31"
              tag={<RiskTag risk="LOW" />}
              statusLine="Auto-denied at 10:14 — the agent was told."
            >
              <h3 className="type-title-3">Write ~/notes/todo.md</h3>
            </TicketCard>
          </div>
        </Section>

        <Section id="inputs" title="Inputs">
          <div className="grid max-w-[720px] grid-cols-1 gap-5 medium:grid-cols-2">
            <TextField
              label="Agent name"
              defaultValue="reviewer"
              description="Lowercase letters, digits and dashes."
              mono
            />
            <TextField
              label="Profile name"
              isInvalid
              errorMessage="Use lowercase letters, digits and dashes."
              defaultValue="Reviewer Bot"
            />
            <SecretField
              label="Bot token"
              description="From @BotFather → /token."
              format={/^\d{6,12}:[A-Za-z0-9_-]{30,}$/}
              formatLabel="Looks like a bot token"
            />
            <SecretField label="Slack bot token" savedHint="xoxb-…a91f" />
            <SearchField label="Search sessions" />
            <NumberField
              label="Daily budget"
              unit="USD/day"
              value={budget}
              onChange={setBudget}
              minValue={0}
              step={0.5}
              formatOptions={{ style: 'currency', currency: 'USD' }}
            />
            <Select
              label="Harness"
              defaultSelectedKey="claude"
              options={[
                { id: 'claude', label: 'Claude Code 2.1.4', leading: <LetterTile code="CC" /> },
                { id: 'gemini', label: 'Gemini CLI 1.3.0', leading: <LetterTile code="GM" /> },
                {
                  id: 'codex',
                  label: 'Codex 0.9.1',
                  description: 'needs login',
                  leading: <LetterTile code="CX" />,
                  isDisabled: true,
                },
              ]}
            />
            <PathPicker label="Folder" value={path} onChange={setPath} description="Read-only by default." />
          </div>
          <div className="flex max-w-[480px] flex-col">
            <Switch defaultSelected description="Log blocked requests instead of failing silently.">
              Learning mode
            </Switch>
            <Switch>Answer unknown senders as viewer</Switch>
            <Checkbox defaultSelected>mention</Checkbox>
            <Checkbox>reply</Checkbox>
            <Checkbox isIndeterminate>All agents</Checkbox>
          </div>
          <Row label="Segmented">
            <SegmentedControl
              label="Mount mode"
              value={seg}
              onChange={setSeg}
              options={[
                { id: 'ro', label: 'Read-only' },
                { id: 'rw', label: 'Read-write' },
              ]}
            />
          </Row>
          <div className="grid max-w-[720px] grid-cols-1 gap-5 medium:grid-cols-2">
            <RadioGroup label="Allow git push?" defaultValue="once">
              <Radio value="once">Allow once</Radio>
              <Radio value="session" description="Until thread 842 ends">
                Allow for this session
              </Radio>
              <Radio value="always" description="Adds a policy rule">
                Always allow for user on reviewer
              </Radio>
            </RadioGroup>
            <RadioGroup label="Sandbox profile" variant="cards" defaultValue="workspace">
              <Radio value="strict" description="Read-only mounts · API hosts only">
                strict
              </Radio>
              <Radio value="workspace" description="Read/write mounts · package registries">
                workspace
              </Radio>
              <Radio value="custom" description="Your rules">
                custom
              </Radio>
            </RadioGroup>
          </div>
          <ChipInput
            label="Allowed hosts"
            items={[
              ...hosts.map((h) => ({ id: h, label: h, variant: 'allowed' as const })),
              { id: 'pypi', label: 'pypi.org', variant: 'suggested' as const, note: '14×' },
            ]}
            onRemove={(id) => setHosts((h) => h.filter((x) => x !== id))}
            onAdd={(v) => setHosts((h) => [...h, v])}
          />
          <ChipGroup
            label="Never"
            items={['~/.ssh', '~/.aws', '~/.config/gh', '169.254.169.254'].map((x) => ({
              id: x,
              label: x,
              variant: x.startsWith('169') ? ('blocked' as const) : ('locked' as const),
            }))}
          />
        </Section>

        <Section id="nav" title="Tabs & stepper">
          <Tabs
            label="Agent sections"
            tabs={['Overview', 'Setup', 'Sandbox', 'Channels', 'Schedules', 'Budgets', 'Identity'].map(
              (t) => ({ id: t, label: t, content: <p className="type-body-sm text-ink-2">{t} content</p> }),
            )}
          />
          <Stepper steps={['Create', 'Credentials', 'Validate', 'Connect', 'Pair', 'Join']} current={step} />
          <div className="flex gap-2">
            <Button size="sm" onPress={() => setStep((s) => Math.max(0, s - 1))}>
              Back
            </Button>
            <Button size="sm" onPress={() => setStep((s) => Math.min(5, s + 1))}>
              Next
            </Button>
          </div>
          <div className="max-w-[280px]">
            <Stepper
              orientation="vertical"
              steps={['Doctor', 'Harnesses', 'Identity', 'Phone', 'Agent', 'Hello']}
              current={3}
            />
          </div>
        </Section>

        <Section id="overlays" title="Sheets, dialogs, toasts">
          <Row>
            <Button onPress={() => setSheet(true)}>Open sheet</Button>
            <Button variant="destructive" onPress={() => setConfirm(true)}>
              Delete reviewer…
            </Button>
            <Button onPress={() => toast.show({ message: 'Copied to clipboard.' })}>Info toast</Button>
            <Button
              onPress={() =>
                toast.show({
                  message: 'Allowed once · git push',
                  onUndo: () => void toast.show({ message: 'Undone.' }),
                })
              }
            >
              Undo toast
            </Button>
            <Button
              onPress={() =>
                toast.show({ message: 'Slack is not responding. beamhop retries every 30 s.', tone: 'error' })
              }
            >
              Error toast
            </Button>
          </Row>
          <Sheet
            isOpen={sheet}
            onOpenChange={setSheet}
            title="Allow git push?"
            subtitle="reviewer · thread 842"
            footer={
              <Button variant="allow" fullWidth onPress={() => setSheet(false)}>
                Allow once
              </Button>
            }
          >
            <RadioGroup label="Scope" hideLabel defaultValue="once">
              <Radio value="once">Allow once</Radio>
              <Radio value="session">Allow for this session (thread 842)</Radio>
              <Radio value="always">Always allow for user on reviewer</Radio>
            </RadioGroup>
            <p className="mt-4 type-body-sm text-ink-2">Drag the grabber down, press Esc, or use Close.</p>
          </Sheet>
          <ConfirmDialog
            isOpen={confirm}
            onOpenChange={setConfirm}
            title="Delete reviewer?"
            confirmLabel="Delete reviewer"
            onConfirm={() => setConfirm(false)}
          >
            Its config and identity are removed from this daemon. Transcripts are kept until retention ends
            (30 days).
          </ConfirmDialog>
        </Section>

        <Section id="code" title="Code, diff, CLI, QR">
          <div className="flex max-w-[720px] flex-col gap-4">
            <CodeBlock
              label="Tool output · npm test"
              code={'✓ auth.test.ts (12)\n✓ url.test.ts (6)\n… 214 passing (41s)'}
              lineNumbers
            />
            <DiffView diff={DIFF} />
            <CliStrip command="beamhop channel add telegram --token-from-stdin" />
            <QrCode
              value="https://app.beamhop.dev/pair#kitchen-sink-demo"
              label="QR code to pair your phone"
            />
          </div>
        </Section>

        <Section id="charts" title="Charts">
          <div className="max-w-[720px]">
            <BarChart
              label="Spend per day, last 7 days, by agent"
              format={(n) => `$${n.toFixed(2)}`}
              series={[
                { id: 'reviewer', label: 'reviewer' },
                { id: 'ci-bot', label: 'ci-bot' },
                { id: 'helpdesk', label: 'helpdesk' },
              ]}
              data={['7 Nov', '8 Nov', '9 Nov', '10 Nov', '11 Nov', '12 Nov', '13 Nov'].map((d, i) => ({
                label: d,
                values: {
                  reviewer: [2.1, 3.4, 1.2, 0.6, 4.1, 2.8, 3.2][i]!,
                  'ci-bot': [0.8, 1.1, 0.4, 0.2, 1.4, 0.9, 1.1][i]!,
                  helpdesk: [0.3, 0.2, 0.5, 0.1, 0.7, 0.4, 0.6][i]!,
                },
              }))}
            />
          </div>
        </Section>

        <Section id="states" title="Empty, loading, error, banners">
          <EmptyState glyph={<SlipGlyph />} title="Inbox clear." cli="beamhop approvals">
            Nothing is waiting on you. New requests arrive here and as notifications.
          </EmptyState>
          <EmptyState
            glyph={<BeamGlyph />}
            title="No channels yet."
            action={<Button variant="primary">Add channel</Button>}
          >
            Connect Telegram, Slack or Discord so people can reach your agents there. Nostr DMs already work.
          </EmptyState>
          <div className="max-w-[560px]">
            <Skeleton variant="cards" count={1} />
          </div>
          <ErrorState
            title="Couldn't reach relay.damus.io"
            details={{ code: 'unavailable', relay: 'wss://relay.damus.io' }}
            onRetry={() => {}}
          >
            The relay closed the connection 3 times in 2 min. beamhop keeps retrying every 30 s.
          </ErrorState>
          <div className="-mx-4 flex flex-col">
            <Banner tone="caution">Offline. Showing what was cached at 10:31.</Banner>
            <Banner tone="stop" hatched icon={<Stop size={18} weight="fill" />}>
              Everything is stopped · since 10:42
            </Banner>
          </div>
        </Section>
      </div>
    </Screen>
  );
};
