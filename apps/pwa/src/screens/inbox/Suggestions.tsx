/**
 * Learning-mode suggestions as triage cards (JOURNEYS §5 Learning mode 2–4): same slip component,
 * swipe right = allow, left = keep blocked, buttons always visible. Host vs `*.domain` is an explicit
 * segmented choice (never an accidental wildcard). Locked paths are listed as "Blocked by design"
 * with no allow button; credential files point to the secret broker instead.
 */
import type { PolicySuggestion } from '@beamhop/core';
import { Check, LockSimple, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { t } from '../../i18n/index.ts';
import { ago } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { TicketCard } from '../../ui/Card.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { Badge, MetaLine } from '../../ui/Meta.tsx';
import { SwipeAction } from '../../ui/SwipeAction.tsx';
import { isCredentialFile, isLockedPath, suggestionChoices, suggestionVerb } from './model.ts';
import { useDecisions } from './useDecisions.tsx';

export const SuggestionCard = ({ s }: { s: PolicySuggestion }) => {
  const { decideSuggestion } = useDecisions();
  const choices = suggestionChoices(s);
  const [scope, setScope] = useState<'exact' | 'wide'>('exact');
  const value = (choices.find((c) => c.id === scope) ?? choices[0])?.value ?? s.value;
  const locked = isLockedPath(s.value);
  const credential = !locked && isCredentialFile(s.value);
  const verb = suggestionVerb(s);
  const spoken = t('inbox.learning.spoken', { agent: s.agent, verb, value: s.value, count: s.count });

  const card = (commit?: (d: 'left' | 'right') => void, dragging?: boolean) => (
    <TicketCard
      compact
      state={locked ? 'expired' : dragging ? 'dragging' : 'resting'}
      eyebrow={t('inbox.learning.eyebrow', { agent: s.agent })}
      tag={<Badge tone="caution">{t('inbox.learning.tag')}</Badge>}
      statusLine={
        locked ? (
          <span className="flex items-center gap-2">
            <LockSimple size={16} aria-hidden="true" />
            {t('inbox.learning.locked')}
          </span>
        ) : undefined
      }
      decision={
        <div className="flex gap-2">
          <Button
            variant="deny"
            size="sm"
            className="flex-1"
            icon={<X size={14} weight="bold" aria-hidden="true" />}
            onPress={() => commit?.('left')}
            aria-label={`${t('inbox.learning.keep')}: ${s.value}`}
          >
            {t('inbox.learning.keep')}
          </Button>
          <Button
            variant="allow"
            size="sm"
            className="flex-1"
            icon={<Check size={14} weight="bold" aria-hidden="true" />}
            onPress={() => commit?.('right')}
            aria-label={`${t(`inbox.learning.allow.${verb}` as 'inbox.learning.allow.reach')}: ${value}`}
          >
            {t(`inbox.learning.allow.${verb}` as 'inbox.learning.allow.reach')}
          </Button>
        </div>
      }
    >
      <p className="type-body text-ink">
        {t('inbox.learning.tried', { agent: s.agent, verb })}{' '}
        <span className="font-mono text-[0.9em] [overflow-wrap:anywhere]">{s.value}</span>{' '}
        {t('inbox.learning.times', { count: s.count })}
      </p>
      <MetaLine className="mt-1" items={[s.kind, t('inbox.learning.last', { when: ago(s.lastSeenAt) })]} />
      {credential && <p className="mt-2 type-body-sm text-caution-text">{t('inbox.learning.broker')}</p>}
      {!locked && choices.length > 1 && (
        <SegmentedControl
          size="sm"
          className="mt-3 w-full"
          label={t('inbox.scope.ruleScope')}
          value={scope}
          onChange={setScope}
          options={choices.map((c) => ({
            id: c.id,
            label: <span className="font-mono text-[12px]">{c.label}</span>,
          }))}
        />
      )}
    </TicketCard>
  );

  if (locked)
    return (
      <div aria-label={spoken} role="group">
        {card()}
      </div>
    );
  return (
    <SwipeAction
      aria-label={spoken}
      hint={t('inbox.learning.hint')}
      rightStamp={t('inbox.stamp.allow')}
      leftStamp={t('inbox.stamp.keep')}
      keys={{}}
      onSwipeRight={() => decideSuggestion(s, true, value)}
      onSwipeLeft={() => decideSuggestion(s, false)}
    >
      {({ commit, dragging }) => card(commit, dragging)}
    </SwipeAction>
  );
};
