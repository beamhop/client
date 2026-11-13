/** Navigation policy for the app window: the daemon's own pages stay in the app, the rest opens outside. */

/** Same origin as the daemon URL (scheme, host and port). */
export const isAppUrl = (url: string, daemonUrl: string): boolean => {
  try {
    return new URL(url).origin === new URL(daemonUrl).origin;
  } catch {
    return false;
  }
};

const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/** Links that may be handed to the system browser / mail app. Everything else (file:, custom schemes) is dropped. */
export const isSafeExternalUrl = (url: string): boolean => {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** Permissions the web UI may use, and only from the daemon origin. */
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'clipboard-sanitized-write',
  // Camera, for scanning a pairing QR code.
  'media',
]);

export const isAllowedPermission = (permission: string, requestingUrl: string, daemonUrl: string): boolean =>
  ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, daemonUrl);
