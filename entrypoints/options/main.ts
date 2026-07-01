import { getSettings, saveSettings } from '@/lib/settings';
import type { Settings } from '@/lib/types';

const BOOLS = [
  'enabled',
  'deferLoad',
  'protectAudible',
  'protectMedia',
  'protectNotifications',
  'relayNotifications',
] as const;

const NUMS = ['keepLoaded'] as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

function flash(msg: string): void {
  status.textContent = msg;
  setTimeout(() => (status.textContent = ''), 1200);
}

const LISTS = ['whitelist', 'alwaysUnload'] as const;

async function render(): Promise<void> {
  const s = await getSettings();
  for (const k of BOOLS) ($(k) as HTMLInputElement).checked = s[k];
  for (const k of NUMS) ($(k) as HTMLInputElement).value = String(s[k]);
  for (const k of LISTS) ($(k) as HTMLTextAreaElement).value = s[k].join('\n');
}

async function save(): Promise<void> {
  const patch: Partial<Settings> = {};
  for (const k of BOOLS) patch[k] = ($(k) as HTMLInputElement).checked;
  for (const k of NUMS) {
    const v = Number(($(k) as HTMLInputElement).value);
    if (Number.isFinite(v) && v >= 1) patch[k] = Math.floor(v);
  }
  for (const k of LISTS) {
    patch[k] = ($(k) as HTMLTextAreaElement).value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  await saveSettings(patch);
  flash('Saved');
}

void render();
document.body.addEventListener('change', () => void save());
