import { getSettings, saveSettings } from '@/lib/settings';
import type { Settings } from '@/lib/types';

const BOOLS = [
  'enabled',
  'deferLoad',
  'protectAudible',
  'protectMedia',
  'protectNotifications',
  'relayNotifications',
  'oomEnabled',
] as const;

const NUMS = ['unloadDelayMin', 'minFreeMemoryMB', 'memoryLimitMB'] as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

function flash(msg: string): void {
  status.textContent = msg;
  setTimeout(() => (status.textContent = ''), 1200);
}

async function render(): Promise<void> {
  const s = await getSettings();
  for (const k of BOOLS) ($(k) as HTMLInputElement).checked = s[k];
  for (const k of NUMS) ($(k) as HTMLInputElement).value = String(s[k]);
  ($('whitelist') as HTMLTextAreaElement).value = s.whitelist.join('\n');
}

async function save(): Promise<void> {
  const patch: Partial<Settings> = {};
  for (const k of BOOLS) patch[k] = ($(k) as HTMLInputElement).checked;
  for (const k of NUMS) {
    const v = Number(($(k) as HTMLInputElement).value);
    if (Number.isFinite(v) && v >= 0) patch[k] = v;
  }
  patch.whitelist = ($('whitelist') as HTMLTextAreaElement).value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  await saveSettings(patch);
  flash('Saved');
}

void render();
document.body.addEventListener('change', () => void save());
