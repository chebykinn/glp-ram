// Single source of truth for "what will happen to this tab and when".
// Both the background scan and the dashboard import these so their decisions and
// their displayed countdowns can never drift apart.
import { isWhitelisted } from './settings';
import type { Settings, TabInfo } from './types';
import type { Tabs } from 'webextension-polyfill';

type Tab = Tabs.Tab;

/** Tabs with A/V (sound, playing/paused media, mic, camera, screen): never unload. */
export function isMediaProtected(tab: Tab, info: TabInfo, s: Settings): boolean {
  if (s.protectAudible && (tab.audible || info.hasPlayback)) return true;
  if (s.protectMedia && info.media) return true;
  return false;
}

/** Why a tab is exempt from pausing/unloading entirely (not just held loaded). */
export type SpareReason = 'active' | 'whitelist' | 'audible' | 'capture' | null;

export function spareReason(tab: Tab, info: TabInfo, s: Settings): SpareReason {
  if (tab.active) return 'active';
  if (isWhitelisted(tab.url, s.whitelist)) return 'whitelist';
  if (s.protectAudible && (tab.audible || info.hasPlayback)) return 'audible';
  if (s.protectMedia && info.media) return 'capture';
  return null;
}

export interface TabPolicy {
  /** Already unloaded / discarded. */
  discarded: boolean;
  /** Fully exempt from pause + unload, and why. */
  spared: SpareReason;
  /** Held loaded so non-push notifications keep firing. */
  notifHold: boolean;
  /** Protected from discard (idle + OOM) because it has unsaved text. */
  inputHold: boolean;
  /** Ms until the tab is unloaded, or null if it won't be. */
  msUntilUnload: number | null;
  /** Eligible to be killed by the OOM guard under memory pressure. */
  oomEligible: boolean;
}

export function analyze(tab: Tab, info: TabInfo, s: Settings, now: number): TabPolicy {
  const discarded = !!tab.discarded || info.state === 'unloaded';
  const spared = spareReason(tab, info, s);
  const notifHold = s.protectNotifications && info.notify && !info.push;
  // A tab with unsaved text is never discarded (idle or OOM) — losing it is bad.
  const inputHold = !!info.hasInput;
  const oomEligible =
    !discarded &&
    !tab.active &&
    !inputHold &&
    !isWhitelisted(tab.url, s.whitelist) &&
    !isMediaProtected(tab, info, s);

  // notifHold and inputHold tabs are never unloaded.
  let msUntilUnload: number | null = null;
  if (!discarded && !spared && !notifHold && !inputHold) {
    msUntilUnload = Math.max(0, s.unloadDelayMin * 60_000 - (now - info.lastActive));
  }

  return { discarded, spared, notifHold, inputHold, msUntilUnload, oomEligible };
}
