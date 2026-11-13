/**
 * Terraform-plan–style diff (JOURNEYS §7.6): symbol + colour + word on every row, grouped, each row
 * expandable for the full detail; a tick ruler; the estimated monthly cost. Also used (with `remove`
 * rows only) for the Destroy plan.
 */
import { CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { groupPlan, PLAN_SYMBOL, type PlanAction, type PlanTone, planCounts, planTone } from './model.ts';

const TONE_TEXT: Record<PlanTone, string> = {
  add: 'text-go-text',
  change: 'text-caution-text',
  move: 'text-ink-2',
  remove: 'text-stop-text',
  warn: 'text-caution-text',
};
const GROUP_LABEL: Record<PlanTone, string> = {
  add: t('deploy.plan.add'),
  change: t('deploy.plan.change'),
  move: t('deploy.plan.move'),
  remove: t('deploy.plan.remove'),
  warn: t('deploy.plan.warn'),
};

const PlanRow = ({ a }: { a: PlanAction }) => {
  const [open, setOpen] = useState(false);
  const tone = planTone(a.op);
  return (
    <li>
      <RACButton
        aria-expanded={open}
        onPress={() => setOpen((o) => !o)}
        className="grid min-h-11 w-full grid-cols-[1.25rem_4.5rem_minmax(0,1fr)_1rem] items-baseline gap-x-2 rounded-sm py-2 text-left outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
      >
        <span
          aria-hidden="true"
          className={cx('font-mono text-[15px] leading-5 font-semibold', TONE_TEXT[tone])}
        >
          {PLAN_SYMBOL[tone]}
        </span>
        <span className={cx('type-meta', TONE_TEXT[tone])}>{a.op}</span>
        <span className={cx('min-w-0 type-meta text-ink', !open && 'truncate')}>
          <span className="font-medium">{a.resource}</span>
          <span className="text-ink-2"> {a.detail}</span>
        </span>
        <CaretRight
          size={12}
          aria-hidden="true"
          className={cx(
            'self-center text-ink-3 transition-transform duration-[var(--dur-fast)]',
            open && 'rotate-90',
          )}
        />
      </RACButton>
    </li>
  );
};

export const PlanDiff = ({ actions, label = 'Plan' }: { actions: PlanAction[]; label?: string }) => {
  const counts = planCounts(actions);
  const summary = [
    counts.add && `${counts.add} to create`,
    counts.change && `${counts.change} to change`,
    counts.move && `${counts.move} to transfer`,
    counts.remove && `${counts.remove} to remove`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex flex-col gap-3" aria-label={label} role="group">
      <p className="type-meta text-ink-2">{summary}</p>
      {groupPlan(actions).map((g) => (
        <section
          key={g.tone}
          aria-label={t('deploy.plan.group', { group: GROUP_LABEL[g.tone], count: g.rows.length })}
        >
          <ul className="flex flex-col">
            {g.rows.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat; position is identity
              <PlanRow key={`${a.op}-${a.resource}-${i}`} a={a} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

/** Horizontal tick ruler (DESIGN §3.8) used as a section divider on Deploy. */
export const TickRuler = ({ className }: { className?: string }) => (
  <div
    aria-hidden="true"
    className={cx('h-2 border-b border-line-strong', className)}
    style={{
      backgroundImage: 'repeating-linear-gradient(90deg, var(--bh-line-strong) 0 1px, transparent 1px 8px)',
      backgroundSize: '100% 4px',
      backgroundPosition: 'bottom',
      backgroundRepeat: 'no-repeat',
    }}
  />
);
