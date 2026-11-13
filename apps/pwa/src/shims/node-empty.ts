/**
 * Browser stand-ins for the node built-ins that `@beamhop/core`'s paths.ts imports.
 * The PWA never calls these; they exist only so the bundle resolves.
 */
const unsupported = (name: string) => (): never => {
  throw new Error(`${name} is not available in the browser`);
};

export const homedir = unsupported('os.homedir');
export const join = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');
export const resolve = (...parts: string[]): string => join(...parts);
export const isAbsolute = (p: string): boolean => p.startsWith('/');
export default { homedir, join, resolve, isAbsolute };
