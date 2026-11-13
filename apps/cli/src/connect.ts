import { readFile } from 'node:fs/promises';
import { type BeamhopClient, createClient, httpTransport } from '@beamhop/client';
import { paths } from '@beamhop/core';

/** Resolve the local daemon URL + token: env overrides, else ~/.beamhop/api-token and default port. */
export const resolveLocal = async (env: Record<string, string | undefined> = process.env) => {
  const p = paths();
  const url = env.BEAMHOP_URL ?? `http://127.0.0.1:${env.BEAMHOP_PORT ?? '7878'}`;
  let token = env.BEAMHOP_TOKEN;
  if (!token) {
    try {
      token = (await readFile(p.token, 'utf8')).trim();
    } catch {
      throw new Error(`no API token found at ${p.token}. Is the daemon initialised? Run: beamhop daemon`);
    }
  }
  return { url, token };
};

export const connectLocal = async (): Promise<BeamhopClient> => {
  const { url, token } = await resolveLocal();
  return createClient(httpTransport(url, token));
};
