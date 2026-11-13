/**
 * Root route component: wires React Aria's router (so RAC <Link href> uses TanStack navigation),
 * toasts, the panic sheet and the shell.
 */
import { type NavigateOptions, type ToOptions, useRouter } from '@tanstack/react-router';
import { RouterProvider as AriaRouterProvider } from 'react-aria-components';
import { PanicProvider } from './shell/panic.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { ToastProvider } from './ui/Toast.tsx';

declare module 'react-aria-components' {
  interface RouterConfig {
    href: string;
    routerOptions: Omit<NavigateOptions, keyof ToOptions>;
  }
}

export const Root = () => {
  const router = useRouter();
  return (
    <AriaRouterProvider
      navigate={(href, opts) => router.navigate({ ...(opts ?? {}), href })}
      useHref={(href) => router.buildLocation({ href } as never).href}
    >
      <ToastProvider>
        <PanicProvider>
          <AppShell />
        </PanicProvider>
      </ToastProvider>
    </AriaRouterProvider>
  );
};
