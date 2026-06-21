import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a real (happy-dom) `window`, `document`, `localStorage`, etc. as
 * globals. This is a real DOM implementation — not a mock — so component and
 * storage-backed code runs against genuine browser APIs.
 *
 * This MUST run before `@testing-library/dom` is imported anywhere: its `screen`
 * helper binds to `document.body` at module-eval time and throws if `document`
 * is not yet global. Hence it lives in its own preload file, ordered ahead of
 * `test/teardown.ts` in `bunfig.toml`.
 */
GlobalRegistrator.register();
