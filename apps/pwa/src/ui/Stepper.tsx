/**
 * Stepper rail (DESIGN §9.4): a beam line with numbered nodes. Done = ink filled + check,
 * current = flare, future = hollow. Horizontal (compact) or vertical (desktop wizards/onboarding).
 * Announces "Step 3 of 6: Identity" when the step changes.
 */
import { Check } from '@phosphor-icons/react';
import { Fragment, useEffect, useRef } from 'react';
import { cx } from '../lib/cx.ts';
import { announce } from '../lib/live.ts';

export interface StepperProps {
  steps: string[];
  /** 0-based current step. */
  current: number;
  orientation?: 'horizontal' | 'vertical';
  /** Show labels on horizontal (only the current label is shown by default). */
  showLabels?: boolean;
  className?: string;
  /** Make finished steps navigable. */
  onStepPress?: (index: number) => void;
}

export const Stepper = ({
  steps,
  current,
  orientation = 'horizontal',
  showLabels,
  className,
  onStepPress,
}: StepperProps) => {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    announce(`Step ${current + 1} of ${steps.length}: ${steps[current]}`);
  }, [current, steps]);

  const label = `Step ${current + 1} of ${steps.length}: ${steps[current]}`;
  const node = (i: number) => {
    const state = i < current ? 'done' : i === current ? 'current' : 'todo';
    const inner = (
      <span
        className={cx(
          'grid size-6 shrink-0 place-items-center rounded-full font-mono text-[10px] leading-none font-medium',
          state === 'done' && 'bg-ink text-bg',
          state === 'current' && 'bg-flare text-on-flare ring-4 ring-flare-wash',
          state === 'todo' && 'border-[1.5px] border-line-strong bg-bg text-ink-2',
        )}
      >
        {state === 'done' ? (
          <Check size={12} weight="bold" aria-hidden="true" />
        ) : (
          String(i + 1).padStart(2, '0')
        )}
      </span>
    );
    return state === 'done' && onStepPress ? (
      <button
        type="button"
        onClick={() => onStepPress(i)}
        aria-label={`Go back to step ${i + 1}: ${steps[i]}`}
        className="-m-2.5 grid size-11 place-items-center rounded-full"
      >
        {inner}
      </button>
    ) : (
      inner
    );
  };

  if (orientation === 'vertical') {
    return (
      <ol aria-label={label} className={cx('flex flex-col', className)}>
        {steps.map((s, i) => (
          <li key={s} aria-current={i === current ? 'step' : undefined} className="flex gap-3">
            <div className="flex flex-col items-center">
              {node(i)}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cx(
                    'my-1 w-px flex-1 min-h-6',
                    i < current ? 'bg-ink' : 'border-l border-dashed border-line-strong',
                  )}
                />
              )}
            </div>
            <div className={cx('pt-0.5 pb-5', i === current ? 'text-ink' : 'text-ink-2')}>
              <span className="type-micro">{String(i + 1).padStart(2, '0')}</span>{' '}
              <span className="type-label">{s}</span>
              <span className="sr-only">{i < current ? ' (done)' : i === current ? ' (current)' : ''}</span>
            </div>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className={className}>
      <ol aria-label={label} className="flex items-center">
        {steps.map((s, i) => (
          <Fragment key={s}>
            <li
              aria-current={i === current ? 'step' : undefined}
              className="flex shrink-0 flex-col items-center"
            >
              {node(i)}
              <span className="sr-only">
                {s}
                {i < current ? ' (done)' : i === current ? ' (current)' : ''}
              </span>
            </li>
            {i < steps.length - 1 && (
              <li
                aria-hidden="true"
                className={cx(
                  'mx-1 h-px flex-1',
                  i < current ? 'bg-ink' : 'border-t border-dashed border-line-strong',
                )}
              />
            )}
          </Fragment>
        ))}
      </ol>
      {showLabels ? (
        <div className="mt-2 flex justify-between type-micro text-ink-2" aria-hidden="true">
          {steps.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      ) : (
        <p className="mt-2 type-micro text-ink-2" aria-hidden="true">
          {steps[current]}
        </p>
      )}
    </div>
  );
};
