/** Ports of the real-backend e2e suite (distinct from `vite preview` on 4173 used by `e2e/`). */
export const DAEMON_PORT = Number(process.env.BH_E2E_PORT ?? 4600);
export const CONTROL_PORT = Number(process.env.BH_E2E_CONTROL_PORT ?? DAEMON_PORT + 1);
