import type { SessionView } from '@beamhop/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer, ProgressStrip } from './Composer.tsx';

const session = (status: SessionView['status'] = 'idle'): SessionView => ({
  id: `ses_${Math.random().toString(36).slice(2, 7)}`,
  agent: 'reviewer',
  channel: 'tg',
  conversationId: 'dm',
  threadId: '842',
  title: 't',
  status,
  startedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
});

const setup = (props: Partial<Parameters<typeof Composer>[0]> = {}) => {
  const onSend = vi.fn(async () => true);
  const onStop = vi.fn();
  const onSlash = vi.fn(() => true);
  render(
    <Composer
      session={session()}
      live={false}
      sending={false}
      stopping={false}
      onSend={onSend}
      onStop={onStop}
      onSlash={onSlash}
      {...props}
    />,
  );
  return { onSend, onStop, onSlash, box: screen.getByRole('textbox') };
};

describe('Composer', () => {
  it('sends on Enter, adds a line on Shift+Enter, and clears after sending', async () => {
    const { onSend, box } = setup();
    await userEvent.type(box, 'hello{Shift>}{Enter}{/Shift}world');
    expect(box).toHaveValue('hello\nworld');
    await userEvent.type(box, '{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello\nworld');
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps Stop one tap away while live and labels typing as steering', async () => {
    const { onStop, box } = setup({ live: true });
    await userEvent.click(screen.getByRole('button', { name: 'Stop reviewer' }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await userEvent.type(box, 'also check mobile');
    expect(screen.getByText(/Steer · queued as reviewer's next turn/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send steer message' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop reviewer' })).toBeVisible();
  });

  it('handles local slash commands without sending them', async () => {
    const { onSend, onSlash, box } = setup();
    await userEvent.type(box, '/st');
    expect(screen.getByRole('group', { name: 'Slash commands' })).toBeVisible();
    await userEvent.type(box, '{Tab}');
    expect(box).toHaveValue('/stop');
    await userEvent.type(box, '{Enter}');
    expect(onSlash).toHaveBeenCalledWith('/stop');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('passes harness slash commands through as text', async () => {
    const { onSend, box } = setup();
    await userEvent.type(box, '/model opus{Enter}');
    expect(onSend).toHaveBeenCalledWith('/model opus');
  });

  it('is disabled with a visible reason', () => {
    const { box } = setup({ disabledReason: 'Everything is stopped · resume first' });
    expect(box).toBeDisabled();
    expect(screen.getByText('Everything is stopped · resume first')).toBeVisible();
  });
});

describe('ProgressStrip', () => {
  it('shows the progress detail and a live clock', () => {
    const now = Date.now();
    render(
      <ProgressStrip
        agent="reviewer"
        now={now}
        activity={{
          kind: 'tool',
          label: 'Bash npm test',
          detail: 'running tests…',
          since: new Date(now - 42_000).toISOString(),
        }}
      />,
    );
    expect(screen.getByText('running tests…')).toBeVisible();
    expect(screen.getByText('0:42')).toBeVisible();
  });
});
