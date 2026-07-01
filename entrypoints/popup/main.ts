import { getSettings, saveSettings } from '@/lib/settings';
import { hasSystemMemoryApi, getSystemMemory } from '@/lib/memory';
import type { TabInfo } from '@/lib/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB'
    : Math.round(bytes / 1024 / 1024) + ' MB';
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

async function refresh(): Promise<void> {
  const [settings, allTabs, stateStore] = await Promise.all([
    getSettings(),
    browser.tabs.query({}),
    browser.storage.session.get('glpram:tabs'),
  ]);

  ($('enabled') as HTMLInputElement).checked = settings.enabled;

  const states = (stateStore['glpram:tabs'] as Record<number, TabInfo> | undefined) || {};
  const managed = allTabs.filter((t) => /^https?:\/\//i.test(t.url || ''));
  let suspended = 0;
  let unloaded = 0;
  for (const t of managed) {
    const st = t.id != null ? states[t.id]?.state : undefined;
    if (t.discarded || st === 'unloaded') unloaded++;
    else if (st === 'suspended') suspended++;
  }

  $('tabCount').textContent = String(managed.length);
  $('stateCount').textContent = `${suspended} / ${unloaded}`;

  if (hasSystemMemoryApi()) {
    const sys = await getSystemMemory();
    $('mem').textContent = sys
      ? `${mb(sys.availableCapacity)} free · keep ${settings.keepLoaded}`
      : `keep ${settings.keepLoaded}`;
  } else {
    $('mem').textContent = `keep ${settings.keepLoaded}`;
  }

  const [cur] = await browser.tabs.query({ active: true, currentWindow: true });
  const curHost = hostOf(cur?.url);
  const curState = cur?.id != null ? states[cur.id]?.state : undefined;
  $('curTag').textContent = cur?.discarded ? 'unloaded' : curState || (curHost ? 'active' : '—');

  const whitelistBtn = $('whitelist') as HTMLButtonElement;
  if (curHost && settings.whitelist.some((w) => w === curHost)) {
    whitelistBtn.textContent = `${curHost} is protected`;
    whitelistBtn.disabled = true;
  } else if (curHost) {
    whitelistBtn.textContent = `Never touch ${curHost}`;
    whitelistBtn.disabled = false;
  } else {
    whitelistBtn.disabled = true;
  }
}

$('enabled').addEventListener('change', async (e) => {
  await saveSettings({ enabled: (e.target as HTMLInputElement).checked });
});

$('whitelist').addEventListener('click', async () => {
  const [cur] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(cur?.url);
  if (!host) return;
  const s = await getSettings();
  if (!s.whitelist.includes(host)) await saveSettings({ whitelist: [...s.whitelist, host] });
  await refresh();
});

$('killTab').addEventListener('click', async () => {
  const [cur] = await browser.tabs.query({ active: true, currentWindow: true });
  if (cur?.id != null) {
    try {
      await browser.tabs.discard(cur.id);
    } catch {
      /* non-discardable */
    }
  }
  await refresh();
});

$('dashboard').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
  window.close();
});

$('options').addEventListener('click', () => browser.runtime.openOptionsPage());

void refresh();
