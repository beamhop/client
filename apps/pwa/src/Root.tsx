/**
 * Root route component: wires React Aria's router (so RAC <Link href> uses TanStack navigation),
 * toasts, the panic sheet and the shell.
 */
import { type NavigateOptions, type ToOptions, useRouter } from '@tanstack/react-router';
import { RouterProvider as AriaRouterProvider } from 'react-aria-components';
import { AppShell } from './shell/AppShell.tsx';
import { PanicProvider } from './shell/panic.tsx';
import { ToastProvider } from './ui/Toast.tsx';

declare module 'react-aria-components' {
  interface RouterConfig {
    href: string;
    routerOptions: Omit<NavigateOptions, keyof ToOptions>;
  }
}

/** A URL with its own scheme (https:, mailto:, nostr:…), not a path in this app. */
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

export const Root = () => {
  const router = useRouter();
  return (
    <AriaRouterProvider
      navigate={(href, opts) => router.navigate({ ...(opts ?? {}), href })}
      // External links (GitHub compare pages, docs, provider consoles) keep their own origin: the router
      // only knows in-app paths and would turn https://github.com/… into /…
      useHref={(href) => (EXTERNAL.test(href) ? href : router.buildLocation({ href } as never).href)}
    >
      <ToastProvider>
        <PanicProvider>
          <AppShell />
        </PanicProvider>
      </ToastProvider>
    </AriaRouterProvider>
  );
};
