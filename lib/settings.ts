import { DEFAULT_SETTINGS, type Settings } from './types';

const KEY = 'glpram:settings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.sync.set({ [KEY]: next });
  return next;
}

/** True if `url`'s hostname matches any entry in `list` (exact or subdomain). */
export function hostMatches(url: string | undefined, list: string[]): boolean {
  if (!url || !list.length) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return list.some((w) => {
    const entry = w.trim().toLowerCase().replace(/^\*\./, '');
    if (!entry) return false;
    return host === entry || host.endsWith('.' + entry);
  });
}

/** True if `url`'s hostname is whitelisted (never touched). */
export function isWhitelisted(url: string | undefined, whitelist: string[]): boolean {
  return hostMatches(url, whitelist);
}
