import '@fontsource-variable/instrument-sans/wdth.css'; // wght 400–700, wdth 75–100
import '@fontsource-variable/martian-mono/wdth.css'; // wght 100–800, wdth 75–112.5
import '@fontsource/doto/700.css'; // display numerals only
import './styles/app.css';

import { RpcError } from '@beamhop/client';
import { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BeamhopProvider, createRuntime, loadMock, resolveConnection } from './api/index.ts';
import { initAppearance, useAppearance } from './lib/appearance.ts';
// Side effect: captures beforeinstallprompt before any screen asks for it.
import './lib/install.ts';
import { createAppRouter } from './router.tsx';
import { LiveRegions } from './shell/AppShell.tsx';

initAppearance();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      // Daemon errors are answers, not glitches: only retry dropped connections.
      retry: (count, err) => count < 2 && (!(err instanceof RpcError) || err.code === -32000),
      refetchOnWindowFocus: true,
    },
  },
});

const connection = resolveConnection();
// The demo daemon (seed data + zod schemas) is its own chunk: real daemons never download it.
const mock = connection.kind === 'mock' ? await loadMock(connection) : undefined;
const runtime = createRuntime(connection, queryClient, undefined, mock ? { mock } : {});
const router = createAppRouter();

// Dev/e2e handle for poking the demo daemon from the console: `__beamhop.mock.daemon.state`.
(window as unknown as { __beamhop?: unknown }).__beamhop = { runtime, mock: runtime.mock, router };

const App = () => {
  const [, resolved] = useAppearance();
  return (
    <MotionConfig reducedMotion={resolved.motion === 'reduced' ? 'always' : 'user'}>
      <BeamhopProvider runtime={runtime}>
        <RouterProvider router={router} />
      </BeamhopProvider>
      <LiveRegions />
    </MotionConfig>
  );
};

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
