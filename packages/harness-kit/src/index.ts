export * from './fakebin.ts';
export * from './jsonl.ts';
export * from './jsonrpc.ts';
export * from './mounts.ts';
export * from './permissions.ts';
export * from './queue.ts';
export * from './sandbox.ts';
export * from './spawn.ts';

/** Shorten a string for event payloads / error messages. */
export const truncate = (s: string, max = 2000): string => (s.length > max ? `${s.slice(0, max)}…` : s);
