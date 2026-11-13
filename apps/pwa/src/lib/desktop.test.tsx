import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CliStrip } from '../ui/CliStrip.tsx';
import {
  type BeamhopDesktop,
  isDesktop,
  SHOW_CLI_KEY,
  setShowCliPref,
  showCli,
  useShowCli,
} from './desktop.ts';

const fake = (): BeamhopDesktop => ({
  version: '0.1.0',
  platform: 'darwin',
  cli: {
    status: async () => ({ state: 'absent' }),
    install: async () => ({ status: { state: 'installed', path: '/usr/local/bin/beamhop', onPath: true } }),
    uninstall: async () => {},
  },
  daemon: { restart: async () => {}, openLog: async () => {} },
});

const Probe = () => <span data-testid="cli">{String(useShowCli())}</span>;

describe('desktop detection and useShowCli', () => {
  afterEach(() => {
    delete window.beamhopDesktop;
    localStorage.removeItem(SHOW_CLI_KEY);
  });

  it('in a browser: not desktop, command lines always shown', () => {
    expect(isDesktop()).toBe(false);
    setShowCliPref(false);
    expect(showCli()).toBe(true);
    render(<CliStrip command="beamhop doctor" />);
    expect(screen.getByText('CLI')).toBeInTheDocument();
  });

  it('in the desktop app: hidden by default, shown when the setting is on', () => {
    window.beamhopDesktop = fake();
    expect(isDesktop()).toBe(true);
    expect(showCli()).toBe(false);
    const { container } = render(
      <>
        <Probe />
        <CliStrip command="beamhop doctor" />
      </>,
    );
    expect(screen.getByTestId('cli')).toHaveTextContent('false');
    expect(container.textContent).not.toContain('beamhop doctor');
    act(() => setShowCliPref(true));
    expect(localStorage.getItem(SHOW_CLI_KEY)).toBe('1');
    expect(screen.getByTestId('cli')).toHaveTextContent('true');
    expect(screen.getByText('CLI')).toBeInTheDocument();
    act(() => setShowCliPref(false));
    expect(screen.getByTestId('cli')).toHaveTextContent('false');
  });
});
