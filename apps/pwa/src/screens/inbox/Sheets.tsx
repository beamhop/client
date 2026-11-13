/**
 * Decision sheets, driven by `sheetStore` so a swipe, a button, a key or a toast action can open
 * them from the Inbox *or* Home:
 *  - Scope (JOURNEYS §2.4): Allow once / for this session / always for {role} on {agent}, with the
 *    exact policy line shown as a diff and host-vs-domain scope (Little Snitch). Button text tracks
 *    the choice. "Always" can only happen here — never from a gesture.
 *  - Access request: role picker (least privilege preselected), "Allow as viewer".
 *  - Reason (JOURNEYS §2.5): quick chips or free text sent back with the deny.
 *  - Help: keyboard shortcuts.
 */
import { Check } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { approvalTarget, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { Button } from '../../ui/Button.tsx';
import { Radio, RadioGroup, SegmentedControl } from '../../ui/Choice.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Kbd, MetaLine } from '../../ui/Meta.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { inputOf, quorumOf, ruleChoices, ruleLine, type SlipGroup, scopeOptions } from './model.ts';
import { QuorumRow } from './Slip.tsx';
import { mineStore, openSheet, sheetStore, useStore } from './store.ts';
import { useDecisions } from './useDecisions.tsx';

type Scope = 'once' | 'session' | 'always';

/** `git push`, `registry.npmjs.org`, `~/docs/…/api-keys.md` — short noun for the sheet title. */
export const shortTarget = (g: SlipGroup): string => {
  const i = inputOf(g.lead);
  if (i.command) return i.command.split(/\s+/).slice(0, 2).join(' ');
  if (i.host) return i.host;
  const v = approvalTarget(g.lead);
  return v.length > 32 ? `…${v.slice(-30)}` : v;
};

const ScopeSheet = ({
  group,
  onClose,
  onDone,
}: {
  group: SlipGroup;
  onClose: () => void;
  onDone?: () => void;
}) => {
  const { decide } = useDecisions();
  const mine = useStore(mineStore);
  const a = group.lead;
  const options = scopeOptions(a);
  const choices = ruleChoices(a);
  const [scope, setScope] = useState<Scope>(options.length === 1 ? 'once' : 'once');
  const [rule, setRule] = useState<'exact' | 'wide'>('exact');
  const [busy, setBusy] = useState(false);
  const chosen = choices.find((c) => c.id === rule) ?? choices[0];
  const quorum = quorumOf(a, mine);
  const thread = inputOf(a).thread;

  const label =
    scope === 'once'
      ? quorum
        ? t('inbox.btn.approve')
        : t('inbox.btn.allowOnce')
      : scope === 'session'
        ? t('inbox.scope.btnSession')
        : t('inbox.scope.btnAlways');

  const submit = async () => {
    setBusy(true);
    const ok = await decide(group, true, {
      always: scope === 'always',
      session: scope === 'session' || undefined,
      rule: scope === 'always' ? chosen?.value : undefined,
    });
    setBusy(false);
    if (ok) {
      onClose();
      onDone?.();
    }
  };

  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={t('inbox.scope.title', { target: shortTarget(group) })}
      subtitle={
        <MetaLine
          items={[
            a.agent,
            a.title.toLowerCase(),
            group.items.length > 1 ? `×${group.items.length}` : undefined,
          ]}
        />
      }
      footer={
        <div className="flex flex-col gap-2 expanded:flex-row-reverse">
          <Button
            variant="allow"
            size="lg"
            fullWidth
            isPending={busy}
            icon={<Check size={18} weight="bold" aria-hidden="true" />}
            onPress={() => void submit()}
          >
            {label}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={onClose}>
            {t('inbox.btn.cancel')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {quorum && (
          <div className="flex flex-col gap-2 rounded-md bg-sunken p-3">
            <p className="type-body-sm text-ink">
              {t('inbox.scope.quorum', { needed: quorum.needed, agent: a.agent })}
            </p>
            <QuorumRow q={quorum} />
          </div>
        )}
        {options.length > 1 ? (
          <RadioGroup
            label={t('inbox.scope.label')}
            hideLabel
            value={scope}
            onChange={(v) => setScope(v as Scope)}
          >
            <Radio value="once" description={t('inbox.scope.onceHint')}>
              {t('inbox.scope.once')}
            </Radio>
            <Radio value="session" description={t('inbox.scope.sessionHint')}>
              {thread ? t('inbox.scope.sessionThread', { thread }) : t('inbox.scope.session')}
            </Radio>
            <Radio value="always" description={t('inbox.scope.alwaysHint')}>
              {t('inbox.scope.always', { role: a.requestedBy.role, agent: a.agent })}
            </Radio>
          </RadioGroup>
        ) : (
          !quorum && <p className="type-body text-ink-2">{t('inbox.scope.onlyOnce')}</p>
        )}
        {scope === 'always' && chosen && (
          <div className="flex flex-col gap-3 pl-9">
            {choices.length > 1 && (
              <SegmentedControl
                label={t('inbox.scope.ruleScope')}
                value={rule}
                onChange={setRule}
                options={choices.map((c) => ({
                  id: c.id,
                  label: <span className="font-mono text-[13px]">{c.label}</span>,
                }))}
                className="max-w-full self-start"
              />
            )}
            <div>
              <p className="mb-1 type-micro text-ink-2">{t('inbox.scope.ruleAdds')}</p>
              <code className="block rounded-md bg-go-wash px-3 py-2 type-code break-all text-go-text">
                {ruleLine(a, chosen.value)}
              </code>
            </div>
            {rule === 'wide' && <p className="type-body-sm text-caution-text">{t('inbox.scope.wideWarn')}</p>}
          </div>
        )}
      </div>
    </Sheet>
  );
};

const AccessSheet = ({
  approval,
  onClose,
  onDone,
}: {
  approval: SlipGroup['lead'];
  onClose: () => void;
  onDone?: () => void;
}) => {
  const { decide } = useDecisions();
  const roles = useApi('role.list');
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const who = approval.requestedBy.displayName ?? approval.requestedBy.principal;
  const offered = (roles.data?.roles ?? []).filter((r) => r.name !== 'owner' && r.name !== 'agent');
  const list = offered.length > 0 ? offered : [{ name: 'viewer', description: 'Read-only Q&A.' }];
  // Least privilege first.
  const order = ['viewer', 'user', 'admin'];
  const sorted = [...list].sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));

  const submit = async () => {
    setBusy(true);
    const ok = await decide({ key: approval.id, lead: approval, items: [approval] }, true, {
      grantRole: role,
    });
    setBusy(false);
    if (ok) {
      onClose();
      onDone?.();
    }
  };
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={t('inbox.access.sheetTitle', { who, agent: approval.agent })}
      subtitle={<MetaLine items={[{ value: approval.requestedBy.principal, truncate: 28 }]} />}
      footer={
        <div className="flex flex-col gap-2 expanded:flex-row-reverse">
          <Button variant="allow" size="lg" fullWidth isPending={busy} onPress={() => void submit()}>
            {t('inbox.access.allowAs', { role })}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={onClose}>
            {t('inbox.btn.cancel')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body text-ink-2">{t('inbox.access.body', { agent: approval.agent })}</p>
        <RadioGroup label={t('inbox.access.role')} value={role} onChange={setRole} variant="cards">
          {sorted.map((r) => (
            <Radio key={r.name} value={r.name} description={r.description}>
              {r.name}
              {r.name === 'viewer' && (
                <span className="ml-2 type-meta text-ink-2">{t('inbox.access.least')}</span>
              )}
            </Radio>
          ))}
        </RadioGroup>
      </div>
    </Sheet>
  );
};

const REASONS = ['inbox.reason.notNow', 'inbox.reason.readOnly', 'inbox.reason.askThread'] as const;

const ReasonSheet = ({ ids, target, onClose }: { ids: string[]; target: string; onClose: () => void }) => {
  const { denyWithReason } = useDecisions();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (reason: string) => {
    if (!reason.trim()) return;
    setBusy(true);
    await denyWithReason(ids, target, reason.trim());
    setBusy(false);
    onClose();
  };
  return (
    <Sheet
      isOpen
      onOpenChange={(o) => !o && onClose()}
      title={t('inbox.reason.title')}
      subtitle={<MetaLine items={[{ value: target, truncate: 40 }]} />}
      footer={
        <div className="flex flex-col gap-2 expanded:flex-row-reverse">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            isPending={busy}
            isDisabled={!text.trim()}
            onPress={() => void send(text)}
          >
            {t('inbox.reason.send')}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={onClose}>
            {t('inbox.reason.skip')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body-sm text-ink-2">{t('inbox.reason.body')}</p>
        <ul className="flex flex-wrap gap-2" aria-label={t('inbox.reason.quick')}>
          {REASONS.map((k) => (
            <li key={k}>
              <Button variant="secondary" size="sm" onPress={() => void send(t(k))}>
                {t(k)}
              </Button>
            </li>
          ))}
        </ul>
        <TextField label={t('inbox.reason.own')} value={text} onChange={setText} multiline rows={2} />
      </div>
    </Sheet>
  );
};

export const SHORTCUTS: Array<[string, string]> = [
  ['J / K', 'inbox.keys.move'],
  ['A', 'inbox.keys.allow'],
  ['⇧A', 'inbox.keys.scope'],
  ['D', 'inbox.keys.deny'],
  ['↵', 'inbox.keys.details'],
  ['U / Z', 'inbox.keys.undo'],
  ['R', 'inbox.keys.reason'],
  ['X', 'inbox.keys.select'],
  ['?', 'inbox.keys.help'],
];

const HelpSheet = ({ onClose }: { onClose: () => void }) => (
  <Sheet isOpen onOpenChange={(o) => !o && onClose()} title={t('inbox.keys.title')}>
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5">
      {SHORTCUTS.map(([k, label]) => (
        <div key={k} className="contents">
          <dt className="flex gap-1">
            {k.split(' / ').map((x) => (
              <Kbd key={x}>{x}</Kbd>
            ))}
          </dt>
          <dd className="type-body-sm text-ink">{t(label as Parameters<typeof t>[0])}</dd>
        </div>
      ))}
    </dl>
  </Sheet>
);

/** Renders whichever decision sheet is open. Mount once per screen that can decide (Inbox, Home). */
export const DecisionLayer = () => {
  const s = useStore(sheetStore);
  const close = () => openSheet(null);
  // Close sheets when the layer unmounts (navigating away).
  useEffect(() => () => openSheet(null), []);
  if (!s) return null;
  switch (s.type) {
    case 'scope':
      return <ScopeSheet key={s.group.key} group={s.group} onClose={close} onDone={s.onDone} />;
    case 'access':
      return <AccessSheet key={s.approval.id} approval={s.approval} onClose={close} onDone={s.onDone} />;
    case 'reason':
      return <ReasonSheet ids={s.ids} target={s.target} onClose={close} />;
    case 'help':
      return <HelpSheet onClose={close} />;
  }
};
