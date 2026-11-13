import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { __resetHaptics, haptic } from '../lib/haptics.ts';
import { Button } from './Button.tsx';
import { parseHostInput } from './Chip.tsx';
import { Select } from './Choice.tsx';
import { parseDiff } from './CodeBlock.tsx';
import { Sheet } from './Sheet.tsx';
import { LAMP_WORD, SegmentedMeter, StatusDot } from './Status.tsx';
import { SwipeAction } from './SwipeAction.tsx';
import { ToastProvider, useToast } from './Toast.tsx';

describe('StatusDot', () => {
  it('always exposes the state word to assistive tech, even when visually hidden', () => {
    for (const state of Object.keys(LAMP_WORD) as Array<keyof typeof LAMP_WORD>) {
      const { unmount } = render(<StatusDot state={state} hideLabel />);
      expect(screen.getByText(LAMP_WORD[state])).toHaveClass('sr-only');
      unmount();
    }
  });

  it('renders a custom label and keeps the lamp glyph decorative', () => {
    const { container } = render(<StatusDot state="needs-you" label="learning" />);
    expect(screen.getByText('learning')).toBeVisible();
    expect(container.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  });
});

describe('SegmentedMeter', () => {
  it('is a meter with a spoken value', () => {
    render(
      <SegmentedMeter
        name="reviewer budget"
        value={3.2}
        max={5}
        label="$3.20 / $5.00 today"
        valueText="$3.20 of $5.00 used today"
      />,
    );
    const m = screen.getByRole('meter', { name: 'reviewer budget' });
    expect(m).toHaveAttribute('aria-valuetext', '$3.20 of $5.00 used today');
    expect(m).toHaveAttribute('aria-valuemax', '5');
  });
});

const Slip = ({ onRight, onLeft }: { onRight: () => void; onLeft: () => void }) => (
  <SwipeAction
    aria-label="Approval from reviewer: git push"
    hint="Press A to allow once, D to deny."
    onSwipeRight={onRight}
    onSwipeLeft={onLeft}
  >
    {({ commit }) => (
      <div>
        <p>git push origin beamhop/842</p>
        <Button onPress={() => commit('left')}>Deny</Button>
        <Button onPress={() => commit('right')}>Allow once</Button>
      </div>
    )}
  </SwipeAction>
);

describe('SwipeAction', () => {
  it('offers keyboard alternatives (A / D) on the focused card', async () => {
    // Reduced motion → commits synchronously (no fly-out animation in jsdom).
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as never;
    const onRight = vi.fn();
    const onLeft = vi.fn();
    render(<Slip onRight={onRight} onLeft={onLeft} />);
    const group = screen.getByRole('group', { name: 'Approval from reviewer: git push' });
    expect(group).toHaveAttribute('tabindex', '0');
    expect(group).toHaveAccessibleDescription('Press A to allow once, D to deny.');
    group.focus();
    fireEvent.keyDown(group, { key: 'a' });
    expect(onRight).toHaveBeenCalledTimes(1);
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('always-visible buttons trigger the same commit (WCAG 2.5.1 / 2.5.7)', async () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as never;
    const onRight = vi.fn();
    const onLeft = vi.fn();
    const user = userEvent.setup();
    render(<Slip onRight={onRight} onLeft={onLeft} />);
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it('ignores shortcut keys typed into inputs', () => {
    const onRight = vi.fn();
    render(
      <SwipeAction aria-label="slip" onSwipeRight={onRight}>
        {() => <input aria-label="reason" />}
      </SwipeAction>,
    );
    fireEvent.keyDown(screen.getByLabelText('reason'), { key: 'a' });
    expect(onRight).not.toHaveBeenCalled();
  });
});

const SheetHarness = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Sheet
        isOpen={open}
        onOpenChange={setOpen}
        title="Allow git push?"
        footer={<button type="button">Allow once</button>}
      >
        <input aria-label="note" />
      </Sheet>
    </>
  );
};

describe('Sheet', () => {
  it('moves focus inside, traps Tab, and closes with Escape and the Close button', async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allow git push?' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

const ToastHarness = ({ onUndo }: { onUndo: () => void }) => {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show({ message: 'Allowed once · git push', onUndo })}>
      Decide
    </button>
  );
};

describe('Toast', () => {
  it('shows one undo toast, runs undo, never steals focus', async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastHarness onUndo={onUndo} />
      </ToastProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Decide' });
    await user.click(trigger);
    await user.click(trigger); // newest replaces the previous one (which fades out in 120 ms)
    await waitFor(() => expect(screen.getAllByText('Allowed once · git push')).toHaveLength(1));
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('auto-dismisses undo toasts after 5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(
      <ToastProvider>
        <ToastHarness onUndo={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    expect(screen.getByText('Allowed once · git push')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(5200);
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  });
});

describe('helpers', () => {
  it('parses host input: host, wildcard, URL, garbage', () => {
    expect(parseHostInput('github.com')).toEqual({ value: 'github.com' });
    expect(parseHostInput('*.npmjs.org')).toEqual({ value: '*.npmjs.org' });
    expect(parseHostInput('https://github.com/acme/app')).toMatchObject({ value: 'github.com' });
    expect(parseHostInput('htp:/x')).toHaveProperty('error');
  });

  it('parses unified diffs with counts and line numbers', () => {
    const files = parseDiff(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new',
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'a.ts', added: 1, removed: 1 });
  });

  it('throttles haptics to one per 120 ms', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    __resetHaptics();
    expect(haptic('tick')).toBe(true);
    expect(haptic('tick')).toBe(false);
    expect(vibrate).toHaveBeenCalledWith(8);
  });
});

describe('Select (compact: list in a bottom sheet)', () => {
  const options = [
    { id: 'claude', label: 'Claude Code 2.1.4' },
    { id: 'gemini', label: 'Gemini CLI 1.3.0' },
  ];
  const Controlled = () => {
    const [v, setV] = useState<string>('claude');
    return (
      <Select label="Harness" options={options} selectedKey={v} onSelectionChange={(k) => setV(String(k))} />
    );
  };

  it('shows the selected value on the trigger while the sheet is closed, and after picking', async () => {
    render(<Controlled />);
    const trigger = screen.getByRole('button', { name: /Harness/ });
    expect(trigger).toHaveTextContent('Claude Code 2.1.4');
    await userEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Harness' });
    await userEvent.click(within(sheet).getByRole('option', { name: 'Gemini CLI 1.3.0' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /Harness/ })).toHaveTextContent('Gemini CLI 1.3.0');
  });
});
