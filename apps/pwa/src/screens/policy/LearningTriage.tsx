/**
 * Learning-mode triage (JOURNEYS §5 "Learning mode"): aggregated suggestions as transmission slips in the
 * same swipe component as the Inbox (right = allow, left = keep blocked; buttons always visible, keys A/D).
 * Host suggestions offer an explicit scope choice (exact host vs wildcard — never wildcard by default);
 * credential files suggest the secret broker instead; locked paths are "Blocked by design" with no allow.
 * Decisions are staged into the draft and applied with the rest on Save.
 */
import type { PolicySuggestion } from '@beamhop/core';
import { ArrowCounterClockwise, Check, Key, LockSimple, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { t } from '../../i18n/index.ts';
import { ago } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { TicketCard } from '../../ui/Card.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { Badge } from '../../ui/Meta.tsx';
import { SwipeAction } from '../../ui/SwipeAction.tsx';
import { classify, hostScopes } from './model.ts';
import { Mono } from './parts.tsx';

export interface Decision {
  accept: boolean;
  value: string;
  /** Kept blocked because the broker should provide it. */
  broker?: boolean;
}

const KIND_VERB: Record<PolicySuggestion['kind'], 'reach' | 'read' | 'write'> = {
  'net.allow': 'reach',
  'fs.read': 'read',
  'fs.write': 'write',
};

const SuggestionSlip = ({
  agent,
  s,
  onDecide,
  onBroker,
  now,
}: {
  agent: string;
  s: PolicySuggestion;
  onDecide: (d: Decision) => void;
  onBroker: () => void;
  now: number;
}) => {
  const cls = classify(s);
  const scopes = cls === 'host' ? hostScopes(s.value) : [s.value];
  const [scope, setScope] = useState(scopes[0]!);
  const locked = cls === 'locked';
  const verb = KIND_VERB[s.kind];
  const title = t(`policy.learn.tried.${verb}`, { agent, count: s.count });
  const allow = () => {
    haptic('confirm');
    onDecide({ accept: true, value: scope });
  };
  const keep = () => {
    haptic('reject');
    onDecide({ accept: false, value: s.value });
  };
  return (
    <li>
      <SwipeAction
        aria-label={t('policy.learn.slipLabel', { agent, value: s.value, count: s.count })}
        hint={locked ? undefined : t('policy.learn.slipHint')}
        disabled={locked}
        onSwipeRight={locked ? undefined : allow}
        onSwipeLeft={keep}
        rightStamp={t('policy.learn.stampAllow')}
        leftStamp={t('policy.learn.stampKeep')}
      >
        {({ commit }) => (
          <TicketCard
            eyebrow={s.kind === 'net.allow' ? t('policy.learn.eyebrowHost') : t('policy.learn.eyebrowPath')}
            tag={
              locked ? (
                <Badge tone="outline">
                  <LockSimple size={12} weight="bold" aria-hidden="true" /> {t('policy.learn.byDesign')}
                </Badge>
              ) : cls === 'credential' ? (
                <Badge tone="caution">{t('policy.learn.credential')}</Badge>
              ) : undefined
            }
            statusLine={undefined}
            decision={
              locked ? (
                <div className="flex items-center justify-between gap-2 pl-1">
                  <p className="type-body-sm text-ink-2">{t('policy.learn.lockedNote')}</p>
                  <Button variant="secondary" size="sm" onPress={() => commit('left')}>
                    {t('policy.learn.dismiss')}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {cls === 'credential' && (
                    <Button
                      variant="quiet"
                      size="sm"
                      className="mr-auto"
                      icon={<Key size={16} aria-hidden="true" />}
                      onPress={() => {
                        onDecide({ accept: false, value: s.value, broker: true });
                        onBroker();
                      }}
                    >
                      {t('policy.learn.useBroker')}
                    </Button>
                  )}
                  <Button
                    variant="deny"
                    size="sm"
                    icon={<X size={16} weight="bold" aria-hidden="true" />}
                    onPress={() => commit('left')}
                    aria-label={t('policy.learn.keepAria', { value: s.value })}
                  >
                    {t('policy.learn.keep')}
                  </Button>
                  <Button
                    variant="allow"
                    size="sm"
                    icon={<Check size={16} weight="bold" aria-hidden="true" />}
                    onPress={() => commit('right')}
                    aria-label={t('policy.learn.allowAria', { value: scope })}
                  >
                    {verb === 'reach' ? t('policy.learn.allow') : t('policy.learn.allowRead')}
                  </Button>
                </div>
              )
            }
          >
            <p className="type-body text-ink">
              {title.split('{value}')[0]}
              <Mono className="font-semibold">{s.value}</Mono>
              {title.split('{value}')[1]}
            </p>
            <p className="mt-1 type-meta text-ink-2">
              {t('policy.learn.last', { when: ago(s.lastSeenAt, now) })}
            </p>
            {scopes.length > 1 && (
              <div className="mt-3 flex flex-col gap-1.5">
                <span className="type-meta text-ink-2">{t('policy.learn.scope')}</span>
                <SegmentedControl
                  label={t('policy.learn.scopeLabel', { value: s.value })}
                  size="sm"
                  value={scope}
                  onChange={setScope}
                  className="self-start"
                  options={scopes.map((x) => ({
                    id: x,
                    label: <span className="font-mono text-[12px]">{x}</span>,
                  }))}
                />
                {scope.startsWith('*.') && (
                  <p className="type-body-sm text-caution-text">
                    {t('policy.learn.wildWarn', { apex: scope.slice(2) })}
                  </p>
                )}
              </div>
            )}
          </TicketCard>
        )}
      </SwipeAction>
    </li>
  );
};

export const LearningTriage = ({
  agent,
  pending,
  decided,
  onDecide,
  onUndo,
  onBroker,
  now,
}: {
  agent: string;
  pending: PolicySuggestion[];
  decided: Array<{ s: PolicySuggestion; d: Decision }>;
  onDecide: (s: PolicySuggestion, d: Decision) => void;
  onUndo: (s: PolicySuggestion) => void;
  onBroker: () => void;
  now: number;
}) => (
  <div className="flex flex-col gap-3">
    {pending.length > 0 ? (
      <ul className="flex flex-col gap-3" aria-label={t('policy.learn.listLabel')}>
        {pending.map((s) => (
          <SuggestionSlip
            key={s.id}
            agent={agent}
            s={s}
            now={now}
            onDecide={(d) => onDecide(s, d)}
            onBroker={onBroker}
          />
        ))}
      </ul>
    ) : (
      <p className="type-body-sm text-ink-2">{t('policy.learn.empty')}</p>
    )}
    {decided.length > 0 && (
      <div>
        <h3 className="type-micro text-ink-2">{t('policy.learn.decided', { count: decided.length })}</h3>
        <ul className="mt-1 flex flex-col">
          {decided.map(({ s, d }) => (
            <li key={s.id} className="flex min-h-12 items-center gap-2 border-b border-line last:border-b-0">
              {d.accept ? (
                <Check size={16} weight="bold" aria-hidden="true" className="shrink-0 text-go-text" />
              ) : (
                <X size={16} weight="bold" aria-hidden="true" className="shrink-0 text-stop-text" />
              )}
              <span className="min-w-0 flex-1 type-body-sm text-ink">
                <Mono>{d.value}</Mono>{' '}
                <span className="text-ink-2">
                  {d.accept
                    ? t('policy.learn.willAllow')
                    : d.broker
                      ? t('policy.learn.willBroker')
                      : t('policy.learn.willKeep')}
                </span>
              </span>
              <Button
                variant="quiet"
                size="sm"
                icon={<ArrowCounterClockwise size={16} aria-hidden="true" />}
                onPress={() => onUndo(s)}
                aria-label={t('policy.learn.undoAria', { value: d.value })}
              >
                {t('common.undo')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    )}
  </div>
);
