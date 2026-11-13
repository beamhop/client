/**
 * Imported first by main.ts: drop Node's "SQLite is an experimental feature" warning, which every
 * daemon start would otherwise print. Every other warning still reaches stderr.
 */
const listeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  for (const l of listeners) l(w);
});
